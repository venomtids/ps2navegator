/**
 * NÚCLEO OS — core/import.js
 * Instalação de arquivos no disco virtual: o caminho para trazer dados do
 * computador real para dentro do PC do navegador.
 *
 * O que "instalar" significa aqui, sem eufemismo: copiar bytes do seu disco para
 * o disco virtual (VFS/OPFS). Nada de rede, nada de upload, nada de `apt` — o
 * runtime Linux de verdade é a fase F4 (docs/00 §6.1); hoje quem recebe os
 * arquivos é o VMFS, e o sistema diz isso na interface.
 *
 * Este módulo é puro de propósito (sem DOM, sem worker): recebe uma lista de
 * objetos com `name` e `arrayBuffer()` — exatamente o que `File` oferece — e
 * grava via o contrato do VFS. Assim o caminho crítico é testável sem navegador.
 *
 * Garantias:
 *  - nome nunca escapa do diretório de destino (sanitizeName);
 *  - colisão não sobrescreve silenciosamente: renomeia com sufixo (1), (2)…
 *  - cota do navegador é checada ANTES de escrever (e nunca estimada);
 *  - falha de um arquivo não derruba os outros: cada item tem seu resultado;
 *  - progresso é reportado por arquivo, com bytes reais, para a UI medir.
 */

import { safePath, baseName, fmtBytes } from './util.js';

/** Onde os arquivos caem quando o usuário não escolhe outro lugar. */
export const INSTALL_DIR = '/home/nucleo/Downloads';

/** Limite de segurança do nome: sistemas de arquivos reais param bem antes disto. */
const MAX_NAME = 120;

/**
 * Normaliza o nome vindo de fora. Um `File.name` do navegador já vem sem
 * caminho, mas um `webkitRelativePath` ou um drop de pasta pode trazer barras —
 * e "nome de arquivo" nunca deve virar "caminho".
 */
export function sanitizeName(raw) {
  const base = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')      // caracteres de controle fora
    .trim()
    .replace(/^(?:\.{1,2}[\\/])+/, '')          // "./", "../", "…/" iniciais não têm sentido aqui
    .replace(/[\\/]+/g, '-')                    // o resto dos separadores vira hífen, não diretório
    .replace(/^\.+/, '')                        // nada de ".", ".." ou ponto inicial acidental
    .slice(0, MAX_NAME);
  if (!base) throw new Error('nome de arquivo inválido');
  return base;
}

/** Separa "nome" e "extensão" para gerar sufixo de cópia sem quebrar a extensão. */
function splitName(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ''];
}

/** Primeiro nome livre no diretório, no estilo dos navegadores: "x (1).txt". */
async function freeName(vfs, dir, name) {
  const exists = async p => {
    try { await vfs.stat(p); return true; } catch { return false; }
  };
  if (!await exists(`${dir}/${name}`)) return { name, renamed: false };
  const [stem, ext] = splitName(name);
  for (let n = 1; n < 1000; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!await exists(`${dir}/${candidate}`)) return { name: candidate, renamed: true };
  }
  throw new Error('não há nome livre para este arquivo');
}

/**
 * Instala arquivos no VFS.
 *
 * @param {object} vfs                      contrato de core/vfs.js ou vfs-local.js
 * @param {Iterable} items                  objetos com `name` e `arrayBuffer()`
 * @param {object} [opts]
 * @param {string} [opts.dir]               diretório de destino (padrão: ~/Downloads)
 * @param {boolean} [opts.overwrite]        true sobrescreve; false renomeia a cópia
 * @param {number} [opts.quotaMb]           cota do navegador, se conhecida (NaN = N/D)
 * @param {number} [opts.usedMb]            uso atual, se conhecido
 * @param {(p:{name:string,size:number,done:number}) => void} [opts.onProgress]
 * @returns {Promise<{dir:string, ok:Array, failed:Array, bytes:number, ms:number}>}
 */
export async function installFiles(vfs, items, {
  dir = INSTALL_DIR,
  overwrite = false,
  quotaMb = NaN,
  usedMb = NaN,
  onProgress = null
} = {}) {
  const t0 = performance.now();
  const dest = safePath(dir, '/');
  const result = { dir: dest, ok: [], failed: [], bytes: 0, ms: 0 };

  // O diretório de destino é criado sob demanda; "já existe" não é erro.
  try { await vfs.mkdir(dest); } catch { /* existe ou o VFS já o criou junto com o pai */ }

  for (const item of items || []) {
    const rawName = item?.name ?? '';
    let name;
    try { name = sanitizeName(rawName); }
    catch (e) { result.failed.push({ name: String(rawName), error: e.message }); continue; }

    try {
      if (typeof item.arrayBuffer !== 'function') throw new Error('item sem arrayBuffer()');
      const bytes = new Uint8Array(await item.arrayBuffer());

      // Cota: quando o navegador informa, respeitamos com margem — e dizemos o
      // número real. Quando não informa, não inventamos limite nenhum.
      if (Number.isFinite(quotaMb) && Number.isFinite(usedMb)) {
        // Tudo em bytes: misturar MB (cota) com bytes (arquivo) foi um bug real,
        // encontrado pelo teste de cota antes de chegar ao navegador.
        const usedBytes = usedMb * 1048576;
        const projected = (usedBytes + result.bytes + bytes.length) / 1048576;
        if (projected > quotaMb * 0.95) {
          throw new Error(`cota do navegador insuficiente: ${fmtBytes(bytes.length)} não caberia em ${fmtBytes(quotaMb * 1048576)} (uso ${fmtBytes(usedMb * 1048576)})`);
        }
      }

      let target = `${dest}/${name}`;
      let renamed = false;
      if (!overwrite) {
        const free = await freeName(vfs, dest, name);
        target = `${dest}/${free.name}`;
        renamed = free.renamed;
      }

      await vfs.write(target, bytes);
      result.ok.push({ name: baseName(target), path: target, size: bytes.length, renamed });
      result.bytes += bytes.length;
      onProgress?.({ name: baseName(target), size: bytes.length, done: result.bytes });
    } catch (e) {
      result.failed.push({ name, error: String(e.message || e) });
    }
  }

  result.ms = performance.now() - t0;
  return result;
}

/** Resumo em uma linha, para toast e terminal usarem o mesmo texto. */
export function describeInstall(result) {
  if (!result) return 'nada para instalar';
  const partes = [];
  if (result.ok.length) {
    partes.push(`${result.ok.length} arquivo${result.ok.length > 1 ? 's' : ''} em ${result.dir.replace('/home/nucleo', '~')} · ${fmtBytes(result.bytes)} · ${Math.round(result.ms)} ms`);
    const copiados = result.ok.filter(o => o.renamed).map(o => o.name);
    if (copiados.length) partes.push(`renomeado por já existir: ${copiados.join(', ')}`);
  }
  if (result.failed.length) partes.push(`falhou: ${result.failed.map(f => `${f.name} (${f.error})`).join('; ')}`);
  return partes.join(' · ') || 'nada para instalar';
}
