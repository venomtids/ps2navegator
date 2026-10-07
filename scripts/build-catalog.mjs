#!/usr/bin/env node
// Gera data/ps2-catalog.json a partir do banco OPL (Redump / PSXDatacenter / ScreenScraper).
// Uso:
//   node scripts/build-catalog.mjs --pt <PS2DB_PT.xml> --en <PS2DB_EN.xml>
//   node scripts/build-catalog.mjs --fetch   (baixa o banco do repositório upstream)
'use strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'ps2-catalog.json');
const UPSTREAM = 'https://github.com/GDX-X/OPL-Games-Infos-Database-Project/raw/master';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i === -1 ? fallback : args[i + 1];
};
const has = name => args.includes('--' + name);

// SLUS_209.46, slus-20946 e SLUS 209.46 precisam colapsar para a mesma chave.
export function normalizeSerial(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const field = (block, name) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? m[1].trim() : '';
};
const clean = text => text.replace(/\s+/g, ' ').trim();
const decode = text => clean(text
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&'));

const MAX_DESC = 190;
const clip = text => {
  const value = decode(text);
  return value.length <= MAX_DESC ? value : value.slice(0, MAX_DESC - 1).replace(/\s+\S*$/, '') + '…';
};

async function readSource(lang) {
  const explicit = flag(lang.toLowerCase(), '');
  if (explicit) return fsp.readFile(explicit, 'utf8');
  const cached = path.join(ROOT, '.cache', 'opl-db', `PS2DB_${lang}.xml`);
  if (fs.existsSync(cached)) return fsp.readFile(cached, 'utf8');
  if (!has('fetch')) throw new Error(`Fonte ${lang} ausente. Use --${lang.toLowerCase()} <arquivo> ou --fetch.`);
  const url = `${UPSTREAM}/PS2DB_${lang}.xml`;
  process.stdout.write(`baixando ${url}\n`);
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`Falha ao baixar ${url}: HTTP ${r.status}`);
  const text = await r.text();
  await fsp.mkdir(path.dirname(cached), { recursive: true });
  await fsp.writeFile(cached, text);
  return text;
}

function parse(xml) {
  const out = new Map();
  const version = (/<PS2GamesDB version="(\d+)"/.exec(xml) || [, ''])[1];
  const blocks = xml.split(/<game\s/).slice(1);
  for (const raw of blocks) {
    const block = raw.slice(0, raw.indexOf('</game>') + 1);
    const serial = field(block, 'Serial') || (/^serial="([^"]+)"/.exec(raw) || [, ''])[1];
    const key = normalizeSerial(serial);
    if (!key) continue;
    out.set(key, {
      serial: clean(serial).toUpperCase(),
      title: decode(field(block, 'Title')),
      region: clean(field(block, 'Region')),
      release: clean(field(block, 'Release')),
      developer: clean(field(block, 'Developer')),
      publisher: clean(field(block, 'Publisher')),
      genre: clean(field(block, 'Genre')),
      description: clip(field(block, 'Description')),
      rating: clean(field(block, 'Rating')),
      vmode: clean(field(block, 'Vmode')).replace(/^vmode\//, '')
    });
  }
  return { version, games: out };
}

const xmlPt = await readSource('PT');
const xmlEn = await readSource('EN');
const pt = parse(xmlPt);
const en = parse(xmlEn);

// Dicionários: valores repetidos viram índice, o que derruba bastante o tamanho final.
const dict = { region: [], genre: [], publisher: [], developer: [] };
const intern = (bucket, value) => {
  const v = value || '';
  let i = dict[bucket].indexOf(v);
  if (i === -1) { i = dict[bucket].push(v) - 1; }
  return i;
};

const games = [];
for (const key of pt.games.keys()) {
  const a = pt.games.get(key), b = en.games.get(key) || {};
  if (!a.title && !b.title) continue;
  games.push([
    a.serial,
    a.title || b.title,
    b.title && b.title !== (a.title || b.title) ? b.title : '',
    intern('region', a.region || b.region),
    intern('genre', a.genre || b.genre),
    intern('developer', a.developer || b.developer),
    intern('publisher', a.publisher || b.publisher),
    a.release || b.release || '',
    a.rating || b.rating || '',
    a.description || b.description || '',
    a.vmode || b.vmode || ''
  ]);
}
games.sort((x, y) => (x[1] || x[0]).localeCompare(y[1] || y[0], 'pt-BR'));

const catalog = {
  generated: new Date().toISOString(),
  version: pt.version || en.version,
  console: 'Sony PlayStation 2',
  count: games.length,
  attribution: 'GDX-X/OPL-Games-Infos-Database-Project',
  sources: ['Redump.org (títulos)', 'PlayStation DataCenter', 'ScreenScraper.fr'],
  note: 'Somente metadados. Nenhuma ROM, ISO ou link de download é distribuído neste catálogo.',
  dict,
  games
};

await fsp.mkdir(path.dirname(OUT), { recursive: true });
await fsp.writeFile(OUT, JSON.stringify(catalog));
const kb = (Buffer.byteLength(JSON.stringify(catalog)) / 1024).toFixed(0);
process.stdout.write(`catálogo: ${games.length} jogos · ${kb} KB · ${OUT}\n`);
