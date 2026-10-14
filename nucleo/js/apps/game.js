/**
 * NÚCLEO OS — apps/game.js
 * Janela "Cidade" — mundo aberto procedural alimentado pelo estado real do
 * `w-engine` (snapshot lock-free), com DOIS caminhos de desenho:
 *
 *   1. WebGL2 instanciado (preferido): chão procedural + cidade e tráfego em uma
 *      chamada instanciada por grupo, DRS real, culling por face.
 *   2. Software (canvas 2D), quando WebGL2 não existe, o contexto vem quebrado ou
 *      o shader não compila: a MESMA cena, projetada em JS com a MESMA matriz e
 *      pintada por polígonos com algoritmo do pintor.
 *
 * Histórico honesto deste arquivo (dois defeitos reais, ambos silenciosos):
 *
 *   a) o cubo estava com o sentido de rotação invertido — com `CULL_FACE` ligado,
 *      TODAS as faces eram descartadas e a janela mostrava só o chão escuro;
 *   b) a câmera ficava DENTRO da cidade (14 m de altura, olhando 27° para baixo, com
 *      vizinhos a poucos metros): os prédios próximos projetavam para fora do quadro
 *      e o que sobrava na tela estava a ~250 m — inteiramente comido pela névoa, ou
 *      seja, cor de céu. Resultado visível: "tela preta" com umas linhas fracas.
 *
 * O que mudou por causa de (b): câmera em plano de diorama (fora do quarteirão),
 * névoa com início/fim medidos e piso de visibilidade, clipe de plano próximo de
 * verdade (polígonos e linhas), chão preenchido antes da grade e o modo software
 * usando os MESMOS números do shader (constantes exportadas).
 *
 * Honestidade da fase (docs/00 §14, F3): este é o *pipeline*, não um AAA.
 *  - [B] render instanciado, câmera livre, DRS real, teto de FPS real, modo software;
 *  - [R] terreno por células, WebGPU compute, sombras CSM, física na GPU.
 */

import { el, clamp, Histogram, fmt1, fmtInt } from '../core/util.js';
import { perspective, lookAt, multiply } from '../core/mat4.js';

/** Céu — mesmo tom no `clearColor` do WebGL e no fundo do modo software. */
export const CEU_RGB = [0.008, 0.016, 0.028];
/** Cor de horizonte/névoa: para onde tudo converge ao longe. Mais clara que o zênite. */
export const NEVOA_RGB = [0.030, 0.062, 0.092];
/** Banda de brilho no horizonte (céu com gradiente, não um plano chapado). */
export const HORIZONTE_RGB = [0.055, 0.105, 0.145];
/** Acento aditivo no teto dos prédios (leitura de cidade iluminada por cima). */
export const ACENTO_TETO = [0.030, 0.105, 0.130];
/**
 * Grade viária do mundo. O `w-engine` dirige em vias a cada `LANE_GAP = 40` com
 * duas faixas separadas (centros em múltiplos ímpares de 20). A cidade é gerada
 * sobre ESTA grade: se os dois números divergirem, o tráfego atravessa prédio.
 */
export const VIA = { passo: 40, centro: 20 };
/** Direção da luz (o sol), normalizada — shader e modo software usam a mesma. */
export const SOL = [0.42, 0.86, 0.28];
/**
 * Névoa linear em metros: nada escurece antes de `inicio`; em `fim` a cor já é
 * horizonte. `piso` é o mínimo de cor própria que uma face distante mantém — sem
 * ele, cidade longe vira exatamente a cor do céu e a tela parece vazia.
 */
export const NEVOA = { inicio: 30, fim: 620, piso: 0.34 };
/** Teto de objetos por quadro no modo software (sem z-buffer, usamos o pintor). */
export const TETO_SOFTWARE = 520;
/** Lado do chão desenhado (m) — o shader e o modo software usam este número. */
export const CHAO_LADO = 620;

const VS_SCENE = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec4 aInst;   // x, z, altura, largura
layout(location=3) in vec4 aColor;
uniform mat4 uVP;
out vec3 vN; out vec3 vC; out vec3 vW;
void main(){
  vec3 p = aPos;
  vec3 world = vec3(aInst.x + p.x * aInst.w, p.y * aInst.z, aInst.y + p.z * aInst.w);
  vW = world; vN = aNormal; vC = aColor.rgb;
  gl_Position = uVP * vec4(world, 1.0);
}`;

const FS_SCENE = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vC; in vec3 vW;
out vec4 outColor;
uniform vec3 uSun;
uniform vec3 uFogCor;
uniform vec2 uFog;        // x = início, y = fim
uniform int uShadows;
void main(){
  float d = max(dot(normalize(vN), normalize(uSun)), 0.0);
  float banda = 0.62 + 0.38 * d;
  vec3 col = vC * banda;
  if (vN.y > 0.5) col += vec3(0.030, 0.105, 0.130);   // teto iluminado
  if (uShadows == 1) col *= mix(0.74, 1.0, smoothstep(0.0, 0.35, d));
  float dist = length(vW.xz);
  float f = clamp((dist - uFog.x) / max(1.0, uFog.y - uFog.x), 0.0, 1.0);
  col = mix(col, col * ${NEVOA.piso.toFixed(2)} + uFogCor * ${(1 - NEVOA.piso).toFixed(2)}, f);
  outColor = vec4(col, 1.0);
}`;

