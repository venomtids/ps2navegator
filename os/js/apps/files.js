/**
 * SECTOR OS — apps/files.js
 * Gerenciador de arquivos do VMFS (§6.10). Todas as ações são reais no VMFS
 * (OPFS via w-io): nada aqui é maquete.
 */

import { el, fmtBytes, baseName, safePath } from '../core/util.js';
import { svgIcon } from '../ui/icons.js';

const ROOTS = ['/', '/home/sector', '/etc', '/var/sector', '/mnt/sector'];

export function createFiles({ vfs, toast }) {
  const tree = el('div', { class: 'tree' });
  const list = el('div', { class: 'list', role: 'grid', 'aria-label': 'Arquivos' });
  const pathLabel = el('span', { class: 'path' });
  let cwd = '/home/sector';
  let selection = null;

  const bar = el('div', { class: 'bar' },
    btn('Nova pasta', () => act('mkdir')),
    btn('Novo arquivo', () => act('newfile')),
    btn('Renomear', () => act('rename'), !0),
    btn('Apagar', () => act('remove'), true),
    el('span', { style: { flex: '1' } }),
    btn('Benchmark', async () => {
      try {
        const r = await vfs.bench();
        toast.ok('Benchmark de I/O', `escrita ${r.writeMbps.toFixed(1)} MB/s · leitura ${r.readMbps.toFixed(1)} MB/s`);
      } catch (e) { toast.err('Benchmark falhou', String(e.message || e)); }
    })
  );

  const root = el('div', { class: 'fm' },
    tree,
    el('div', { class: 'pane' },
      el('div', { class: 'phead' },
        el('span', { class: 'lbl', text: 'vmfs' }),
        pathLabel,
        btn('Atualizar', () => refresh())
      ),
      list,
      bar
    )
  );

  function btn(label, onclick, disabled = false) {
    return el('button', { class: 'btn', text: label, onclick, disabled });
  }

  function renderTree() {
    tree.replaceChildren(...ROOTS.map(path => {
      const node = el('div', { class: `tnode${path === cwd ? ' on' : ''}`, onclick: () => open(path) },
        svgIcon('folder', 13), el('span', { text: path === '/home/sector' ? '~ (sector)' : path }));
      return node;
    }));
  }

  async function open(path) {
    cwd = safePath(path);
    selection = null;
    pathLabel.textContent = cwd;
    renderTree();
    await refresh();
  }

  async function refresh() {
    list.replaceChildren(el('div', { class: 'empty', text: 'lendo…' }));
    try {
      const rows = await vfs.list(cwd);
      list.replaceChildren();
      if (!rows.length) list.append(el('div', { class: 'empty', text: 'pasta vazia' }));
      for (const row of rows.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))) {
        const node = el('div', {
          class: `frow${selection === row.name ? ' sel' : ''}`, role: 'row', tabindex: '0',
          ondblclick: () => row.type === 'dir' ? open(`${cwd === '/' ? '' : cwd}/${row.name}`) : preview(row),
          onclick: () => { selection = row.name; refresh(); }
        },
          svgIcon(row.type === 'dir' ? 'folder' : 'file', 14),
          el('span', { class: 'nm', text: row.name }),
          el('span', { class: 'sz', text: row.type === 'dir' ? 'pasta' : fmtBytes(row.size, 1) })
        );
        list.append(node);
      }
    } catch (e) {
      list.replaceChildren(el('div', { class: 'empty', text: `erro: ${e.message || e}` }));
    }
  }

  async function preview(row) {
    try {
      const bytes = await vfs.read(`${cwd === '/' ? '' : cwd}/${row.name}`);
      const text = new TextDecoder().decode(bytes.subarray(0, 400));
      toast.push({ kind: 'info', title: row.name, text: text.replace(/\s+/g, ' ').slice(0, 220) || '(vazio)', ms: 8000 });
    } catch (e) { toast.err('Não foi possível ler', String(e.message || e)); }
  }

  async function act(kind) {
    try {
      const target = selection ? `${cwd === '/' ? '' : cwd}/${selection}` : null;
      if (kind === 'mkdir') {
        const name = prompt('Nome da nova pasta:'); // eslint-disable-line no-alert
        if (!name) return;
        await vfs.mkdir(`${cwd === '/' ? '' : cwd}/${name}`);
        toast.ok('Pasta criada', name);
      } else if (kind === 'newfile') {
        const name = prompt('Nome do novo arquivo:'); // eslint-disable-line no-alert
        if (!name) return;
        await vfs.write(`${cwd === '/' ? '' : cwd}/${name}`, `arquivo criado em ${new Date().toISOString()}\n`);
        toast.ok('Arquivo criado', name);
      } else if (kind === 'rename') {
        if (!target) return toast.warn('Nada selecionado', 'Escolha um item na lista.');
        const name = prompt('Novo nome:', selection); // eslint-disable-line no-alert
        if (!name || name === selection) return;
        await vfs.rename(target, `${cwd === '/' ? '' : cwd}/${name}`);
        toast.ok('Renomeado', `${selection} → ${name}`);
        selection = name;
      } else if (kind === 'remove') {
        if (!target) return toast.warn('Nada selecionado', 'Escolha um item na lista.');
        await vfs.remove(target);
        toast.push({ kind: 'warn', title: 'Removido', text: baseName(target) });
        selection = null;
      }
      await refresh();
    } catch (e) { toast.err('Operação falhou', String(e.message || e)); }
  }

  renderTree();
  pathLabel.textContent = cwd;
  refresh();

  return { el: root, onMount() { open(cwd); }, refresh, cwd: () => cwd };
}
