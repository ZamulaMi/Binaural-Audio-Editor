import { SR, TAU } from "./util.js";
import { buffers, newProject, addTrack, usedBufIds } from "./state.js";
import { uid } from "./util.js";

/* Демо-інструменти синтезуються в браузері, тож проєкт не потребує аудіофайлів. */
const BPM = 96, BEAT = 60 / BPM, BAR = BEAT * 4, BARS = 8;
export const DEMO_LEN = BAR * BARS; // 20 с
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 * 2 - 1; };
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
const PROG = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
const newBuf = () => new Float32Array(Math.round(DEMO_LEN * SR));

function toAudio(data) {
  let pk = 0;
  for (let i = 0; i < data.length; i++) pk = Math.max(pk, Math.abs(data[i]));
  const k = pk > 0 ? 0.8 / pk : 1;
  for (let i = 0; i < data.length; i++) data[i] *= k;
  const b = new AudioBuffer({ length: data.length, numberOfChannels: 1, sampleRate: SR });
  b.copyToChannel(data, 0);
  return b;
}
function drums() {
  const o = newBuf();
  const kick = t => { const s = Math.round(t * SR); let ph = 0; for (let i = 0; i < 0.45 * SR && s + i < o.length; i++) { const tt = i / SR; ph += TAU * (45 + 85 * Math.exp(-tt * 30)) / SR; o[s + i] += Math.sin(ph) * Math.exp(-tt * 7) + (i < 80 ? rnd() * 0.25 * (1 - i / 80) : 0); } };
  const snare = t => { const s = Math.round(t * SR); let pv = 0; for (let i = 0; i < 0.3 * SR && s + i < o.length; i++) { const tt = i / SR, n = rnd(), hp = n - pv; pv = n; o[s + i] += hp * 0.45 * Math.exp(-tt * 15) + Math.sin(TAU * 185 * tt) * 0.45 * Math.exp(-tt * 28); } };
  const hat = (t, a, dec) => { const s = Math.round(t * SR); let p1 = 0, p2 = 0; for (let i = 0; i < 0.3 * SR && s + i < o.length; i++) { const tt = i / SR, n = rnd(), h1 = n - p1, h2 = h1 - p2; p1 = n; p2 = h1; o[s + i] += h2 * a * Math.exp(-tt / dec); } };
  for (let b = 0; b < BARS; b++) {
    const b0 = b * BAR;
    [0, 2, 2.5].forEach(x => kick(b0 + x * BEAT));
    [1, 3].forEach(x => snare(b0 + x * BEAT));
    for (let i = 0; i < 8; i++) hat(b0 + i * BEAT / 2, i % 2 ? 0.16 : 0.1, i === 7 ? 0.16 : 0.035);
  }
  return o;
}
function bass() {
  const o = newBuf(), pat = [0, 0, 12, 0, 0, 12, 7, 0];
  for (let b = 0; b < BARS; b++) {
    const root = PROG[b % 4][0] - 24;
    for (let i = 0; i < 8; i++) {
      const f = mtof(root + pat[i]), s = Math.round((b * BAR + i * BEAT / 2) * SR), n = Math.round(BEAT / 2 * SR * 0.95);
      let ph = 0, lp = 0;
      for (let j = 0; j < n && s + j < o.length; j++) {
        const tt = j / SR; ph = (ph + f / SR) % 1;
        const env = Math.min(1, j / 120) * Math.exp(-tt * 3.5) * (j > n - 200 ? (n - j) / 200 : 1);
        const a = 1 - Math.exp(-TAU * (250 + 1400 * Math.exp(-tt * 18)) / SR);
        lp += a * ((2 * ph - 1) - lp); o[s + j] += lp * env;
      }
    }
  }
  return o;
}
function pad() {
  const o = newBuf(), det = [-0.11, 0, 0.12];
  for (let b = 0; b < BARS; b++) {
    const s = Math.round(b * BAR * SR), n = Math.round((BAR + 0.7) * SR);
    PROG[b % 4].forEach(m => det.forEach(d => {
      const f = mtof(m + d), a = 1 - Math.exp(-TAU * 1100 / SR);
      let ph = (m * 0.137 + d) % 1, lp = 0;
      for (let j = 0; j < n && s + j < o.length; j++) {
        const tt = j / SR; ph = (ph + f / SR) % 1;
        const env = Math.min(1, tt / 0.5) * (tt > BAR ? Math.max(0, 1 - (tt - BAR) / 0.7) : 1);
        lp += a * ((2 * ph - 1) - lp); o[s + j] += lp * env * 0.2;
      }
    }));
  }
  return o;
}
function pluck() {
  const o = newBuf();
  for (let b = 0; b < BARS; b++) {
    const ch = PROG[b % 4];
    for (let i = 0; i < 16; i++) {
      if (i % 4 === 3 && b % 2) continue;
      const m = ch[[0, 1, 2, 1][i % 4]] + 12 + (Math.floor(i / 4) % 2 ? 12 : 0);
      const N = Math.round(SR / mtof(m)), ring = new Float32Array(N);
      for (let k = 0; k < N; k++) ring[k] = rnd();
      const s = Math.round((b * BAR + i * BEAT / 4) * SR);
      let k = 0;
      for (let j = 0; j < 0.7 * SR && s + j < o.length; j++) {
        const y = ring[k], nk = (k + 1) % N;
        ring[k] = (ring[k] + ring[nk]) * 0.4975; k = nk;
        o[s + j] += y * (i % 4 === 0 ? 0.6 : 0.4);
      }
    }
  }
  return o;
}
function shaker() {
  const o = newBuf();
  for (let i = 0; i < BARS * 16; i++) {
    const s = Math.round(i * BEAT / 4 * SR), amp = i % 2 ? 0.5 : 0.28;
    let p1 = 0, p2 = 0;
    for (let j = 0; j < 0.12 * SR && s + j < o.length; j++) {
      const tt = j / SR, n = rnd(), h1 = n - p1, h2 = h1 - p2; p1 = n; p2 = h1;
      o[s + j] += h2 * amp * Math.min(1, tt / 0.012) * Math.exp(-tt / 0.03);
    }
  }
  return o;
}
function bell() {
  const o = newBuf(), parts = [[1, 1, 3.2], [2.76, 0.55, 2], [5.4, 0.35, 1.1], [8.93, 0.2, 0.6]];
  [[0, 76], [2, 71], [4, 76], [6, 74], [7.5, 79]].forEach(([bar, m]) => {
    const s = Math.round(bar * BAR * SR), f = mtof(m);
    for (let j = 0; j < 4 * SR && s + j < o.length; j++) {
      const tt = j / SR;
      let v = 0;
      for (const [r, a, d] of parts) v += Math.sin(TAU * f * r * tt) * a * Math.exp(-tt / d);
      o[s + j] += v * Math.min(1, j / 40);
    }
  });
  return o;
}
const GEN = { drums, bass, pad, pluck, shaker, bell };