const VS_CEU = `#version 300 es
layout(location=0) in vec2 aPos;
out float vY;
void main(){ vY = aPos.y; gl_Position = vec4(aPos, 0.999999, 1.0); }`;

const FS_CEU = `#version 300 es
precision highp float;
in float vY;
out vec4 outColor;
uniform vec3 uTopo;
uniform vec3 uHorizonte;
void main(){
  float t = clamp(vY * 0.5 + 0.5, 0.0, 1.0);
  float curva = pow(1.0 - t, 2.2);
  outColor = vec4(mix(uTopo, uHorizonte, curva), 1.0);
}`;

const VS_GROUND = `#version 300 es
layout(location=0) in vec2 aPos;
uniform mat4 uVP;
uniform float uScale;
out vec2 vXZ;
void main(){
  vXZ = aPos * uScale;
  gl_Position = uVP * vec4(vXZ.x, 0.0, vXZ.y, 1.0);
}`;

const FS_GROUND = `#version 300 es
precision highp float;
in vec2 vXZ;
out vec4 outColor;
uniform vec3 uFogCor;
uniform vec2 uFog;
void main(){
  vec2 g = abs(fract(vXZ / 12.0 - 0.5) - 0.5) / fwidth(vXZ / 12.0);
  float linha = 1.0 - min(min(g.x, g.y), 1.0);
  vec3 base = vec3(0.030, 0.048, 0.070);
  vec3 col = mix(base, vec3(0.10, 0.46, 0.55), linha * 0.7);
  float dist = length(vXZ);
  float f = clamp((dist - uFog.x) / max(1.0, uFog.y - uFog.x), 0.0, 1.0);
  outColor = vec4(mix(col, uFogCor, f * 0.92), 1.0);
}`;

/**
 * Cubo unitário (base em y=0, topo em y=1) com as 6 faces em sentido ANTI-HORÁRIO
 * quando vistas de fora — o critério de frente do OpenGL (`frontFace(CCW)`).
 *
 * Exportado para que o teste possa verificar numericamente o sentido de cada face
 * contra a sua normal, em vez de confiar na leitura do código.
 *
 * Layout por vértice: x, y, z, nx, ny, nz (24 vértices).
 */
