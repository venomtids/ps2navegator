/**
 * NÚCLEO OS — apps/jogos.js
 * Janela "Jogos" — roda discos de PS2 dentro do PC virtual.
 *
 * O emulador NÃO é reimplementado aqui: o NÚCLEO OS usa o núcleo **Play!** que já
 * está versionado na raiz deste repositório (`emulator/`), servido por
 * `/emulator/*` (ver `server.js`), com o mesmo adaptador que a página do launcher
 * usa. Uma fonte de verdade para um binário de 2,4 MB, um `provenance.json`, e uma
 * verificação de SHA256 a cada boot do servidor.
 *
 * O que esta janela acrescenta é o que o PC virtual tem de diferente: o disco pode
 * estar **dentro do PC** (VMFS) e o leitor de setores lê por faixa, sem carregar a
 * ISO na memória.
 *
 * Honestidade do portão (o ponto central do arquivo): Play! compila com pthreads e
 * portanto exige `SharedArrayBuffer`, que só existe em página `crossOriginIsolated`
 * (COOP+COEP). Em iframe de terceiro — o caso do preview do Arena — não há
 * isolamento, e emulador de PS2 **não roda**. Nada de fingir: a janela explica o
 * motivo exato, diz como resolver (abrir em aba própria) e não tenta iniciar. O
 * resto do sistema continua funcionando degradado, como está documentado.
 */

import { el, fmtBytes, fmtInt, fmt1 } from '../core/util.js';
import { criarDiscoDeArquivo, criarDiscoDeVfs, identificarDisco } from '../core/disc.js';

/** Caminhos varridos ao procurar ISOs já instaladas no PC virtual. */
export const DIRETORIOS_ISO = ['/home/nucleo/Jogos', '/home/nucleo/Downloads', '/home/nucleo'];
/** Extensões consideradas disco de PS2 (a verificação real é o descritor ISO9660). */
export const EXTENSOES_ISO = ['.iso', '.img', '.bin'];

/**
 * Decide se dá para emular, e por quê. Pura e exportada: o teste verifica cada
 * motivo sem precisar de navegador.
 *
 * @param {{isolated: boolean, sab: boolean, webgl2: boolean, emIframe: boolean}} cap
 * @returns {{pronto: boolean, motivo: string, comoResolver: string}}
 */
export function avaliarAmbiente(cap = {}) {
  const { isolated = false, sab = false, webgl2 = false, emIframe = false } = cap;
  if (!sab) {
    return {
      pronto: false,
      motivo: 'SharedArrayBuffer indisponível nesta página',
      comoResolver: 'O núcleo Play! usa threads Wasm (pthreads), que dependem de SharedArrayBuffer. '
        + 'Abra o NÚCLEO OS por `npm start` (http://localhost:3400) ou por HTTPS com COOP/COEP.'
    };
  }
  if (!isolated) {
    return {
      pronto: false,
      motivo: 'página sem isolamento de origem cruzada (crossOriginIsolated = false)',
      comoResolver: emIframe
        ? 'Este preview roda dentro de um iframe de terceiro, e iframe assim não concede isolamento de origem — '
          + 'sem ele o navegador se recusa a criar threads Wasm, que é o que o núcleo do PS2 usa. '
          + 'Para emular: rode o NÚCLEO OS na sua máquina (`npm start`) e acesse http://localhost:3400 em uma aba '
          + 'própria. Todo o resto do sistema continua funcionando normalmente aqui dentro.'
        : 'Sirva a página com COOP/COEP (`npm start` no NÚCLEO OS) e abra por http://localhost:3400 — por '
          + '`file://` não há como obter isolamento.'
    };
  }
  if (!webgl2) {
    return {
      pronto: false,
      motivo: 'WebGL2 indisponível',
      comoResolver: 'O núcleo do emulador desenha em WebGL2. Verifique a aceleração de hardware do navegador.'
    };
  }
  return { pronto: true, motivo: '', comoResolver: '' };
}

/**
 * @param {object} opts
 * @param {object} opts.vfs      VMFS do PC virtual
 * @param {object} opts.os       barramento do sistema (capabilities, toasts)
 * @param {object} opts.toast
 */
