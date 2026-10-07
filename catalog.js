'use strict';
// Catálogo de metadados de PS2 + busca de itens no Internet Archive.
// Nada aqui contém ROMs, ISOs ou links de download: só metadados e identificadores.
const fs = require('node:fs');
const path = require('node:path');

const CATALOG = path.join(__dirname, 'data', 'ps2-catalog.json');
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const normalizeSerial = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const one = value => Array.isArray(value) ? value[0] : value;

let cache = null;
function load() {
  if (!cache) {
    if (!fs.existsSync(CATALOG)) throw error('Catálogo não gerado. Rode: npm run catalog:build', 503);
    cache = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
    cache.index = new Map(cache.games.map(g => [normalizeSerial(g[0]), g]));
  }
  return cache;
}

const FIELDS = ['region', 'genre', 'developer', 'publisher'];
const expand = (c, g) => ({
  serial: g[0], title: g[1], titleEn: g[2],
  region: c.dict.region[g[3]] || '', genre: c.dict.genre[g[4]] || '',
  developer: c.dict.developer[g[5]] || '', publisher: c.dict.publisher[g[6]] || '',
  release: g[7], rating: g[8], description: g[9], vmode: g[10]
});

function search({ q = '', region = '', genre = '', sort = 'title', page = 0, pageSize = 48 }) {
  const c = load();
  const needle = String(q).toLowerCase().trim();
  const terms = needle ? needle.split(/\s+/) : [];
  const regionValue = String(region).toLowerCase();
  const genreValue = String(genre).toLowerCase();

  const matches = [];
  for (const g of c.games) {
    if (regionValue && (c.dict.region[g[3]] || '').toLowerCase() !== regionValue) continue;
    if (genreValue && (c.dict.genre[g[4]] || '').toLowerCase() !== genreValue) continue;
    if (terms.length) {
      const haystack = `${g[0]} ${g[1]} ${g[2]} ${g[7]} ${c.dict.developer[g[5]] || ''} ${c.dict.publisher[g[6]] || ''}`.toLowerCase();
      if (!terms.every(t => haystack.includes(t))) continue;
    }
    matches.push(g);
  }
  if (sort === 'release') {
    // Lançamentos vêm como "26 Outubro 2004"; extrai o ano para ordenar.
    matches.sort((a, b) => (Number((b[7].match(/\d{4}/) || [0])[0]) - Number((a[7].match(/\d{4}/) || [0])[0])) || a[1].localeCompare(b[1], 'pt-BR'));
  } else if (sort === 'rating') {
    matches.sort((a, b) => (Number(b[8]) || 0) - (Number(a[8]) || 0) || a[1].localeCompare(b[1], 'pt-BR'));
  }
  const size = Math.min(Math.max(Number(pageSize) || 48, 1), 200);
  const start = Math.max(Number(page) || 0, 0) * size;
  return { total: matches.length, page: start / size, pageSize: size, games: matches.slice(start, start + size).map(g => expand(c, g)) };
}