export function makeCubeData() {
  const faces = [
    { normal: [0, 0, 1], quad: [[-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5]] },
    { normal: [0, 0, -1], quad: [[0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, 1, -0.5], [0.5, 1, -0.5]] },
    { normal: [1, 0, 0], quad: [[0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, 1, -0.5], [0.5, 1, 0.5]] },
    { normal: [-1, 0, 0], quad: [[-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, 1, 0.5], [-0.5, 1, -0.5]] },
    { normal: [0, 1, 0], quad: [[-0.5, 1, 0.5], [0.5, 1, 0.5], [0.5, 1, -0.5], [-0.5, 1, -0.5]] },
    { normal: [0, -1, 0], quad: [[-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 0, 0.5], [-0.5, 0, 0.5]] }
  ];
  const vertices = new Float32Array(24 * 6);
  const indices = [];
  let v = 0;
  for (const face of faces) {
    const base = v;
    for (const p of face.quad) {
      vertices[v * 6] = p[0]; vertices[v * 6 + 1] = p[1]; vertices[v * 6 + 2] = p[2];
      vertices[v * 6 + 3] = face.normal[0]; vertices[v * 6 + 4] = face.normal[1]; vertices[v * 6 + 5] = face.normal[2];
      v++;
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  // Faces desenhadas em JS: as laterais e o topo (a base nunca é visível de cima).
  const visiveis = faces.filter(f => f.normal[1] >= 0);
  return { vertices, count: 24, faces, indices, facesVisiveis: visiveis };
}

/**
 * Cidade procedural determinística (mesma semente = mesma cidade).
 *
 * Os quarteirões são gerados sobre a grade viária do motor (`VIA`): as ruas ficam
 * nos múltiplos ímpares de 20 e os prédios dentro dos quarteirões de 40 m, com
 * margem — assim o tráfego do `w-engine` passa na rua, e não por dentro de um
 * prédio. Praças (quarteirões vazios) entram de forma determinística.
 */
export function buildCity(seed, meioMetros = 250) {
  const out = [];
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const meio = Math.max(VIA.passo, meioMetros);
  const n = Math.max(1, Math.round(meio / VIA.passo));
  for (let bx = -n; bx <= n; bx++) {
    for (let bz = -n; bz <= n; bz++) {
      const cx = bx * VIA.passo, cz = bz * VIA.passo;
      if (Math.abs(cx) > meio || Math.abs(cz) > meio) continue;
      if ((bx + bz) % 6 === 0) continue;                        // praça
      const torres = 1 + Math.floor(rnd() * 3);                 // 1..3 torres por quarteirão
      for (let k = 0; k < torres; k++) {
        // Quarteirão de 40 m: a rua ocupa ~10 m de cada lado, então o miolo livre
        // é ±14 m em torno do centro — o prédio (lado ≤ 9,5 m) cabe com folga.
        const ox = (rnd() - 0.5) * 9, oz = (rnd() - 0.5) * 9;
        const lado = 4.6 + rnd() * 4.8;
        // Altura contida: torre de 50 m a 15 m de distância vira parede e engole o
        // quadro. O centro da cidade é mais alto, as bordas mais baixas.
        const central = Math.max(0, 1 - Math.hypot(cx, cz) / 190);
        const h = 7 + rnd() * 15 + central * (6 + rnd() * 13);
        const tint = 0.05 + rnd() * 0.07;
        const r = 0.20 + tint, g = 0.27 + tint * 1.2, b = 0.36 + tint * 1.4;
        // Pódio: base mais larga e baixa por baixo da torre — quebra a "parede" de
        // retângulos iguais e dá leitura de prédio (base, corpo, telhado).
        out.push(cx + ox, cz + oz, h * 0.22, lado * 1.28, r * 0.86, g * 0.86, b * 0.86, 1);
        out.push(cx + ox, cz + oz, h, lado, r, g, b, 1);
        if (rnd() > 0.55) out.push(cx + ox + 2.4, cz + oz - 2.2, h * 0.3, 2.0, 0.35, 0.16, 0.28, 1);  // anexo térreo
        if (rnd() > 0.8) out.push(cx + ox - 0.8, cz + oz + 0.8, h + 3, 1.6, 0.42, 0.46, 0.52, 1);    // torre de telhado
      }
    }
  }
  return { data: new Float32Array(out), half: meio };
}

/**
 * Direção de visão a partir de `yaw`/`pitch` — uma fonte só para os dois caminhos.
 * `yaw` gira no plano XZ (0 = +Z), `pitch` sobe/desce (negativo = olhando para baixo).
 */
export function direcaoVisao(yaw, pitch) {
  const cp = Math.cos(pitch);
  return [Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp];
}

/** Composição inicial: plano de diorama, fora do quarteirão, olhando para o centro. */
export const CAMERA_INICIAL = { x: VIA.centro, y: 5, z: 210, yaw: Math.PI, pitch: -0.02, speed: 34 };

/**
 * Seleciona o que o modo software desenha: os mais PRÓXIMOS, dentro do alcance da
 * névoa, devolvidos em ordem longe → perto (a ordem do algoritmo do pintor).
 *
 * Função pura e exportada de propósito: a primeira versão ordenava longe → perto e
 * cortava os primeiros N, o que escolhia justamente os prédios mais distantes — e o
 * quadro saía inteiro na cor da névoa. O teste verifica essa escolha sem GPU.
 *
 * @returns {{indices: number[], descartados: number}}
 */
export function selecionarProximos(instData, total, camX, camZ, teto = TETO_SOFTWARE, alcance = NEVOA.fim + 90) {
  const limite = alcance * alcance;
  const perto = [];
  for (let i = 0; i < total; i++) {
    const o = i * 8;
    const dx = instData[o] - camX, dz = instData[o + 1] - camZ;
    const d2 = dx * dx + dz * dz;
    if (d2 > limite) continue;
    perto.push([d2, i]);
  }
  perto.sort((a, b) => a[0] - b[0]);                 // perto → longe
  const fim = Math.min(perto.length, Math.max(0, teto | 0));
  const indices = [];
  for (let k = fim - 1; k >= 0; k--) indices.push(perto[k][1]);   // longe → perto
  return { indices, descartados: perto.length - fim };
}

export function createGame({ canvas, engine, settings, os, toast, camera = null, tetoSoftware = TETO_SOFTWARE }) {
  const frames = new Histogram(120);
  let running = true;
  let scale = settings.renderScale;
  let entities = 0;
  let instances = 0;
  let drawCalls = 0;
  let descartados = 0;   // objetos visíveis que o teto do modo software deixou de fora
  let last = performance.now();
  let lastStamp = last;
  let backendMotivo = '';
  let erroFatal = '';

  const MAX_INSTANCES = 8192;
  const instData = new Float32Array(MAX_INSTANCES * 8);   // x,z,h,w + rgba
  const citySeed = 0x51c7;
  const buildings = buildCity(citySeed, 250);
  const cubo = makeCubeData();
  const view = new Float32Array(16), proj = new Float32Array(16), vp = new Float32Array(16);
  const clip = new Float32Array(4);
  const cam = { ...CAMERA_INICIAL, ...(camera || {}) };
  const keys = new Set();

  const hudLine = el('div', { class: 'lbl', style: { padding: '6px 10px' } }, 'iniciando…');
  const aviso = el('div', { class: 'lbl', style: { padding: '0 10px 6px', color: '#ffcf5a', display: 'none' } });
  const wrap = el('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', flex: '1 1 auto', minHeight: '0' } }, canvas, hudLine, aviso);
  canvas.style.cssText = 'flex:1;width:100%;min-height:0;display:block;background:#01040a;outline:none';
  canvas.tabIndex = 0;

  canvas.addEventListener('pointerdown', e => {
    canvas.focus();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* contexto sem ponteiro */ }
    const move = ev => {
      cam.yaw -= ev.movementX * 0.0032;
      cam.pitch = clamp(cam.pitch - ev.movementY * 0.0026, -1.15, 0.5);
    };
    const up = () => { canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
  });
  canvas.addEventListener('keydown', e => { keys.add(e.code); if (e.code.startsWith('Arrow')) e.preventDefault(); });
  canvas.addEventListener('keyup', e => keys.delete(e.code));
  canvas.addEventListener('blur', () => keys.clear());

  // ============================================================== WebGL2 =======
  /** @returns {{ok: true, gl: object, rec: object}|{ok: false, motivo: string}} */
  function iniciarGl() {
    let gl;
    try {
      gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
    } catch (e) {
      return { ok: false, motivo: `getContext('webgl2') lançou: ${String(e?.message || e)}` };
    }
    if (!gl) return { ok: false, motivo: 'WebGL2 indisponível neste contexto (sem GPU, ou bloqueado no iframe)' };
    try {
      const rec = {
        cube: subirBuffer(gl, cubo.vertices, gl.STATIC_DRAW),
        ground: subirBuffer(gl, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW, 6),
        scene: compilarPrograma(gl, VS_SCENE, FS_SCENE),
        groundProg: compilarPrograma(gl, VS_GROUND, FS_GROUND),
        instBuf: gl.createBuffer()
      };
      gl.bindBuffer(gl.ARRAY_BUFFER, rec.instBuf);
      gl.bufferData(gl.ARRAY_BUFFER, instData.byteLength, gl.DYNAMIC_DRAW);
      // Um contexto que já chega com erro (driver bloqueado, contexto perdido) não
      // pode virar tela preta silenciosa: vira motivo declarado e modo software.
      const erro = gl.getError();
      if (erro !== gl.NO_ERROR) return { ok: false, motivo: `contexto WebGL2 com erro ${erro} na inicialização` };
      return { ok: true, gl, rec };
    } catch (e) {
      return { ok: false, motivo: `shaders/GL falharam: ${String(e?.message || e)}` };
    }
  }

  function subirBuffer(gl, dados, uso, count = null) {
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, dados, uso);
    return { buf, count: count ?? dados.length / 6 };
  }

  function compilarPrograma(gl, vsSrc, fsSrc) {
    const prog = gl.createProgram();
    const vs = compilarShader(gl, gl.VERTEX_SHADER, vsSrc);
    const fs = compilarShader(gl, gl.FRAGMENT_SHADER, fsSrc);
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link falhou');
    gl.deleteShader(vs); gl.deleteShader(fs);
    // Localização de uniform memoizada: o Proxy devolve o mesmo objeto nas chamadas
    // seguintes, então o caminho quente do quadro não aloca (contrato do módulo).
    const cache = {};
    prog.u = new Proxy(cache, {
      get: (alvo, nome) => {
        const chave = String(nome);
        if (!(chave in alvo)) alvo[chave] = gl.getUniformLocation(prog, chave);
        return alvo[chave];
      }
    });
    return prog;
  }

  function compilarShader(gl, tipo, fonte) {
    const sh = gl.createShader(tipo);
    gl.shaderSource(sh, fonte); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'compilação falhou');
    return sh;
  }

  const tentativaGl = iniciarGl();
  const gl = tentativaGl.ok ? tentativaGl.gl : null;
  const rec = tentativaGl.ok ? tentativaGl.rec : null;
  const backend = gl ? 'webgl2' : 'software';
  if (!tentativaGl.ok) backendMotivo = tentativaGl.motivo;

  // ============================================================ software 2D ====
  let ctx2d = null;
  if (!gl) {
    try { ctx2d = canvas.getContext('2d'); } catch { ctx2d = null; }
    if (!ctx2d) {
      erroFatal = `sem WebGL2 (${backendMotivo}) e sem canvas 2D neste contexto`;
      aviso.style.display = '';
      aviso.textContent = erroFatal;
    }
  }

  // =============================================================== câmera =====
  function resize() {
    const rect = canvas.getBoundingClientRect?.() || { width: 800, height: 560 };
    const dpr = Math.min((globalThis.devicePixelRatio || 1), 2);
    const w = Math.max(64, Math.floor((rect.width || 800) * dpr * scale));
    const h = Math.max(64, Math.floor((rect.height || 560) * dpr * scale));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  function simulate(dt) {
    const fwd = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    const side = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    const spin = (keys.has('ArrowLeft') ? 1 : 0) - (keys.has('ArrowRight') ? 1 : 0);
    cam.yaw += spin * dt * 1.6;
    const sp = cam.speed * dt * (keys.has('ShiftLeft') ? 2.4 : 1);
    cam.x += Math.sin(cam.yaw) * fwd * sp + Math.cos(cam.yaw) * side * sp;
    cam.z += Math.cos(cam.yaw) * fwd * sp - Math.sin(cam.yaw) * side * sp;
    if (!keys.size) cam.y = CAMERA_INICIAL.y + Math.sin(performance.now() / 3200) * 1.2;
  }

  function calcularVp() {
    const aspecto = canvas.width / Math.max(1, canvas.height);
    perspective(proj, 1.0, aspecto, 0.4, 1800);
    const [dx, dy, dz] = direcaoVisao(cam.yaw, cam.pitch);
    lookAt(view, [cam.x, cam.y, cam.z], [cam.x + dx * 120, cam.y + dy * 120, cam.z + dz * 120], [0, 1, 0]);
    multiply(vp, proj, view);
  }

  /**
   * Buffer de instâncias reutilizado (zero alocação por quadro):
   * [0..3] = x, z, altura, largura   [4..7] = r, g, b, a
   * Cidade primeiro (geometria estática), depois o tráfego do `w-engine`.
   */
  function fillInstances() {
    const base = buildings.data;
    const baseFloats = Math.min(base.length, instData.length);
    instData.set(base.subarray(0, baseFloats), 0);
    let count = baseFloats / 8;

    const n = engine.readEntities();
    if (n > 0) {
      const src = engine.scratch;
      const capacity = (instData.length / 8) - count;
      const cars = Math.min(n, capacity, settings.entities || 0);
      // O worker publica 8 campos por entidade: [x, z, 0, vx, 0, vz, velocidade, tipo].
      for (let i = 0; i < cars; i++) {
        const si = i * 8;
        const idx = (count + i) * 8;
        instData[idx] = src[si];
        instData[idx + 1] = src[si + 1];
        instData[idx + 2] = 1.15;      // altura do veículo
        instData[idx + 3] = 1.5;       // largura do veículo
        const kind = src[si + 7];
        if (kind < 0.5) { instData[idx + 4] = 0.95; instData[idx + 5] = 0.72; instData[idx + 6] = 0.18; }        // táxi
        else if (kind < 1.5) { instData[idx + 4] = 0.85; instData[idx + 5] = 0.26; instData[idx + 6] = 0.32; }   // civil
        else { instData[idx + 4] = 0.30; instData[idx + 5] = 0.75; instData[idx + 6] = 0.92; }                   // policial
        instData[idx + 7] = 1;
      }
      count += cars;
    }
    return count | 0;
  }

  // ======================================================== desenho: WebGL2 ====
  function desenharGl() {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(CEU_RGB[0], CEU_RGB[1], CEU_RGB[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);                 // contrato explícito com makeCubeData()

    gl.useProgram(rec.groundProg);
    gl.uniformMatrix4fv(rec.groundProg.u.uVP, false, vp);
    gl.uniform1f(rec.groundProg.u.uScale, CHAO_LADO / 2);
    gl.uniform3f(rec.groundProg.u.uFogCor, NEVOA_RGB[0], NEVOA_RGB[1], NEVOA_RGB[2]);
    gl.uniform2f(rec.groundProg.u.uFog, NEVOA.inicio, NEVOA.fim);
    gl.bindBuffer(gl.ARRAY_BUFFER, rec.ground.buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, rec.ground.count);

    gl.useProgram(rec.scene);
    gl.uniformMatrix4fv(rec.scene.u.uVP, false, vp);
    gl.uniform3f(rec.scene.u.uSun, SOL[0], SOL[1], SOL[2]);
    gl.uniform3f(rec.scene.u.uFogCor, NEVOA_RGB[0], NEVOA_RGB[1], NEVOA_RGB[2]);
    gl.uniform2f(rec.scene.u.uFog, NEVOA.inicio, NEVOA.fim);
    gl.uniform1i(rec.scene.u.uShadows, settings.shadows ? 1 : 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, rec.cube.buf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindBuffer(gl.ARRAY_BUFFER, rec.instBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, instData, 0, instances * 8);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 0); gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 32, 16); gl.vertexAttribDivisor(3, 1);
    if (instances) gl.drawArraysInstanced(gl.TRIANGLES, 0, rec.cube.count, instances);
    drawCalls = 2;
    const erro = gl.getError();
    if (erro !== gl.NO_ERROR) throw new Error(`WebGL2 reportou erro ${erro} durante o desenho`);
  }

  // ====================================================== desenho: software ===
  /**
   * Espaço de clipe. `wMin` é o plano de corte próximo: qualquer vértice com
   * `w <= wMin` está atrás (ou quase colado) da câmera e o polígono precisa ser
   * recortado — descartar a face inteira, como a primeira versão fazia, é o que
   * transformava prédio vizinho em nada.
   */
  const W_MIN = 0.4;

  /** Projeta (x,y,z) do mundo para o espaço de clipe em `clip`. */
  function paraClipe(x, y, z) {
    clip[0] = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
    clip[1] = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
    clip[2] = vp[2] * x + vp[6] * y + vp[10] * z + vp[14];
    clip[3] = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
    return clip;
  }

  const paraTela = c => [((c[0] / c[3]) * 0.5 + 0.5) * canvas.width, (0.5 - (c[1] / c[3]) * 0.5) * canvas.height];

  /**
   * Sutherland–Hodgman contra o plano `w = wMin`, em espaço de clipe (linear e
   * exato). Devolve uma lista de vértices `[x,y,z,w]`; vazia = totalmente atrás.
   */
  function recortarProximo(pontos) {
    const saida = [];
    for (let i = 0; i < pontos.length; i++) {
      const a = pontos[i], b = pontos[(i + 1) % pontos.length];
      const dentroA = a[3] > W_MIN, dentroB = b[3] > W_MIN;
      if (dentroA) saida.push(a);
      if (dentroA !== dentroB) {
        const t = (W_MIN - a[3]) / (b[3] - a[3]);
        saida.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, W_MIN]);
      }
    }
    return saida;
  }

  /** Recorta um segmento contra o plano próximo e devolve os dois extremos em tela. */
  function linhaEmTela(a, b) {
    let ca = paraClipe(a[0], a[1], a[2]);
    const va = [ca[0], ca[1], ca[2], ca[3]];
    ca = paraClipe(b[0], b[1], b[2]);
    const vb = [ca[0], ca[1], ca[2], ca[3]];
    if (va[3] <= W_MIN && vb[3] <= W_MIN) return null;
    if (va[3] <= W_MIN) {
      const t = (W_MIN - va[3]) / (vb[3] - va[3]);
      va[0] += (vb[0] - va[0]) * t; va[1] += (vb[1] - va[1]) * t; va[2] += (vb[2] - va[2]) * t; va[3] = W_MIN;
    }
    if (vb[3] <= W_MIN) {
      const t = (W_MIN - vb[3]) / (va[3] - vb[3]);
      vb[0] += (va[0] - vb[0]) * t; vb[1] += (va[1] - vb[1]) * t; vb[2] += (va[2] - vb[2]) * t; vb[3] = W_MIN;
    }
    return [paraTela(va), paraTela(vb)];
  }

  /** Fator de névoa linear — o MESMO do shader (NEVOA). */
  const fatorNevoa = dist => clamp((dist - NEVOA.inicio) / Math.max(1, NEVOA.fim - NEVOA.inicio), 0, 1);

  const canal = (valor, peso, i) => {
    const v = valor * (1 - peso) + NEVOA_RGB[i] * peso;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  };
  /** Mistura `origem` com `destino` (0..1) e devolve canal 0..255. */
  const canalEntre = (origem, destino, t, i) =>
    Math.max(0, Math.min(255, Math.round((origem[i] * (1 - t) + destino[i] * t) * 255)));

  function desenharSoftware() {
    const cor = ctx2d;
    if (!cor) return;
    const W = canvas.width, H = canvas.height;
    cor.setTransform?.(1, 0, 0, 1, 0, 0);
    // Céu com o MESMO gradiente do shader (zênite → horizonte), em bandas: poucas
    // faixas custam quase nada e evitam o fundo chapado que lia como "tela preta".
    cor.fillStyle = rgbParaCss(CEU_RGB);
    cor.fillRect(0, 0, W, H);
    const [dxh, , dzh] = direcaoVisao(cam.yaw, 0);
    const ch = paraClipe(cam.x + dxh * 900, 0, cam.z + dzh * 900);
    const yHorizonte = ch[3] > W_MIN
      ? clamp((0.5 - (ch[1] / ch[3]) * 0.5) * H, 0, H)
      : H * 0.5;
    const faixas = 18;
    for (let b = 0; b < faixas; b++) {
      const t = (b + 0.5) / faixas;
      const curva = Math.pow(1 - t, 2.2);
      cor.fillStyle = `rgb(${canalEntre(HORIZONTE_RGB, CEU_RGB, curva, 0)},${canalEntre(HORIZONTE_RGB, CEU_RGB, curva, 1)},${canalEntre(HORIZONTE_RGB, CEU_RGB, curva, 2)})`;
      cor.fillRect(0, Math.floor(H * b / faixas), W, Math.ceil(H / faixas) + 1);
    }
    void yHorizonte;
    drawCalls = 0;

    desenharChao(cor);
    if (!instances) return;

    // Quem entra no quadro (e em que ordem) é decisão testável em `selecionarProximos`:
    // os mais próximos, desenhados de trás para frente. O teto existe para caber no
    // orçamento do quadro; quem sobra são os distantes, e isso é declarado na linha
    // de estado — nunca escondido.
    const escolha = selecionarProximos(instData, instances, cam.x, cam.z, tetoSoftware);
    descartados = escolha.descartados;
    for (const indice of escolha.indices) projetarCaixa(cor, indice);
  }

  function projetarCaixa(cor, indice) {
    const o = indice * 8;
    const ix = instData[o], iz = instData[o + 1], h = instData[o + 2], w = instData[o + 3];
    const r = instData[o + 4], g = instData[o + 5], b = instData[o + 6];
    const cx = ix, cy = h / 2, cz = iz;
    const dist = Math.hypot(cx - cam.x, cy - cam.y, cz - cam.z);
    const nevoa = fatorNevoa(dist);
    if (dist > NEVOA.fim + 90) return;                 // além da névoa, não é desenhado

    for (const face of cubo.facesVisiveis) {
      const n = face.normal;
      const paraOlho = [cam.x - cx, cam.y - cy, cam.z - cz];
      // Mesmo critério do CULL_FACE, invertido: aqui ESCOLHEMOS as faces que
      // apontam para a câmera (produto escalar positivo significa frente).
      if (n[0] * paraOlho[0] + n[1] * paraOlho[1] + n[2] * paraOlho[2] <= 0) continue;

      const bruto = [];
      for (const p of face.quad) {
        const c = paraClipe(ix + p[0] * w, p[1] * h, iz + p[2] * w);
        bruto.push([c[0], c[1], c[2], c[3]]);
      }
      const recortado = recortarProximo(bruto);
      if (recortado.length < 3) continue;

      const difusa = Math.max(0, n[0] * SOL[0] + n[1] * SOL[1] + n[2] * SOL[2]);
      let banda = 0.62 + 0.38 * difusa;
      if (settings.shadows) banda *= 0.74 + 0.26 * Math.min(1, difusa / 0.35);
      const peso = nevoa;
      const piso = 1 - NEVOA.piso;                     // mesma fórmula do shader
      const tom = banda * (1 - peso) + piso * peso;
      cor.fillStyle = `rgb(${canal(r, tom, 0)},${canal(g, tom, 1)},${canal(b, tom, 2)})`;
      const tela = recortado.map(paraTela);
      cor.beginPath();
      cor.moveTo(tela[0][0], tela[0][1]);
      for (let i = 1; i < tela.length; i++) cor.lineTo(tela[i][0], tela[i][1]);
      cor.closePath();
      cor.fill();
      drawCalls++;
    }
  }

  /** Chão: quadrilátero preenchido + grade projetada (mesmo espaçamento do shader). */
  function desenharChao(cor) {
    const meia = CHAO_LADO / 2;
    const cantos = [[-meia, 0, -meia], [meia, 0, -meia], [meia, 0, meia], [-meia, 0, meia]];
    const bruto = cantos.map(([x, y, z]) => { const c = paraClipe(x, y, z); return [c[0], c[1], c[2], c[3]]; });
    const recortado = recortarProximo(bruto);
    if (recortado.length >= 3) {
      const tela = recortado.map(paraTela);
      cor.fillStyle = rgbParaCss([0.030, 0.048, 0.070]);
      cor.beginPath();
      cor.moveTo(tela[0][0], tela[0][1]);
      for (let i = 1; i < tela.length; i++) cor.lineTo(tela[i][0], tela[i][1]);
      cor.closePath();
      cor.fill();
      drawCalls++;
    }

    const limite = meia - 6, passo = 12;
    cor.lineWidth = Math.max(1, Math.round(Math.min(canvas.width, canvas.height) / 900));
    cor.strokeStyle = 'rgba(26,120,144,0.55)';
    cor.beginPath();
    for (let v = -limite; v <= limite; v += passo) {
      const a1 = linhaEmTela([v, 0, -limite], [v, 0, limite]);
      if (a1) { cor.moveTo(a1[0][0], a1[0][1]); cor.lineTo(a1[1][0], a1[1][1]); }
      const a2 = linhaEmTela([-limite, 0, v], [limite, 0, v]);
      if (a2) { cor.moveTo(a2[0][0], a2[0][1]); cor.lineTo(a2[1][0], a2[1][1]); }
    }
    cor.stroke();
    drawCalls++;
  }

  const rgbParaCss = ([r, g, b]) => `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;

  // ================================================================ quadro =====
  function rotuloBackend() {
    if (erroFatal) return 'SEM DESENHO';
    return backend === 'webgl2' ? 'WEBGL2' : 'SOFTWARE 2D';
  }

  function frame() {
    if (!running) return;
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    try {
      resize();
      if (settings.drs) {
        const p95 = frames.percentile(95);
        if (Number.isFinite(p95) && p95 > 18 && scale > 0.45) scale = Math.max(0.45, scale - 0.04);
        else if (Number.isFinite(p95) && p95 < 8.5 && scale < settings.renderScale) scale = Math.min(settings.renderScale, scale + 0.02);
      } else scale = settings.renderScale;

      simulate(dt);
      instances = fillInstances();
      calcularVp();

      if (gl) desenharGl();
      else if (ctx2d) desenharSoftware();
      else instances = 0;

      const cost = performance.now() - now;
      frames.push(cost);
      const fps = 1000 / Math.max(1, now - lastStamp);
      lastStamp = now;
      entities = engine.entityCount;

      hudLine.textContent = `${rotuloBackend()} · ${fmtInt(instances)} instâncias · ${fmtInt(drawCalls)} desenhos · `
        + `${fmt1(cost)} ms render · ${fmtInt(fps)} fps · escala ${scale.toFixed(2)}×`
        + (settings.drs ? ' · DRS ativo' : '')
        + ` · tráfego ${fmtInt(entities)} (w-engine)`
        + (descartados ? ` · ${fmtInt(descartados)} volumes acima do teto` : '');
      os?.reportGame?.({ renderMs: cost, instances, entities, scale, fps, backend, motivo: backendMotivo, erro: erroFatal });
    } catch (e) {
      // Falha em quadro nunca é silenciosa: para o laço e mostra o motivo na janela.
      running = false;
      erroFatal = String(e?.message || e);
      hudLine.textContent = `${rotuloBackend()} · laço interrompido`;
      aviso.style.display = '';
      aviso.textContent = `desenho interrompido: ${erroFatal}${backendMotivo ? ` — antes disso: ${backendMotivo}` : ''}`;
      toast?.err?.('Cidade: desenho interrompido', erroFatal);
      return;
    }

    const budget = settings.fpsCap;
    if (budget > 0 && budget < 240) setTimeout(() => rAF(frame), Math.max(0, 1000 / budget - (performance.now() - now)));
    else rAF(frame);
  }
  const rAF = cb => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : setTimeout(cb, 16));

  if (!engine.available) {
    aviso.style.display = '';
    aviso.textContent = `motor indisponível: ${engine.unavailableReason}. A cena da cidade continua desenhada, `
      + 'mas não há tráfego simulado — nenhum veículo é inventado para preencher a tela.';
  } else if (backend === 'software' && !erroFatal) {
    aviso.style.display = '';
    aviso.textContent = `modo software (canvas 2D): ${backendMotivo}. Mesma cena e mesmo tráfego; `
      + `sem z-buffer, no máximo ${TETO_SOFTWARE} objetos por quadro, do mais distante ao mais próximo.`;
  }

  resize();
  frame();

  return {
    el: wrap,
    onResize() { resize(); },
    onClose() { running = false; },
    get backend() { return backend; },
    get backendMotivo() { return backendMotivo; },
    get erro() { return erroFatal; },
    get stats() { return { instances, entities, drs: scale, backend, drawCalls, descartados, erro: erroFatal }; }
  };
}
