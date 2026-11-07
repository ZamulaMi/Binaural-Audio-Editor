import { SR, clamp, dbToGain, C_SOUND } from "./util.js";
import { store, buffers, projectEnd, notify } from "./state.js";
import { ROOMS, params } from "./spatial.js";

/** Аудіодвигун: Web Audio граф, відтворення кліпів, просторова обробка, рендер. */
export const eng = { ctx: null, bus: null, t0: 0, startPos: 0 };
const chains = new Map();
const lastKey = new Map();
let metroNext = null;

export function ensureCtx() {
  if (eng.ctx) return eng.ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  try { eng.ctx = new AC({ sampleRate: SR, latencyHint: "interactive" }); } catch (e) { eng.ctx = new AC(); }
  eng.bus = buildBus(eng.ctx, eng.ctx.destination, store.p);
  return eng.ctx;
}
/** Поточна позиція транспорту, сек проєкту. */
export function now() {
  if (!store.playing || !eng.ctx) return store.playhead;
  return eng.startPos + Math.max(0, eng.ctx.currentTime - eng.t0);
}

/* ---------------- граф ---------------- */
function makeIR(c, R) {
  const len = Math.round((R.rt * 1.3 + 0.05) * c.sampleRate);
  const pre = Math.round(Math.min(0.035, R.W / C_SOUND / 3) * c.sampleRate);
  const ir = c.createBuffer(2, len + pre, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / c.sampleRate, a = clamp(0.95 * Math.exp(-t * 6000 / R.hf / R.rt), 0.04, 0.95);
      lp += a * (Math.random() * 2 - 1 - lp);
      d[i + pre] = lp * Math.exp(-6.9 * t / R.rt);
    }
  }
  return ir;
}
const isOffline = c => typeof OfflineAudioContext !== "undefined" && c instanceof OfflineAudioContext;

function buildBus(c, dest, p) {
  const input = c.createGain(), g = c.createGain(), lim = c.createDynamicsCompressor();
  g.gain.value = dbToGain(p.masterDb);
  lim.threshold.value = -2; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.12;
  input.connect(g).connect(lim).connect(dest);
  const rIn = c.createGain(), conv = c.createConvolver(), rRet = c.createGain();
  conv.buffer = makeIR(c, ROOMS[p.room]);
  rRet.gain.value = p.wet * 1.6;
  rIn.connect(conv).connect(rRet).connect(input);
  const out = { input, g, lim, rIn, conv, rRet };
  if (!isOffline(c)) {
    const sp = c.createChannelSplitter(2);
    out.aL = c.createAnalyser(); out.aR = c.createAnalyser();
    out.aL.fftSize = out.aR.fftSize = 1024;
    lim.connect(sp); sp.connect(out.aL, 0); sp.connect(out.aR, 1);
  }
  return out;
}
function mkPanner(c) {
  const p = c.createPanner();
  p.panningModel = "HRTF"; p.distanceModel = "inverse";
  p.refDistance = 1; p.maxDistance = 10000; p.rolloffFactor = 1;
  p.channelCount = 1; p.channelCountMode = "explicit";
  return p;
}
function buildChain(c, b) {
  const all = [], mk = x => (all.push(x), x);
  const n = { all, srcs: [] };
  n.fader = mk(c.createGain());
  n.low = mk(c.createBiquadFilter()); n.low.type = "lowshelf"; n.low.frequency.value = 220;
  n.mid = mk(c.createBiquadFilter()); n.mid.type = "peaking"; n.mid.frequency.value = 1400; n.mid.Q.value = 0.9;
  n.high = mk(c.createBiquadFilter()); n.high.type = "highshelf"; n.high.frequency.value = 5500;
  n.mute = mk(c.createGain());
  n.fader.connect(n.low).connect(n.mid).connect(n.high).connect(n.mute);
  // пряма хвиля: перешкоди → повітря → HRTF
  n.occ = mk(c.createBiquadFilter()); n.occ.type = "lowpass"; n.occ.Q.value = 0.5;
  n.occG = mk(c.createGain());
  n.air = mk(c.createBiquadFilter()); n.air.type = "lowpass"; n.air.Q.value = 0.5;
  n.pan = mk(mkPanner(c));
  n.sp = mk(c.createGain());
  n.mute.connect(n.occ).connect(n.occG).connect(n.air).connect(n.pan).connect(n.sp);
  // ранні відбиття: уявні джерела, кожне зі своїм HRTF
  n.reflLP = mk(c.createBiquadFilter()); n.reflLP.type = "lowpass";
  n.mute.connect(n.reflLP);
  n.refl = [];
  for (let i = 0; i < 6; i++) {
    const d = mk(c.createDelay(1)), g = mk(c.createGain()), p = mk(mkPanner(c));
    g.gain.value = 0;
    n.reflLP.connect(d).connect(g).connect(p).connect(n.sp);
    n.refl.push({ d, g, p });
  }
  n.sp.connect(b.input);
  // звичайне стерео
  n.st = mk(c.createStereoPanner()); n.stG = mk(c.createGain());
  n.mute.connect(n.st).connect(n.stG).connect(b.input);
  // посил на реверберацію
  n.send = mk(c.createGain()); n.mute.connect(n.send).connect(b.rIn);
  if (!isOffline(c)) { n.an = mk(c.createAnalyser()); n.an.fftSize = 512; n.mute.connect(n.an); }
  return n;
}
const anySolo = () => store.p.tracks.some(t => t.solo);

