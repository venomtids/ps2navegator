// npm run test:catalog — não depende de rede nem de navegador.
'use strict';
const assert = require('node:assert/strict');
const { search, load, normalizeSerial } = require('../catalog.js');

const checks = [];
const ok = (name, fn) => { fn(); checks.push(name); };

ok('serial é normalizado nos dois formatos', () => {
  assert.equal(normalizeSerial('SLUS_209.46'), 'SLUS20946');
  assert.equal(normalizeSerial('slus-20946'), 'SLUS20946');
  assert.equal(normalizeSerial('SLUS 209.46'), 'SLUS20946');
});

ok('catálogo carrega com volume plausível de jogos', () => {
  const c = load();
  assert.ok(c.count > 10000, `esperava >10000 jogos, veio ${c.count}`);
  assert.equal(c.games.length, c.count);
  assert.equal(c.console, 'Sony PlayStation 2');
});

ok('busca por título encontra o GTA San Andreas', () => {
  const r = search({ q: 'grand theft auto san andreas' });
  assert.ok(r.total > 0, 'busca não retornou resultados');
  const gta = r.games.find(g => g.serial === 'SLUS-20946');
  assert.ok(gta, 'SLUS-20946 não apareceu na busca');
  assert.match(gta.title, /San Andreas/);
  assert.equal(gta.region, 'NTSC-U/C');
  assert.equal(gta.developer, 'Rockstar North');
});

ok('busca por serial funciona', () => {
  const r = search({ q: 'SLUS-20946' });
  assert.equal(r.total, 1);
  assert.equal(r.games[0].serial, 'SLUS-20946');
});

ok('termos parciais são combinados com AND', () => {
  const both = search({ q: 'metal gear solid' });
  assert.ok(both.total > 0);
  assert.ok(both.games.every(g => /metal/i.test(g.title) || /metal/i.test(g.titleEn)));
});

ok('filtro de região é aplicado', () => {
  const r = search({ region: 'NTSC-J', pageSize: 200 });
  assert.ok(r.total > 0);
  assert.ok(r.games.every(g => g.region === 'NTSC-J'));
});

ok('paginação é estável e limitada', () => {
  const a = search({ pageSize: 10, page: 0 });
  const b = search({ pageSize: 10, page: 1 });
  assert.equal(a.games.length, 10);
  assert.equal(a.page, 0);
  assert.equal(b.page, 1);
  assert.notEqual(a.games[0].serial, b.games[0].serial);
  assert.equal(search({ pageSize: 99999 }).games.length, 200, 'pageSize deve ser limitado a 200');
  assert.equal(search({ page: -5 }).page, 0, 'página negativa deve ser normalizada');
});

ok('ordenação por ano e por nota funciona', () => {
  const year = i => Number((search({ sort: 'release', pageSize: 50 }).games[i].release.match(/\d{4}/) || [0])[0]);
  assert.ok(year(0) >= year(20), 'ordenação por lançamento deve ser decrescente');
  const rate = i => Number(search({ sort: 'rating', pageSize: 50 }).games[i].rating) || 0;
  assert.ok(rate(0) >= rate(20), 'ordenação por nota deve ser decrescente');
});

ok('busca sem resultado não quebra', () => {
  const r = search({ q: 'zzzqnaoexistezzz' });
  assert.equal(r.total, 0);
  assert.deepEqual(r.games, []);
});

ok('campos expandidos resolvem os dicionários', () => {
  const g = search({ q: 'SLUS-20946' }).games[0];
  for (const key of ['serial', 'title', 'titleEn', 'region', 'genre', 'developer', 'publisher', 'release', 'rating', 'description', 'vmode'])
    assert.ok(key in g, `campo ${key} ausente`);
  assert.ok(g.description.length > 40, 'descrição deve vir preenchida');
});

console.log(`PASS: ${checks.join('; ')}.`);
