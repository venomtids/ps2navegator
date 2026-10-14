/**
 * SECTOR OS — apps/terminal.js
 * Terminal do desktop. Comandos fazem coisas reais no VMFS (OPFS via w-io) e
 * reportam números reais da telemetria. O que não existe responde que não existe.
 *
 * Regra do Design System §6.9: histórico fixo de 200 linhas, escrita só por
 * textContent, comandos desconhecidos sugerem `help`.
 */

import { el, fmt1, fmtBytes, safePath, dirName, baseName, fmtDuration, fmtClock } from '../core/util.js';

const HISTORY_MAX = 200;

export function createTerminal({ vfs, os }) {
  const out = el('div', { class: 'term', tabindex: '0', role: 'log', 'aria-live': 'polite' });
  const input = el('input', {
    type: 'text', spellcheck: 'false', autocomplete: 'off',
    'aria-label': 'Entrada de comando', placeholder: 'digite: help'
  });
  const prompt = el('span', { class: 'p' });
  const cwdLabel = el('span', { class: 'd' });
  const line = el('div', { class: 'pin' }, prompt, cwdLabel, el('span', { class: 'm', text: '$' }), input);
  const live = el('div', { class: 'ln' }, line);
  out.append(live);

  let cwd = '/home/sector';
  let busy = false;
  const history = [];
  let histIdx = -1;

  function println(parts) {
    const node = el('div', { class: 'ln' });
    if (typeof parts === 'string') node.textContent = parts;
    else for (const [cls, text] of parts) node.append(el('span', { class: cls, text }));
    out.insertBefore(node, live);
    while (out.children.length > HISTORY_MAX) out.removeChild(out.firstChild);
    out.scrollTop = out.scrollHeight;
  }
  const ok = t => println([['ok', t]]);
  const err = t => println([['e', t]]);
  const dim = t => println([['m', t]]);

  function syncPrompt() { cwdLabel.textContent = cwd.replace('/home/sector', '~'); }

  const COMMANDS = {
    async help() {
      println([['p', 'comandos disponíveis']]);
      for (const [name, desc] of Object.entries(HELP)) dim(`  ${name.padEnd(11)} ${desc}`);
      dim('  dica: Ctrl+K abre a paleta de comandos do desktop');
    },
    async clear() { while (out.children.length > 1) out.removeChild(out.firstChild); },
    async echo(args) { println(args.join(' ')); },
    async pwd() { println(cwd); },
    async ls(args) {
      const target = args[0] ? safePath(args[0], cwd) : cwd;
      const rows = await vfs.list(target);
      if (!rows.length) return dim('(vazio)');
      for (const r of rows.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))) {
        const size = r.type === 'dir' ? '—' : fmtBytes(r.size, 0);
        println([['m', `${r.type === 'dir' ? 'd' : '-'} ${String(size).padStart(9)} `], ['', r.name]]);
      }
    },
    async cd(args) {
      const target = args[0] ? safePath(args[0], cwd) : '/home/sector';
      const st = await vfs.stat(target);
      if (st.type !== 'dir') return err(`${target}: não é um diretório`);
      cwd = target;
      syncPrompt();
    },
    async cat(args) {
      if (!args[0]) return err('uso: cat <arquivo>');
      const bytes = await vfs.read(args[0]);
      println(new TextDecoder().decode(bytes).replace(/\s+$/, ''));
    },
    async mkdir(args) {
      if (!args[0]) return err('uso: mkdir <caminho>');
      const p = await vfs.mkdir(args[0]);
      ok(`criado ${p}`);
    },
    async touch(args) {
      if (!args[0]) return err('uso: touch <arquivo>');
      const p = await vfs.write(args[0], new Uint8Array(0));
      ok(`criado ${p.path || args[0]}`);
    },
    async write(args) {
      if (args.length < 2) return err('uso: write <arquivo> <texto…>');
      const p = await vfs.write(args[0], args.slice(1).join(' '));
      ok(`gravados ${p.bytes} bytes em ${p.path}`);
    },
    async rm(args) {
      if (!args[0]) return err('uso: rm <caminho>');
      const p = await vfs.remove(args[0]);
      ok(`removido ${p.path}`);
    },
    async df() {
      const u = await vfs.usage();
      println([['', `backend      ${vfs.info.backend}${vfs.info.sync ? ' (sync access)' : ''}`]]);
      println([['', `persistente  ${u.persisted ? 'sim' : 'melhor esforço (evictable)'}`]]);
      println([['', `arquivos     ${u.files}`]]);
      println([['', `usado        ${fmtBytes(u.usedBytes)}`]]);
      println([['', `cota         ${Number.isFinite(u.quotaBytes) ? fmtBytes(u.quotaBytes) : 'N/D (navegador não informa)'}`]]);
    },
    async free() {
      const heap = performance.memory?.usedJSHeapSize;
      println([['', `worker heaps  kernel=${fmtBytes(os.metrics.kernelHeap)} engine=${fmtBytes(os.metrics.engineHeap)} io=${fmtBytes(os.metrics.ioHeap)}`]]);
      dim('  (workers não expõem heap próprio: mostramos N/D em vez de estimar)');
      if (Number.isFinite(heap)) println([['', `heap main     ${fmtBytes(heap)} de ${fmtBytes(performance.memory.jsHeapSizeLimit)}`]]);
      else dim('heap main     N/D — performance.memory é exclusivo do Chromium');
      dim('memória do guest Linux entra quando o runtime real for conectado (fase F4)');
    },
    async ps() {
      const m = os.metrics;
      println([['p', '  PID  SUBSISTEMA   ESTADO      ms/tick   NOTA']]);
      for (const w of m.workers) {
        println([['', `  ${String(w.pid).padStart(3)}  ${w.name.padEnd(11)} ${(w.alive ? 'vivo' : 'morto').padEnd(10)} ${(Number.isFinite(w.ms) ? fmt1(w.ms) : '—').padStart(6)}   ${w.note}`]]);
      }
      println([['', `  ${String(0).padStart(3)}  ${'main'.padEnd(11)} ${'vivo'.padEnd(10)} ${(Number.isFinite(m.frameP50) ? fmt1(m.frameP50) : '—').padStart(6)}   compositor + WM`]]);
    },
    async top() {
      const m = os.metrics;
      println([['p', `fps ${fmt1(m.fps)}  p50 ${fmt1(m.frameP50)} ms  p95 ${fmt1(m.frameP95)} ms  entidades ${m.entities}`]]);
      println([['', `sim ${fmt1(m.simMs)} ms · kernel ${fmt1(m.kernelMs)} ms · io ${fmt1(m.ioMs)} ms (${fmt1(m.ioMbps)} MB/s)`]]);
      println([['', `transporte ${m.transport} · backend ${m.backend} · fila ${m.queue}`]]);
      if (Number.isFinite(m.heapMb)) println([['', `heap main ${fmt1(m.heapMb)} MB`]]);
    },
    async sysctl() {
      const s = os.capabilities;
      const rows = [
        ['Uname', 'SECTOR OS (JS/WASM) 0.4.0'],
        ['origem isolada', String(s.isolated)],
        ['SharedArrayBuffer', String(s.sab)],
        ['Atomics.wait', String(s.atomicsWait)],
        ['CPU lógicas', `${s.cores}`],
        ['WebGPU', s.webgpu ? 'disponível' : 'indisponível'],
        ['WebGL2', s.webgl2 ? 'disponível' : 'indisponível'],
        ['OPFS', s.opfs ? (s.syncAccess ? 'OPFS + SyncAccessHandle' : 'OPFS (sem sync)') : 'indisponível'],
        ['DPR', String(window.devicePixelRatio)],
        ['fuso', Intl.DateTimeFormat().resolvedOptions().timeZone]
      ];
      for (const [k, v] of rows) println([['m', `${k.padEnd(20)}`], ['', v]]);
    },
    async uptime() { println(`sessão ativa há ${fmtDuration(performance.now())} · agora ${fmtClock()}`); },
    async date() { println(new Date().toLocaleString('pt-BR')); },
    async uname() { println('SECTOR-OS 0.4.0-sim wasm32 web-workers'); },
    async neofetch() {
      const art = [
        '   ▄▄▄▄▄▄▄▄   ',
        '  █ ▄▄▄▄▄▄ █  ',
        '  █ █ ▄▄ █ █  ',
        '  █ █▄▄▄▄█ █  ',
        '  █▄▄▄▄▄▄▄█   ',
        '   ▀▀▀▀▀▀▀▀   '
      ];
      const info = [
        'SECTOR OS 0.4.0',
        '----------------',
        `runtime    SIM (infra real)`,
        `transporte ${os.metrics.transport}`,
        `backend    ${os.metrics.backend}`,
        `apps       ${os.apps.length}`,
        `vmfs       ${vfs.info.backend}`
      ];
      for (let i = 0; i < Math.max(art.length, info.length); i++)
        println([['p', (art[i] || '             ').padEnd(15)], ['', info[i] || '']]);
    },
    async bench() {
      dim('medindo I/O do VMFS (escrita + leitura de 1 MiB)…');
      const r = await vfs.bench();
      ok(`escrita ${fmt1(r.writeMbps)} MB/s · leitura ${fmt1(r.readMbps)} MB/s · ${fmt1(r.writeMs + r.readMs)} ms`);
      dim(`backend ${r.backend}${r.sync ? ' (SyncAccessHandle)' : ' (assíncrono)'}`);
    },
    async open(args) {
      const app = args[0];
      const found = os.apps.find(a => a.id === app);
      if (!found) return err(`app desconhecido: ${app || '(vazio)'} — tente: ${os.apps.map(a => a.id).join(', ')}`);
      os.launch(app);
      ok(`abrindo ${app}`);
    },
    async reboot() { os.reboot(); }
  };

  const HELP = {
    ls: 'lista diretório', cat: 'mostra arquivo', cd: 'muda de diretório', pwd: 'caminho atual',
    mkdir: 'cria pasta', touch: 'cria arquivo vazio', write: 'grava texto em arquivo', rm: 'remove',
    df: 'uso do disco virtual', free: 'memória (real ou N/D)', ps: 'subsistemas e custo por tick',
    top: 'instantâneo da telemetria', sysctl: 'capacidades do navegador', bench: 'benchmark de I/O',
    open: 'abre um app do desktop', neofetch: 'resumo da build', uname: 'identificação',
    uptime: 'tempo de sessão', date: 'hora local', clear: 'limpa a tela', reboot: 'reinicia o OS'
  };

  async function run(text) {
    const parts = text.split(/\s+/).filter(Boolean);
    const cmd = parts.shift();
    const fn = COMMANDS[cmd];
    if (!fn) {
      err(`${cmd}: comando não encontrado`);
      dim('tente `help` para a lista completa');
      return;
    }
    busy = true;
    try { await fn(parts); }
    catch (e) { err(String(e.message || e)); }
    finally { busy = false; }
  }

  input.addEventListener('keydown', async event => {
    if (event.key === 'Enter' && !busy) {
      const text = input.value.trim();
      input.value = '';
      println([['p', cwd.replace('/home/sector', '~')], ['m', '$ '], ['', text]]);
      if (!text) return;
      history.push(text);
      if (history.length > 100) history.shift();
      histIdx = history.length;
      await run(text);
      syncPrompt();
    } else if (event.key === 'ArrowUp') {
      if (!history.length) return;
      histIdx = Math.max(0, histIdx - 1);
      input.value = history[histIdx] || '';
      event.preventDefault();
    } else if (event.key === 'ArrowDown') {
      if (!history.length) return;
      histIdx = Math.min(history.length, histIdx + 1);
      input.value = history[histIdx] || '';
      event.preventDefault();
    } else if (event.key === 'l' && event.ctrlKey) {
      event.preventDefault();
      COMMANDS.clear();
    }
  });
  out.addEventListener('pointerdown', () => setTimeout(() => input.focus(), 0));

  syncPrompt();
  println([['p', 'SECTOR OS 0.4.0'], ['m', ' — shell do desktop (runtime Linux real: fase F4)']]);
  dim('digite `help`. O VMFS abaixo é real: grava em OPFS quando disponível.');

  return {
    el: out,
    onMount() { setTimeout(() => input.focus(), 60); },
    focus() { input.focus(); },
    onClose() { }
  };
}
