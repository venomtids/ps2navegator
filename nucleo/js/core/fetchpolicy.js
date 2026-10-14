/**
 * NÚCLEO OS — core/fetchpolicy.js
 * Política de rede do navegador do sistema. **Puro**: não faz I/O, só decide.
 *
 * Por que existe um módulo só para isto: um "navegador" dentro do PC virtual
 * precisa buscar páginas, e uma rota de busca é um proxy — proxies são a porta
 * clássica de SSRF (o atacante faz o servidor acessar a rede interna dele).
 * Aqui a decisão de "pode ou não pode" é isolada do transporte para poder ser
 * testada exaustivamente sem rede e sem servidor no meio.
 *
 * Bloqueios aplicados, cada um com motivo declarado:
 *  - esquemas que não sejam http/https (file:, data:, blob:, javascript:);
 *  - credenciais embutidas na URL (user:pass@host);
 *  - portas baixas fora de 80/443, e portas altas de serviços internos conhecidos
    (Docker API, Redis, bancos, orquestração — lista em BLOCKED_PORTS);
 *  - endereços IP literais privados/loopback/link-local/multicast;
 *  - nomes locais (localhost, .local, .internal, .home.arpa);
 *  - e, depois da resolução DNS, qualquer IP privado devolvido.
 *
 * Limite conhecido e declarado: a checagem de IP é feita antes da conexão, então
 * um DNS que devolva um IP público e depois mude (DNS rebinding) não é pego por
 * ela. A mitigação real é não expor este servidor: ele é para uso local.
 */

export const MAX_TEXT_BYTES = 2 * 1024 * 1024;      // páginas: 2 MiB de HTML
export const MAX_RAW_BYTES = 8 * 1024 * 1024;       // downloads: 8 MiB
export const MAX_REDIRECTS = 5;
export const FETCH_TIMEOUT_MS = 15000;

const LOCAL_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa', '.lan', '.intranet'];

/**
 * Portas de serviços internos conhecidos, bloqueadas mesmo acima de 1024.
 * Nenhuma delas entrega páginas; todas entregam controle (Docker API, bancos,
 * cache, orquestração). Se um dia forem necessárias, que seja por decisão
 * explícita de quem instalou — não por descuido do padrão.
 */
const BLOCKED_PORTS = new Set([
  2375, 2376,      // Docker API
  3306, 5432, 1433, // MySQL, PostgreSQL, SQL Server
  6379,            // Redis
  9200, 9300,      // Elasticsearch
  11211,           // memcached
  27017, 27018, 27019, // MongoDB
  5984,            // CouchDB
  8500, 8600,      // Consul
  6443, 10250, 10255 // Kubernetes API e kubelet
]);
const LOCAL_NAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback', 'broadcasthost']);

/** Faixas IPv4 que não podem ser alcançadas pelo proxy (notação CIDR em prefixos). */
const V4_BLOCKS = [
  ['0.0.0.0', 8],        // "esta rede"
  ['10.0.0.0', 8],       // privada
  ['100.64.0.0', 10],    // CGNAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local (metadados de nuvem moram aqui)
  ['172.16.0.0', 12],    // privada
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.168.0.0', 16],   // privada
  ['198.18.0.0', 15],    // benchmark
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4]       // reservada
];

function v4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

function inBlock(ipInt, baseIp, bits) {
  const base = v4ToInt(baseIp);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (base & mask);
}

/** IPv4 literal? Devolve o formato canônico ou null. */
export function asV4(host) {
  const int = v4ToInt(host);
  if (int === null) return null;
  return [(int >>> 24) & 255, (int >>> 16) & 255, (int >>> 8) & 255, int & 255].join('.');
}

export function isPrivateV4(ip) {
  const int = v4ToInt(ip);
  if (int === null) return false;
  return V4_BLOCKS.some(([base, bits]) => inBlock(int, base, bits));
}

/**
 * Expande um IPv6 em 8 grupos de 16 bits. Entende `::`, forma completa e a
 * notação mista `::ffff:127.0.0.1`. Devolve null se não for IPv6 válido.
 */