function applyStatic(n, tr, c, smooth) {
  const when = c.currentTime;
  const S = (prm, v) => (smooth ? prm.setTargetAtTime(v, when, 0.015) : prm.setValueAtTime(v, when));
  S(n.fader.gain, dbToGain(tr.vol));
  S(n.low.gain, tr.eq[0]); S(n.mid.gain, tr.eq[1]); S(n.high.gain, tr.eq[2]);
  S(n.mute.gain, !tr.mute && (!anySolo() || tr.solo) ? 1 : 0);
  const is3d = tr.mode === "3d";
  S(n.sp.gain, is3d ? 1 : 0); S(n.stG.gain, is3d ? 0 : 1); S(n.st.pan, tr.pan);
  S(n.send.gain, tr.send); S(n.reflLP.frequency, ROOMS[store.p.room].hf);
}
function setParam(prm, v, mode, when) {
  if (mode === "target") prm.setTargetAtTime(v, when, 0.03);
  else if (mode === "set") prm.setValueAtTime(v, when);
  else prm.linearRampToValueAtTime(v, when);
}
function setPannerPos(pn, x, y, z, mode, when) {
  if (pn.positionX) { setParam(pn.positionX, x, mode, when); setParam(pn.positionY, y, mode, when); setParam(pn.positionZ, z, mode, when); }
  else pn.setPosition(x, y, z);
}
function applySpatial(n, prm, mode, when) {
  setPannerPos(n.pan, prm.p.x, prm.p.y, prm.p.z, mode, when);
  setParam(n.occ.frequency, prm.occCut, mode, when);
  setParam(n.occG.gain, prm.occGain, mode, when);
  setParam(n.air.frequency, prm.airCut, mode, when);
  prm.refl.forEach((r, i) => {
    const R = n.refl[i];
    setParam(R.d.delayTime, r.delay, mode, when);
    setParam(R.g.gain, r.gain, mode, when);
    setPannerPos(R.p, r.x, r.y, r.z, mode, when);
  });
}
function setListener(c, mode, when, L) {
  const l = c.listener, fx = Math.sin(L.yaw), fz = -Math.cos(L.yaw);
  if (l.positionX) {
    setParam(l.positionX, L.x, mode, when); setParam(l.positionY, 0, mode, when); setParam(l.positionZ, L.z, mode, when);
    setParam(l.forwardX, fx, mode, when); setParam(l.forwardY, 0, mode, when); setParam(l.forwardZ, fz, mode, when);
    setParam(l.upX, 0, mode, when); setParam(l.upY, 1, mode, when); setParam(l.upZ, 0, mode, when);
  } else { l.setPosition(L.x, 0, L.z); l.setOrientation(fx, 0, fz, 0, 1, 0); }
}