export function createJogos({ vfs, os, toast }) {
  const cap = os?.capabilities || {};
  const ambiente = avaliarAmbiente({
    isolated: Boolean(cap.isolated),
    sab: Boolean(cap.sab),
    // O teste de WebGL2 acontece no boot (js/boot.js); aqui só consumimos.
    webgl2: cap.webgl2 !== false,
    emIframe: typeof window !== 'undefined' && window.top !== window
  });

  let emu = null;              // instância do adaptador (Play!)
  let disco = null;            // { origem, nome, size, read, stats }
  let info = null;             // { tipo, rotulo, setor }
  let pronto = false;          // ISO identificada e pronta para iniciar
  let parando = false;
  let fps = NaN;
  let status = 'escolha um disco para começar';
  let ultimoErro = '';
  let leituraMs = NaN;

  // ------------------------------------------------------------------ DOM -----
  const statusLinha = el('div', { class: 'meta' });
  const faixa = el('div', { class: 'alert' });
  const palco = el('div', { class: 'stage' });
  const tela = el('canvas', { class: 'screen' });
  palco.append(tela);

  const entrada = el('input', { type: 'file', accept: '.iso,.img,.bin', style: { display: 'none' } });
  const listaVmfs = el('select', { class: 'pick', 'aria-label': 'ISOs instaladas no PC virtual' });
  const bEscolher = el('button', { class: 'btn sm', type: 'button' }, 'Escolher ISO do computador');
  const bMontar = el('button', { class: 'btn sm', type: 'button' }, 'Montar do PC virtual');
  const bIniciar = el('button', { class: 'btn sm', type: 'button', disabled: true }, 'Iniciar');
  const bParar = el('button', { class: 'btn sm', type: 'button', disabled: true }, 'Parar');
  const bCheio = el('button', { class: 'btn sm', type: 'button', disabled: true }, 'Tela cheia');

  const barra = el('div', { class: 'bar' }, bEscolher, listaVmfs, bMontar, bIniciar, bParar, bCheio);
  const cartao = el('div', { class: 'card' });
  const wrap = el('div', { class: 'jogos' }, barra, palco, statusLinha, faixa, entrada);
  palco.append(cartao);

  function mostrarCartao(titulo, corpo) {
    cartao.replaceChildren(
      el('div', { class: 'ct' }, titulo),
      el('div', { class: 'cb' }, corpo)
    );
    cartao.classList.add('on');
  }
  function esconderCartao() { cartao.classList.remove('on'); }

  function falha(titulo, texto) {
    ultimoErro = texto;
    mostrarCartao(titulo, texto);
    toast?.err?.(titulo, texto);
    atualizarStatus();
  }

  function atualizarStatus() {
    const partes = ['PS2 · Play!'];
    if (disco) {
      partes.push(`${disco.nome} · ${fmtBytes(disco.size, 1)}`);
      if (info) partes.push(`${info.tipo} · rótulo "${info.rotulo}" · ${fmtInt(info.setor)} setores`);
      partes.push(`origem ${disco.origem === 'vmfs' ? 'PC virtual' : 'computador'}`);
      const s = disco.stats;
      partes.push(`${fmtInt(s.leituras)} leituras · ${fmtBytes(s.bytes, 1)}`);
      if (Number.isFinite(leituraMs)) partes.push(`última ${fmt1(leituraMs)} ms`);
    }
    if (emu && Number.isFinite(fps)) partes.push(`${fmtInt(fps)} fps`);
    partes.push(ambiente.pronto ? status : 'emulação indisponível neste contexto');
    if (ultimoErro && !cartao.classList.contains('on')) partes.push('erro declarado');
    statusLinha.textContent = partes.join(' · ');
  }

  // ------------------------------------------------------------ ambiente ------
  if (!ambiente.pronto) {
    mostrarCartao(`Emulação de PS2 indisponível: ${ambiente.motivo}`, ambiente.comoResolver);
    barra.querySelectorAll('button').forEach(b => { b.disabled = true; });
    listaVmfs.disabled = true;
    status = ambiente.motivo;
  }

  // -------------------------------------------------------- fontes de disco ---
  async function varrerIsos() {
    const opcoes = [el('option', { value: '' }, 'ISOs no PC virtual…')];
    if (!vfs) { listaVmfs.replaceChildren(...opcoes); return; }
    for (const dir of DIRETORIOS_ISO) {
      try {
        const linhas = await vfs.refresh(dir);
        for (const linha of linhas) {
          if (linha.type === 'dir') continue;
          const baixo = String(linha.name).toLowerCase();
          if (!EXTENSOES_ISO.some(ext => baixo.endsWith(ext))) continue;
          const caminho = `${dir === '/' ? '' : dir}/${linha.name}`;
          opcoes.push(el('option', { value: caminho }, `${caminho} (${fmtBytes(linha.size, 1)})`));
        }
      } catch { /* diretório ausente não é erro: o PC virtual é do usuário */ }
    }
    if (opcoes.length === 1) {
      opcoes.push(el('option', { value: '', disabled: true }, 'nenhuma ISO instalada — arraste uma para o desktop'));
    }
    listaVmfs.replaceChildren(...opcoes);
  }

  /**
   * Instrumenta o leitor para a linha de estado mostrar o tempo REAL de cada
   * faixa lida (número medido, não estimado) — é o gargalo do emulador quando o
   * disco está no OPFS.
   */
  function cronometrar(d) {
    const ler = d.read.bind(d);
    d.read = async (offset, length) => {
      const t = performance.now();
      try { return await ler(offset, length); }
      finally { leituraMs = performance.now() - t; }
    };
    return d;
  }

  /** Monta um disco a partir de uma origem e identifica. Nunca inventa sucesso. */
  async function montar(novo, etiqueta) {
    if (emu) await parar();
    disco = cronometrar(novo); info = null; pronto = false; ultimoErro = ''; leituraMs = NaN;
    bIniciar.disabled = true;
    status = `verificando ${etiqueta}…`;
    esconderCartao();
    atualizarStatus();
    try {
      info = await identificarDisco(disco);
      pronto = true;
      bIniciar.disabled = false;
      status = 'disco pronto — clique Iniciar';
    } catch (e) {
      pronto = false;
      bIniciar.disabled = true;
      status = 'disco recusado';
      falha('Disco recusado', `${String(e?.message || e)}. Nada foi iniciado: o emulador só recebe disco que passou na verificação.`);
    }
    atualizarStatus();
  }

  // ----------------------------------------------------------- emulador -------
  async function iniciar() {
    if (!ambiente.pronto) { falha('Emulação indisponível', ambiente.comoResolver); return; }
    if (!disco || !pronto) return;
    bIniciar.disabled = true;
    bParar.disabled = false;
    bCheio.disabled = false;
    status = 'carregando o núcleo Play!…';
    atualizarStatus();
    esconderCartao();
    try {
      // Mesmo adaptador que a página do launcher usa — nenhuma cópia divergente.
      const { createPS2 } = await import('/emulator/adapter.js');
      emu = await createPS2({
        canvas: tela,
        disc: disco,
        onStatus: texto => {
          status = String(texto).slice(0, 200);
          atualizarStatus();
        },
        onFPS: valor => { fps = Number(valor); atualizarStatus(); },
        onError: erro => {
          falha('Falha no núcleo', String(erro?.message || erro));
          emu = null;
          bIniciar.disabled = false;
          bParar.disabled = true;
          bCheio.disabled = true;
        }
      });
      await emu.start();
      status = 'núcleo inicializado — boot do disco em andamento';
      palco.querySelector('iframe')?.focus();
    } catch (e) {
      emu = null;
      bIniciar.disabled = false;
      bParar.disabled = true;
      falha('Não foi possível iniciar', String(e?.message || e));
    }
    atualizarStatus();
  }

  async function parar() {
    if (!emu || parando) return;
    parando = true;
    status = 'encerrando núcleo, threads e áudio…';
    atualizarStatus();
    try { await emu.stop(); } catch { /* encerrar já é o objetivo */ }
    emu = null;
    parando = false;
    fps = NaN;
    bIniciar.disabled = !pronto;
    bParar.disabled = true;
    bCheio.disabled = true;
    status = pronto ? 'núcleo encerrado — o disco continua montado' : 'núcleo encerrado';
    atualizarStatus();
  }

  // ------------------------------------------------------------ interação -----
  bEscolher.addEventListener('click', () => entrada.click());
  entrada.addEventListener('change', async () => {
    const arquivo = entrada.files?.[0];
    if (!arquivo) return;
    try {
      await montar(criarDiscoDeArquivo(arquivo), arquivo.name);
    } catch (e) { falha('Arquivo inválido', String(e?.message || e)); }
    entrada.value = '';
  });

  bMontar.addEventListener('click', async () => {
    const caminho = listaVmfs.value;
    if (!caminho) { toast?.warn?.('Nenhuma ISO no PC virtual', 'Arraste um arquivo .iso para o desktop: ele cai em ~/Downloads e aparece aqui.'); return; }
    try {
      const st = await vfs.stat(caminho);
      await montar(criarDiscoDeVfs({ vfs, caminho, tamanho: st.size }), caminho);
    } catch (e) { falha('Disco do PC virtual', String(e?.message || e)); }
  });

  bIniciar.addEventListener('click', iniciar);
  bParar.addEventListener('click', parar);
  bCheio.addEventListener('click', async () => {
    try { await (palco.requestFullscreen?.({ navigationUI: 'hide' }) ?? Promise.reject(new Error('tela cheia indisponível'))); }
    catch (e) { toast?.warn?.('Tela cheia', String(e?.message || e)); }
  });

  varrerIsos().catch(() => {});
  atualizarStatus();

  return {
    el: wrap,
    onResize() { /* o palco é flex: o encaixe é do CSS, não do JS */ },
    async onClose() {
      // Fechar a janela libera VM, contexto WebGL, pthreads e áudio do emulador.
      if (emu) await parar();
    },
    get emulador() { return emu; },
    get disco() { return disco; },
    get ambiente() { return ambiente; },
    get stats() { return { fps, status, pronto, disco: disco?.nome || '', origem: disco?.origem || '', erro: ultimoErro }; }
  };
}