/** Генерує демо-буфери, на які посилається проєкт (ідентифікатори `demo:*`). */
export function ensureDemoBuffers(p) {
  for (const id of usedBufIds(p)) {
    if (!id.startsWith("demo:") || buffers.has(id)) continue;
    const g = GEN[id.slice(5)];
    if (g) { seed = 7 + id.length; buffers.set(id, toAudio(g())); }
  }
}

export function demoProject() {
  const p = newProject("Демо: концертний зал");
  Object.assign(p, { room: "hall", wet: 0.24 });
  p.obstacles.push({ x1: -10, z1: 6, x2: -2, z2: 6, mat: "concrete" });
  const clip = (buf, start, name) => ({ id: uid(), buf: "demo:" + buf, start, offset: 0, dur: DEMO_LEN, name });
  addTrack({ name: "Барабани", x: 0, z: -5.5, y: 0, vol: 2, clips: [clip("drums", 0, "Біт"), clip("drums", DEMO_LEN, "Біт")] }, p);
  addTrack({ name: "Бас", x: -4, z: -4, y: -0.4, vol: 0, clips: [clip("bass", 0, "Бас"), clip("bass", DEMO_LEN, "Бас")] }, p);
  addTrack({ name: "Гітара", x: 4, z: -2.5, y: 0.1, vol: -3, clips: [clip("pluck", 0, "Арпеджіо"), clip("pluck", DEMO_LEN, "Арпеджіо")] }, p);
  addTrack({ name: "Пад", x: 6, z: 5, y: 1.2, vol: -5, send: 0.8, clips: [clip("pad", 0, "Акорди"), clip("pad", DEMO_LEN, "Акорди")] }, p);
  addTrack({ name: "Шейкер", x: -2.2, z: 1.2, y: 0.3, vol: -8, motion: { type: "orbit", period: 9 }, clips: [clip("shaker", DEMO_LEN, "Шейкер")] }, p);
  addTrack({ name: "Дзвін за стіною", x: -6, z: 9.5, y: 3, vol: -2, send: 0.9, clips: [clip("bell", 0, "Дзвін")] }, p);
  p.loop = { on: false, a: 0, b: DEMO_LEN };
  return p;
}