// ---------------------------------------------------------------- Internet Archive
const ITEM_RE = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,199}$/;
function allowedURL(value) {
  let u;
  try { u = new URL(value); } catch { throw error('Endereço inválido.', 400); }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') ||
      !(u.hostname === 'archive.org' || u.hostname.endsWith('.archive.org')))
    throw error('Somente archive.org é permitido.', 502);
  return u;
}
async function remote(url, signal) {
  for (let hop = 0; hop < 5; hop++) {
    const u = allowedURL(url);
    const r = await fetch(u, { signal, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const location = r.headers.get('location');
      await r.body?.cancel();
      if (!location) throw error('Redirecionamento sem destino.', 502);
      url = new URL(location, u).href;
      continue;
    }
    return r;
  }
  throw error('Excesso de redirecionamentos.', 502);
}
async function readJSON(url, signal, max = 4 * 1024 * 1024) {
  const r = await remote(url, signal);
  if (!r.ok) {
    await r.body?.cancel();
    throw error(`Internet Archive respondeu HTTP ${r.status}.`, 502);
  }
  let size = 0; const chunks = [];
  for await (const chunk of r.body) {
    size += chunk.length;
    if (size > max) { await r.body.cancel(); throw error('Resposta do Archive grande demais.', 502); }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const ttl = new Map();
async function cached(key, ms, produce) {
  const hit = ttl.get(key);
  if (hit && Date.now() < hit.until) return hit.value;
  const value = await produce();
  ttl.set(key, { value, until: Date.now() + ms });
  if (ttl.size > 200) for (const k of ttl.keys()) { ttl.delete(k); if (ttl.size <= 200) break; }
  return value;
}

async function archiveSearch(query) {
  const q = String(query || '').trim();
  if (q.length < 2 || q.length > 200) throw error('Informe um termo de busca entre 2 e 200 caracteres.');
  return cached('s:' + q.toLowerCase(), 120000, async () => {
    const signal = AbortSignal.timeout(25000);
    const url = 'https://archive.org/advancedsearch.php?' + new URLSearchParams({
      q: `${q} AND mediatype:(software)`,
      fl: 'identifier,title,downloads,publicdate',
      sort: 'downloads desc',
      rows: '24', page: '1', output: 'json'
    });
    const data = await readJSON(url, signal);
    const docs = (data?.response?.docs || []).map(d => ({
      identifier: String(d.identifier || ''),
      title: String(d.title || d.identifier || ''),
      downloads: Number(d.downloads) || 0,
      publicdate: String(d.publicdate || '')
    })).filter(d => ITEM_RE.test(d.identifier));
    return { query: q, items: docs };
  });
}

async function archiveFiles(item) {
  const id = String(one(item) || '').trim();
  if (!ITEM_RE.test(id)) throw error('Identificador do Archive inválido.');
  return cached('f:' + id, 300000, async () => {
    const signal = AbortSignal.timeout(25000);
    const data = await readJSON('https://archive.org/metadata/' + encodeURIComponent(id), signal);
    const files = (data?.files || [])
      .filter(f => /\.iso$/i.test(String(f.name || '')) && !/^\./.test(String(f.name || '')))
      .map(f => ({ name: String(f.name), size: Number(f.size) || 0 }))
      .filter(f => f.size > 34816)
      .sort((a, b) => b.size - a.size);
    return { item: id, title: String(data?.metadata?.title || id), files };
  });
}

function router() {
  const router = require('express').Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  router.get('/search', (req, res, next) => {
    try { res.json(search({ ...req.query, q: one(req.query.q), region: one(req.query.region), genre: one(req.query.genre), sort: one(req.query.sort) })); }
    catch (e) { next(e); }
  });
  router.get('/facets', (req, res, next) => {
    try {
      const c = load();
      res.json({
        version: c.version, count: c.count, generated: c.generated,
        attribution: c.attribution, sources: c.sources, note: c.note,
        region: c.dict.region.filter(Boolean).sort(),
        genre: c.dict.genre.filter(Boolean).sort((a, b) => a.localeCompare(b, 'pt-BR'))
      });
    } catch (e) { next(e); }
  });
  router.get('/serial/:serial', (req, res, next) => {
    try {
      const c = load();
      const g = c.index.get(normalizeSerial(req.params.serial));
      if (!g) throw error('Serial não encontrado no catálogo.', 404);
      res.json(expand(c, g));
    } catch (e) { next(e); }
  });
  router.get('/archive/search', async (req, res, next) => {
    try { res.json(await archiveSearch(one(req.query.q))); } catch (e) { next(e); }
  });
  router.get('/archive/files', async (req, res, next) => {
    try { res.json(await archiveFiles(one(req.query.item))); } catch (e) { next(e); }
  });
  router.use((e, req, res, next) => {
    if (!res.headersSent) res.status(e.status || 500).json({ error: e.message || 'Falha no catálogo.' });
  });
  return router;
}

module.exports = { router, search, archiveSearch, archiveFiles, normalizeSerial, load };