export function expandV6(input) {
  let ip = String(input).replace(/^\[|\]$/g, '').trim();
  const zone = ip.indexOf('%');                    // fe80::1%eth0
  if (zone >= 0) ip = ip.slice(0, zone);
  if (!ip.includes(':')) return null;

  // notação mista: últimos 32 bits em decimal
  const dotted = ip.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const v4 = v4ToInt(dotted[1]);
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    ip = ip.slice(0, dotted.index) + `${hi}:${lo}`;
  }

  const [head, tail, ...rest] = ip.split('::');
  if (rest.length) return null;                    // dois "::" é inválido
  const parse = part => {
    if (part === '') return [];
    const groups = part.split(':').map(g => {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return NaN;
      return parseInt(g, 16);
    });
    return groups.some(Number.isNaN) ? null : groups;
  };
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  if (!left || !right) return null;
  if (tail === undefined) return left.length === 8 ? left : null;
  const fill = 8 - left.length - right.length;
  if (fill < 1) return null;
  return [...left, ...new Array(fill).fill(0), ...right];
}

/**
 * IPv6 privado/reservado: loopback (::1), não especificado (::), ULA (fc00::/7),
 * link-local (fe80::/10), multicast (ff00::/8) e IPv4 mapeado (::ffff:0:0/96),
 * este último checado como IPv4 — inclusive na forma hexadecimal `::ffff:7f00:1`,
 * que é como o navegador normaliza `[::ffff:127.0.0.1]`. Ignorar essa forma foi
 * uma brecha real encontrada no primeiro teste desta função.
 */
export function isPrivateV6(ip) {
  const groups = expandV6(ip);
  if (!groups) return false;
  const [a, , , , , f, g, h] = groups;

  if (groups.every(x => x === 0)) return true;                       // ::
  if (groups.slice(0, 7).every(x => x === 0) && h === 1) return true; // ::1
  if ((a & 0xfe00) === 0xfc00) return true;                          // fc00::/7
  if ((a & 0xffc0) === 0xfe80) return true;                          // fe80::/10
  if ((a & 0xff00) === 0xff00) return true;                          // ff00::/8

  const leadingZeroes = groups.slice(0, 5).every(x => x === 0);
  if (leadingZeroes && (f === 0xffff || f === 0)) {
    const v4 = [(g >> 8) & 255, g & 255, (h >> 8) & 255, h & 255].join('.');
    return isPrivateV4(v4);
  }
  return false;
}

/** Nome que nunca deve ser resolvido (nomes locais e afins). */
export function isLocalName(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (LOCAL_NAMES.has(host)) return true;
  return LOCAL_SUFFIXES.some(suffix => host.endsWith(suffix));
}

/**
 * Decide se uma URL pode ser buscada. Devolve `{ ok: true, url, hostname }`
 * ou `{ ok: false, reason }` — sempre com motivo legível para a UI mostrar.
 */
export function checkTarget(input) {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, reason: 'URL vazia' };

  const raw = input.trim();
  // "data:...", "file://..." e "javascript:..." têm esquema; "site.com:8080/x" não
  // (o que parece esquema ali é uma porta). Sem essa distinção, "data:" virava
  // "URL inválida" e o usuário não descobria que o esquema é que não é suportado.
  const pareceEsquema = /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[a-z0-9.-]+:\d+(\/|$)/i.test(raw);
  let url;
  try { url = new URL(pareceEsquema || raw.includes('://') ? raw : `https://${raw}`); }
  catch { return { ok: false, reason: 'URL inválida' }; }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `esquema não suportado: ${url.protocol}` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'credenciais embutidas na URL não são aceitas' };
  }
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if (port < 1024 && port !== 80 && port !== 443) {
    return { ok: false, reason: `porta ${port} bloqueada (só 80/443 abaixo de 1024)` };
  }
  if (BLOCKED_PORTS.has(port)) {
    return { ok: false, reason: `porta ${port} é de um serviço interno e não é acessível pelo navegador` };
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) return { ok: false, reason: 'URL sem host' };
  if (isLocalName(hostname)) return { ok: false, reason: `host local bloqueado: ${hostname}` };

  const v4 = asV4(hostname);
  if (v4 && isPrivateV4(v4)) return { ok: false, reason: `IP privado bloqueado: ${v4}` };
  if (!v4 && hostname.includes(':') && isPrivateV6(hostname)) {
    return { ok: false, reason: `IPv6 privado bloqueado: ${hostname}` };
  }

  url.hash = '';
  return { ok: true, url: url.href, hostname };
}

/** Aplica a mesma política a um IP já resolvido pelo DNS. */
export function checkResolvedAddresses(records = []) {
  for (const rec of records) {
    const address = String(rec?.address || '');
    if (!address) continue;
    if (address.includes(':')) {
      if (isPrivateV6(address)) return { ok: false, reason: `DNS devolveu IPv6 privado: ${address}` };
    } else if (isPrivateV4(address)) {
      return { ok: false, reason: `DNS devolveu IP privado: ${address}` };
    }
  }
  return { ok: true };
}
