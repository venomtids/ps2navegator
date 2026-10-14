/** NÚCLEO OS — ui/icons.js : ícones vetoriais (traço 1,5 px, currentColor). */
const NS = 'http://www.w3.org/2000/svg';

const PATHS = {
  terminal: ['M3 4.5h10v7H3z', 'M5.4 7l1.3 1.3-1.3 1.3', 'M8.6 9.6h2.4'],
  files: ['M2.8 5.2h4l1.1 1.3h5.3v5.1H2.8z', 'M2.8 5.2V3.9h3l1 1.3'],
  settings: ['M8 10.1a2.1 2.1 0 100-4.2 2.1 2.1 0 000 4.2z', 'M8 2.6v1.2M8 12.2v1.2M2.6 8h1.2M12.2 8h1.2M4.2 4.2l.85.85M10.95 10.95l.85.85M11.8 4.2l-.85.85M5.05 10.95l-.85.85'],
  kernel: ['M3 4.6h10v6.8H3z', 'M5 6.6h2.4v2.8H5z', 'M9 6.6h2v1.4H9zM9 9h2v.8H9z'],
  game: ['M2.6 6.4l1.3-2.7h8.2l1.3 2.7v3.5H2.6z', 'M5.6 8.2h1.6M6.4 7.4v1.6', 'M10.2 8.1h.01M11.2 9h.01'],
  hud: ['M2.8 9.6l2.6-3 2.2 2.2 2.2-3.4 3.4 4.2', 'M2.8 12.6h10.4'],
  storage: ['M3 4.4h10v7.2H3z', 'M5.2 6.6h5.6M5.2 9.4h3.2'],
  power: ['M8 2.8v5', 'M4.6 4.6a4.6 4.6 0 106.8 0'],
  search: ['M7.2 11.4a4.2 4.2 0 100-8.4 4.2 4.2 0 000 8.4z', 'M10.4 10.4l3 3'],
  brush: ['M3.4 12.6c2-2.4 3.2-3.4 5-5.2l2.6 2.6-5.2 5C4.6 14.6 3.6 13.6 3.4 12.6z', 'M9.4 6.2l2.4-2.4 2.4 2.4-2.4 2.4z'],
  chip: ['M4.6 4.6h6.8v6.8H4.6z', 'M6.4 6.4h3.2v3.2H6.4z', 'M6.6 2.8v1.8M9.4 2.8v1.8M6.6 11.4v1.8M9.4 11.4v1.8M2.8 6.6h1.8M2.8 9.4h1.8M11.4 6.6h1.8M11.4 9.4h1.8'],
  folder: ['M2.8 5.2h4l1.1 1.3h5.3v5.1H2.8z'],
  file: ['M4.4 2.8h4.6l2.6 2.6v7.8H4.4z', 'M9 2.8v2.6h2.6'],
  play: ['M5.4 3.6l6.2 4.4-6.2 4.4z'],
  x: ['M5 5l6 6M11 5l-6 6'],
  reboot: ['M8 3.2a4.8 4.8 0 104.7 5.9', 'M8 1.6v3.4h3.3']
};

export function svgIcon(name, size = 24) {
  const node = document.createElementNS(NS, 'svg');
  node.setAttribute('viewBox', '0 0 16 16');
  node.setAttribute('width', String(size));
  node.setAttribute('height', String(size));
  node.setAttribute('aria-hidden', 'true');
  for (const d of PATHS[name] || PATHS.file) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    node.append(p);
  }
  return node;
}

export const ICON_NAMES = Object.keys(PATHS);
