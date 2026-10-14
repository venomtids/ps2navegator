/**
 * SECTOR OS — apps/game.js
 * Janela "Cidade" — renderizador WebGL2 de mundo aberto procedural, alimentado
 * pelo estado real do `w-engine` (snapshot lock-free) com tráfego simulado.
 *
 * Honestidade da fase (docs/00 §14, F3): este é o *pipeline*, não um AAA.
 *  - [B] render instanciado, câmera livre, DRS real, escala/teto de FPS reais;
 *  - [R] terreno por células, WebGPU compute, sombras CSM, física na GPU.
 * O botão de backend WebGPU fica desabilitado com o motivo visível — botão que
 * não faz nada é bug, não rascunho (Design System §6.8).
 */

import { el, clamp, Histogram, fmt1, fmtInt } from '../core/util.js';
import { perspective, lookAt, multiply, trs } from '../core/mat4.js';

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
uniform int uShadows;
void main(){
  float d = max(dot(normalize(vN), normalize(uSun)), 0.0);
  float band = 0.55 + 0.45 * d;
  vec3 col = vC * band;
  // sombra de contato barata (1 passe, sem CSM): escurece pelo eixo da luz
  if (uShadows == 1) {
    float s = smoothstep(0.0, 0.35, d);
    col *= mix(0.72, 1.0, s);
  }
  float fog = 1.0 - clamp(length(vW.xz) / 260.0, 0.0, 0.92);
  outColor = vec4(mix(vec3(0.02,0.04,0.07), col, fog), 1.0);
}`;

const VS_GROUND = `#version 300 es
layout(location=0) in vec2 aPos;
uniform mat4 uVP;
out vec2 vXZ;
void main(){
  vXZ = aPos * 400.0;
  gl_Position = uVP * vec4(vXZ.x, 0.0, vXZ.y, 1.0);
}`;

const FS_GROUND = `#version 300 es
precision highp float;
in vec2 vXZ;
out vec4 outColor;
void main(){
  vec2 g = abs(fract(vXZ / 12.0 - 0.5) - 0.5) / fwidth(vXZ / 12.0);
  float line = 1.0 - min(min(g.x, g.y), 1.0);
  vec3 base = vec3(0.035, 0.055, 0.08);
  vec3 col = mix(base, vec3(0.09, 0.42, 0.5), line * 0.7);
  float fade = 1.0 - clamp(length(vXZ) / 320.0, 0.0, 0.95);
  outColor = vec4(col * fade, 1.0);
}`;

export function createGame({ canvas, engine, settings, os, toast }) {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
  if (!gl) {
    return { el: el('div', { class: 'fm' }, el('div', { class: 'empty', text: 'WebGL2 indisponível neste navegador/dispositivo. O motor exige WebGL2 (ou WebGPU, na fase F3).' })) };
  }

  const frames = new Histogram(120);
  let running = true;
  let scale = settings.renderScale;
  let drs = settings.drs;
  let entities = 0;
  let instances = 0;
  let drawCalls = 0;
  let last = performance.now();
  let lastStamp = last;

  // ---- geometria ------------------------------------------------------
  const cube = makeCube(gl);
  const ground = makeGround(gl);
  const scene = link(VS_SCENE, FS_SCENE);
  const groundProg = link(VS_GROUND, FS_GROUND);

  const MAX_INSTANCES = 8192;
  const instData = new Float32Array(MAX_INSTANCES * 8);   // x,z,h,w + rgba
  const instBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
  gl.bufferData(gl.ARRAY_BUFFER, instData.byteLength, gl.DYNAMIC_DRAW);

  // Cidade procedural determinística (mesma semente = mesma cidade).
  const citySeed = 0x51c7;
  const buildings = buildCity(citySeed, 60);

  const view = new Float32Array(16), proj = new Float32Array(16), vp = new Float32Array(16);
  const cam = { x: 0, y: 14, z: 46, yaw: Math.PI, pitch: -0.28, speed: 22 };
  const keys = new Set();

  const hudLine = el('div', { class: 'lbl', style: { padding: '6px 10px' } });
  const wrap = el('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } }, canvas, hudLine);
  canvas.style.cssText = 'flex:1;width:100%;min-height:0;display:block;background:#01040a;outline:none';
  canvas.tabIndex = 0;

  canvas.addEventListener('pointerdown', e => {
    canvas.focus();
    canvas.setPointerCapture(e.pointerId);
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

  function link(vsSrc, fsSrc) {
    const prog = gl.createProgram();
    const vs = compile(gl.VERTEX_SHADER, vsSrc), fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.deleteShader(vs); gl.deleteShader(fs);
    prog.u = new Proxy({}, { get: (_, name) => gl.getUniformLocation(prog, String(name)) });
    return prog;
  }
  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  }
  function makeCube(gl) {
    const v = new Float32Array([
      -0.5, 0, -0.5, 0, 0, -1, 0.5, 0, -0.5, 0, 0, -1, 0.5, 1, -0.5, 0, 0, -1, -0.5, 1, -0.5, 0, 0, -1,
      0.5, 0, 0.5, 0, 0, 1, -0.5, 0, 0.5, 0, 0, 1, -0.5, 1, 0.5, 0, 0, 1, 0.5, 1, 0.5, 0, 0, 1,
      -0.5, 0, 0.5, -1, 0, 0, -0.5, 0, -0.5, -1, 0, 0, -0.5, 1, -0.5, -1, 0, 0, -0.5, 1, 0.5, -1, 0, 0,
      0.5, 0, -0.5, 1, 0, 0, 0.5, 0, 0.5, 1, 0, 0, 0.5, 1, 0.5, 1, 0, 0, 0.5, 1, -0.5, 1, 0, 0
    ]);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
    return { buf, count: 24 };
  }
  function makeGround(gl) {
    const quad = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    return { buf, count: 6 };
  }

  /** Cidade em grelha com ruas: determinística, sem assets externos. */
  function buildCity(seed, blocks) {
    const out = [];
    let s = seed >>> 0;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    const half = blocks * 6;
    for (let gx = -blocks / 2; gx < blocks / 2; gx++) {
      for (let gz = -blocks / 2; gz < blocks / 2; gz++) {
        if ((gx + gz) % 5 === 0 || gx % 7 === 3) continue;       // avenidas e praças
        const x = gx * 8 + 4, z = gz * 8 + 4;
        const h = 6 + rnd() * 26 + Math.max(0, 12 - Math.hypot(x, z) / 12) * 4;
        const tint = 0.05 + rnd() * 0.07;
        out.push(x, z, h, 3.2 + rnd() * 1.6, 0.16 + tint, 0.22 + tint * 1.2, 0.30 + tint * 1.4, 1);
        if (rnd() > 0.55) out.push(x + 2.4, z - 2.2, h * 0.45, 1.6, 0.35, 0.16, 0.28, 1);
      }
    }
    return { data: new Float32Array(out), half };
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(64, Math.floor(rect.width * dpr * scale));
    const h = Math.max(64, Math.floor(rect.height * dpr * scale));
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
    cam.y = 14 + Math.sin(performance.now() / 2600) * 0.6;
  }

  /**
   * Monta o buffer de instâncias reutilizado (zero alocação por quadro):
   * [0..3] = x, z, altura, largura   [4..7] = r, g, b, a
   * Cidade primeiro (geometria estática), depois o tráfego vindo do `w-engine`.
   */
  function fillInstances() {
    const base = buildings.data;
    const baseFloats = Math.min(base.length, instData.length);
    instData.set(base.subarray(0, baseFloats), 0);
    let count = baseFloats / 8;

    const n = engine.readEntities();   // snapshot lock-free (0 se instável)
    if (n > 0) {
      const src = engine.scratch;
      const capacity = (instData.length / 8) - count;
      const cars = Math.min(n, capacity, settings.entities || 0);
      for (let i = 0; i < cars; i++) {
        const si = i * 8 + 4;              // pula x,y,z,dx no snapshot
        const x = src[si - 4], z = src[si - 3];
        const kind = src[si + 3];
        const idx = (count + i) * 8;
        instData[idx] = x;
        instData[idx + 1] = z;
        instData[idx + 2] = 1.05;          // altura
        instData[idx + 3] = 1.35;          // largura (caixa do veículo)
        // paleta por tipo: 0 = táxi, 1 = civil, 2 = policial
        if (kind < 0.5) { instData[idx + 4] = 0.95; instData[idx + 5] = 0.72; instData[idx + 6] = 0.18; }
        else if (kind < 1.5) { instData[idx + 4] = 0.85; instData[idx + 5] = 0.26; instData[idx + 6] = 0.32; }
        else { instData[idx + 4] = 0.30; instData[idx + 5] = 0.75; instData[idx + 6] = 0.92; }
        instData[idx + 7] = 1;
      }
      count += cars;
    }
    return count | 0;
  }

  function frame() {
    if (!running) return;
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    resize();
    if (drs) {
      const p95 = frames.percentile(95);
      if (Number.isFinite(p95) && p95 > 18 && scale > 0.45) scale = Math.max(0.45, scale - 0.04);
      else if (Number.isFinite(p95) && p95 < 8.5 && scale < settings.renderScale) scale = Math.min(settings.renderScale, scale + 0.02);
    } else scale = settings.renderScale;

    simulate(dt);
    instances = fillInstances();

    const aspect = canvas.width / canvas.height;
    perspective(proj, 1.05, aspect, 0.3, 900);
    lookAt(view,
      [cam.x, cam.y, cam.z],
      [cam.x + Math.sin(cam.yaw) * 24, cam.y + cam.pitch * 22 - 6, cam.z + Math.cos(cam.yaw) * 24],
      [0, 1, 0]);
    multiply(vp, proj, view);

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.008, 0.016, 0.028, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);

    // chão procedural
    gl.useProgram(groundProg);
    gl.uniformMatrix4fv(groundProg.u.uVP, false, vp);
    gl.bindBuffer(gl.ARRAY_BUFFER, ground.buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, ground.count);

    // cena instanciada
    gl.useProgram(scene);
    gl.uniformMatrix4fv(scene.u.uVP, false, vp);
    gl.uniform3f(scene.u.uSun, 0.42, 0.86, 0.28);
    gl.uniform1i(scene.u.uShadows, settings.shadows ? 1 : 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, cube.buf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, instData, 0, instances * 8);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 0); gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 32, 16); gl.vertexAttribDivisor(3, 1);
    if (instances) gl.drawArraysInstanced(gl.TRIANGLES, 0, cube.count, instances);
    drawCalls = 2;

    const cost = performance.now() - now;
    frames.push(cost);
    const fps = 1000 / Math.max(1, now - lastStamp);
    lastStamp = now;
    entities = engine.entityCount;
    hudLine.textContent = `WEBGL2 · ${fmtInt(instances)} instâncias · ${drawCalls} draw calls · `
      + `${fmt1(cost)} ms render · ${fmtInt(fps)} fps · escala ${scale.toFixed(2)}×`
      + (drs ? ' · DRS ativo' : '')
      + ` · tráfego ${fmtInt(entities)} (w-engine)`;
    os.reportGame({ renderMs: cost, instances, entities, scale, fps });

    const budget = settings.fpsCap;
    if (budget > 0 && budget < 240) setTimeout(() => rAF(frame), Math.max(0, 1000 / budget - (performance.now() - now)));
    else rAF(frame);
  }
  const rAF = cb => requestAnimationFrame(cb);

  frame();

  return {
    el: wrap,
    onResize() { resize(); },
    onClose() { running = false; },
    get stats() { return { instances, entities, drs: scale }; }
  };
}