/** Ставить у чергу всі кліпи доріжки, починаючи з позиції `from` (сек проєкту) у момент `when0` (час контексту). */
function scheduleClips(c, n, tr, from, when0) {
  for (const cl of tr.clips) {
    if (cl.muted) continue;
    const end = cl.start + cl.dur;
    if (end <= from + 0.001) continue;
    const buf = buffers.get(cl.buf);
    if (!buf) continue;
    const u0 = Math.max(0, from - cl.start); // позиція всередині кліпу
    const len = Math.min(cl.dur, buf.duration - cl.offset);
    if (len - u0 <= 0.002) continue;
    const at = when0 + Math.max(0, cl.start - from);
    const G = dbToGain(cl.gain || 0);
    const fi = Math.max(0.004, Math.min(cl.fi || 0, len)), fo = Math.max(0.004, Math.min(cl.fo || 0, len));
    const env = u => G * Math.max(0, Math.min(1, u / fi, (len - u) / fo));
    const s = c.createBufferSource(), g = c.createGain();
    s.buffer = buf;
    g.gain.setValueAtTime(env(u0), at);
    [fi, len - fo, len].filter(b => b > u0).sort((a, b) => a - b)
      .forEach(b => g.gain.linearRampToValueAtTime(env(b), at + (b - u0)));
    s.connect(g).connect(n.fader);
    s.start(at, cl.offset + u0, len - u0);
    n.all.push(s, g); n.srcs.push(s);
  }
}

/* ---------------- транспорт ---------------- */
function startTrack(tr, from, when0) {
  const c = eng.ctx, n = buildChain(c, eng.bus);
  applyStatic(n, tr, c, false);
  applySpatial(n, params(tr, from, store.p), "set", c.currentTime);
  scheduleClips(c, n, tr, from, when0);
  chains.set(tr.id, n);
}
function killChain(id) {
  const n = chains.get(id);
  if (!n) return;
  n.srcs.forEach(s => { try { s.stop(); } catch (e) { /* ще не стартував */ } });
  n.all.forEach(x => { try { x.disconnect(); } catch (e) { /* вже від'єднано */ } });
  chains.delete(id);
  lastKey.delete(id);
}
function killAll() { [...chains.keys()].forEach(killChain); }

export function play(from = store.playhead) {
  ensureCtx();
  eng.ctx.resume();
  killAll();
  const c = eng.ctx;
  setListener(c, "set", c.currentTime, store.p.listener);
  eng.t0 = c.currentTime + 0.06;
  eng.startPos = Math.max(0, from);
  metroNext = null;
  store.p.tracks.forEach(tr => startTrack(tr, eng.startPos, eng.t0));
  store.playing = true;
  notify("transport");
}
export function pause() {
  if (!store.playing) return;
  store.playhead = now();
  killAll();
  store.playing = false;
  notify("transport");
}
export function seek(t) {
  if (store.recording) return;
  t = Math.max(0, t);
  if (store.playing) play(t); else { store.playhead = t; notify("transport"); }
}
/** Після зміни кліпів під час відтворення — перебудувати чергу. */
export function reschedule() { if (store.playing) play(now()); }
export function removeTrackLive(id) { killChain(id); }
export function addTrackLive(tr) {
  if (!store.playing) return;
  startTrack(tr, now() + 0.02, eng.ctx.currentTime + 0.02);
}
export function liveStatic(tr) { const n = chains.get(tr.id); if (n && eng.ctx) applyStatic(n, tr, eng.ctx, true); }
export function liveAll() { store.p.tracks.forEach(liveStatic); }
export function setRoomLive() {
  if (!eng.ctx) return;
  eng.bus.conv.buffer = makeIR(eng.ctx, ROOMS[store.p.room]);
  setWetLive(); liveAll();
}
export function setWetLive() { if (eng.bus) eng.bus.rRet.gain.setTargetAtTime(store.p.wet * 1.6, eng.ctx.currentTime, 0.05); }
export function setMasterLive() { if (eng.bus) eng.bus.g.gain.setTargetAtTime(dbToGain(store.p.masterDb), eng.ctx.currentTime, 0.02); }
/** Повна перебудова після завантаження іншого проєкту. */
export function resetForProject() {
  killAll();
  store.playing = false;
  if (eng.ctx) { eng.bus.conv.buffer = makeIR(eng.ctx, ROOMS[store.p.room]); setWetLive(); setMasterLive(); }
}

