/**
 * NÚCLEO OS — core/disc.js
 * Fontes de disco para o emulador de PS2.
 *
 * O adaptador do Play! (`emulator/adapter.js`, herdado do launcher) só exige uma
 * coisa do hospedeiro: `{ size, read(offset, length) -> Uint8Array }`. Este módulo
 * produz essa interface a partir de dois lugares — o arquivo que o usuário escolhe
 * no computador dele e um arquivo que já esteja no disco do PC virtual (VMFS) — e
 * identifica o disco antes de qualquer boot.
 *
 * Por que identificar antes: "VM inicializada" não significa "jogo carregou". Se o
 * arquivo não é uma ISO9660, o núcleo falha de um jeito obscuro minutos depois; a
 * verificação do descritor primário (setor 16, assinatura `CD001`) transforma isso
 * em uma frase clara antes de qualquer thread ser criada. Mesma checagem que o
 * launcher faz (`index.html`, leitor de disco local).
 *
 * Nada aqui toca a rede, e nada carrega a ISO inteira em memória: leitura por
 * faixa, sempre — uma ISO de PS2 tem de 1 a 8 GB.
 */

/** Setor lógico de 2048 bytes (ISO9660 modo 1). */
export const SETOR = 2048;
/** Setor 16 = descritor primário de volume. */
export const OFFSET_PVD = 16 * SETOR;
/** Teto de uma leitura — o mesmo do emulador (o hospedeiro já divide em 1 MiB). */
export const MAX_LEITURA = 1 << 20;
/** Assinatura padrão ISO9660, logo depois do byte de tipo. */
export const ASSINATURA = 'CD001';

function validarFaixa(offset, length, size, maxLeitura) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`leitura com offset inválido (${offset})`);
  if (!Number.isSafeInteger(length) || length <= 0) throw new Error(`leitura com tamanho inválido (${length})`);
  if (length > maxLeitura) throw new Error(`leitura de ${length} bytes acima do teto de ${maxLeitura}`);
  if (offset + length > size) throw new Error(`leitura fora do disco: ${offset}+${length} > ${size}`);
}

/** Contador honesto de I/O do disco, para a janela mostrar número medido. */
function criarContador() {
  let leituras = 0, bytes = 0;
  return {
    contar(n) { leituras++; bytes += n; },
    get stats() { return { leituras, bytes }; }
  };
}

/**
 * Disco a partir de um arquivo do computador do usuário (`File`/`Blob`).
 * Leitura por `slice` — nenhuma cópia para o disco virtual, nada em memória.
 */
export function criarDiscoDeArquivo(arquivo, { maxLeitura = MAX_LEITURA } = {}) {
  if (!arquivo || !Number.isSafeInteger(arquivo.size) || arquivo.size <= 0) {
    throw new Error('arquivo de disco inválido (sem tamanho legível)');
  }
  const contador = criarContador();
  const size = arquivo.size;
  return {
    origem: 'arquivo',
    nome: arquivo.name || 'disco.iso',
    size,
    get stats() { return contador.stats; },
    async read(offset, length) {
      validarFaixa(offset, length, size, maxLeitura);
      const bytes = new Uint8Array(await arquivo.slice(offset, offset + length).arrayBuffer());
      if (bytes.byteLength !== length) throw new Error(`leitura curta: pediu ${length}, veio ${bytes.byteLength}`);
      contador.contar(length);
      return bytes;
    }
  };
}

/**
 * Disco a partir de um arquivo do VMFS (o disco do PC virtual).
 *
 * Abre e fecha a sessão a cada faixa, de propósito: o worker `w-io` atende UMA
 * sessão por vez, então segurar a sessão durante o jogo travaria o terminal e o
 * gerenciador de arquivos. O custo é uma abertura por faixa (o emulador já lê em
 * blocos de 1 MiB), e a alternativa — travar o resto do sistema operacional — não
 * é aceitável.
 */
export function criarDiscoDeVfs({ vfs, caminho, tamanho, maxLeitura = MAX_LEITURA }) {
  if (!vfs || !caminho) throw new Error('disco do VMFS sem VFS/caminho');
  const size = Number.isSafeInteger(tamanho) && tamanho > 0 ? tamanho : 0;
  if (!size) throw new Error(`${caminho}: tamanho desconhecido — não dá para montar um disco sem tamanho`);
  const contador = criarContador();
  return {
    origem: 'vmfs',
    nome: caminho,
    size,
    get stats() { return contador.stats; },
    async read(offset, length) {
      validarFaixa(offset, length, size, maxLeitura);
      const bytes = await vfs.readRange(caminho, offset, length);
      if (bytes.byteLength !== length) throw new Error(`leitura curta em ${caminho}: pediu ${length}, veio ${bytes.byteLength}`);
      contador.contar(length);
      return bytes;
    }
  };
}

/**
 * Lê exatamente `length` bytes a partir de `offset`, em pedaços de no máximo
 * `passo` — usado pela identificação e por qualquer leitura avulsa.
 */
export async function lerFaixa(disco, offset, length, passo = MAX_LEITURA) {
  const out = new Uint8Array(length);
  for (let lido = 0; lido < length; lido += passo) {
    const n = Math.min(passo, length - lido);
    const bytes = await disco.read(offset + lido, n);
    out.set(bytes, lido);
  }
  return out;
}

/**
 * Identifica o disco pelo descritor primário de volume (ISO9660).
 * @returns {Promise<{tipo: string, rotulo: string, setor: number}>}
 */
export async function identificarDisco(disco) {
  if (!disco || !Number.isSafeInteger(disco.size) || disco.size < OFFSET_PVD + SETOR) {
    throw new Error(`arquivo pequeno demais para ser uma ISO de PS2 (${disco?.size ?? '?'} bytes)`);
  }
  const pvd = await lerFaixa(disco, OFFSET_PVD, SETOR);
  const assinatura = String.fromCharCode(pvd[1], pvd[2], pvd[3], pvd[4], pvd[5]);
  if (pvd[0] !== 1 || assinatura !== ASSINATURA) {
    throw new Error(`não é uma ISO9660 (descritor primário ausente: tipo ${pvd[0]}, assinatura "${assinatura}")`);
  }
  const bruto = pvd.subarray(40, 72);
  let fim = bruto.length;
  while (fim > 0 && (bruto[fim - 1] === 0x20 || bruto[fim - 1] === 0)) fim--;
  const rotulo = new TextDecoder('latin1').decode(bruto.subarray(0, fim)).trim();
  const blocos = new DataView(pvd.buffer, pvd.byteOffset).getUint32(80, true);
  return {
    tipo: 'ISO9660',
    rotulo: rotulo || '(sem rótulo)',
    setor: blocos
  };
}