function click(at, accent) {
  const c = eng.ctx, o = c.createOscillator(), g = c.createGain();
  o.frequency.value = accent ? 1760 : 1180;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(accent ? 0.45 : 0.25, at + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
  o.connect(g).connect(c.destination);
  o.start(at); o.stop(at + 0.06);
}

/** Кожен кадр: просторові параметри, метроном, цикл. */
export function tick(prmMap) {
  if (!store.playing) return;
  const c = eng.ctx, p = store.p, pos = now();
  setListener(c, "target", c.currentTime, p.listener);
  for (const tr of p.tracks) {
    const n = chains.get(tr.id);
    if (!n) continue;
    const prm = prmMap.get(tr.id);
    const key = [prm.p.x, prm.p.y, prm.p.z, prm.occCut, prm.occGain, p.early, p.room, p.listener.x, p.listener.z].map(v => (typeof v === "number" ? v.toFixed(3) : v)).join();
    if (lastKey.get(tr.id) !== key) { lastKey.set(tr.id, key); applySpatial(n, prm, "target", c.currentTime); }
  }
  if (p.metro) {
    const beat = 60 / p.bpm;
    if (metroNext === null) metroNext = Math.ceil((pos - 1e-6) / beat) * beat;
    while (metroNext < pos + 0.15) {
      const at = eng.t0 + (metroNext - eng.startPos);
      if (at >= c.currentTime - 0.005) click(at, Math.round(metroNext / beat) % 4 === 0);
      metroNext += beat;
    }
  } else metroNext = null;
  if (p.loop.on && !store.recording && p.loop.b > p.loop.a + 0.1 && eng.startPos < p.loop.b && pos >= p.loop.b) play(p.loop.a);
}

const tmp = new Float32Array(1024);
function peak(an) {
  if (!an) return 0;
  const a = tmp.subarray(0, an.fftSize);
  an.getFloatTimeDomainData(a);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]));
  return m;
}
export const trackPeak = id => { const n = chains.get(id); return n && store.playing ? peak(n.an) : 0; };
export const masterPeaks = () => (eng.bus && store.playing ? [peak(eng.bus.aL), peak(eng.bus.aR)] : [0, 0]);

/* ---------------- рендер ---------------- */
export function mixLength() {
  const end = projectEnd();
  return { end, len: end + Math.min(4, ROOMS[store.p.room].rt + 0.3) };
}
export async function renderMix() {
  const p = store.p, { end, len } = mixLength();
  if (end <= 0) throw new Error("У проєкті немає кліпів.");
  const oc = new OfflineAudioContext(2, Math.ceil(len * SR), SR);
  const b = buildBus(oc, oc.destination, p);
  setListener(oc, "set", 0, p.listener);
  for (const tr of p.tracks) {
    const n = buildChain(oc, b);
    applyStatic(n, tr, oc, false);
    applySpatial(n, params(tr, 0, p), "set", 0);
    if (tr.motion.type !== "none" || tr.auto.length)
      for (let t = 0.02; t < len; t += 0.02) applySpatial(n, params(tr, t, p), "ramp", t);
    scheduleClips(oc, n, tr, 0, 0);
  }
  return oc.startRendering();
}
