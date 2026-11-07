import { eng, ensureCtx } from "./engine.js";

/** Запис з мікрофона: сирий PCM через AudioWorklet (або ScriptProcessor як запасний варіант). */
const WORKLET = `
class BaeRec extends AudioWorkletProcessor {
  constructor() {
    super(); this.buf = new Float32Array(4096); this.n = 0; this.first = true;
    this.port.onmessage = e => { if (e.data === "flush") { this.port.postMessage({ chunk: this.buf.slice(0, this.n), done: true }); this.n = 0; } };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      if (this.first) { this.port.postMessage({ t: currentTime }); this.first = false; }
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage({ chunk: this.buf.slice(0) }); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor("bae-rec", BaeRec);`;

let workletReady = false;
let rec = null;
let deviceId = "";

export const recState = () => rec;
export function setDevice(id) { deviceId = id; }

export async function listInputs() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter(d => d.kind === "audioinput");
}

export async function startRecording() {
  const c = ensureCtx();
  await c.resume();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const e = new Error("no-media"); e.name = "NotSupportedError"; throw e;
  }
  const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  if (deviceId) audio.deviceId = { exact: deviceId };
  const stream = await navigator.mediaDevices.getUserMedia({ audio });
  const src = c.createMediaStreamSource(stream);
  const an = c.createAnalyser(); an.fftSize = 1024; src.connect(an);
  const sink = c.createGain(); sink.gain.value = 0; sink.connect(c.destination);
  const r = { stream, src, an, sink, chunks: [], firstT: null, onDone: null };
  if (c.audioWorklet && window.AudioWorkletNode) {
    if (!workletReady) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      await c.audioWorklet.addModule(url);
      workletReady = true;
    }
    r.node = new AudioWorkletNode(c, "bae-rec", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
    r.node.port.onmessage = e => {
      const d = e.data;
      if (d.t !== undefined) r.firstT = d.t;
      if (d.chunk && d.chunk.length) r.chunks.push(d.chunk);
      if (d.done && r.onDone) r.onDone();
    };
    r.worklet = true;
  } else {
    r.node = c.createScriptProcessor(4096, 1, 1);
    r.node.onaudioprocess = e => {
      if (r.firstT === null) r.firstT = c.currentTime - 4096 / c.sampleRate;
      r.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
  }
  src.connect(r.node); r.node.connect(sink);
  const settings = stream.getAudioTracks()[0].getSettings ? stream.getAudioTracks()[0].getSettings() : {};
  r.inLat = typeof settings.latency === "number" ? settings.latency : 0;
  r.label = stream.getAudioTracks()[0].label || "Мікрофон";
  rec = r;
  return r;
}

export function inputLevel() {
  if (!rec) return 0;
  const a = new Float32Array(rec.an.fftSize);
  rec.an.getFloatTimeDomainData(a);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]));
  return m;
}

/** Зупиняє запис. Повертає AudioBuffer, час першого семплу (у часі контексту) і оцінку затримки. */
export async function stopRecording() {
  const r = rec;
  if (!r) return null;
  rec = null;
  const c = eng.ctx;
  if (r.worklet) {
    await new Promise(res => { r.onDone = res; r.node.port.postMessage("flush"); setTimeout(res, 600); });
  }
  try { r.src.disconnect(); r.node.disconnect(); r.sink.disconnect(); } catch (e) { /* вже від'єднано */ }
  r.stream.getTracks().forEach(t => t.stop());
  const total = r.chunks.reduce((s, x) => s + x.length, 0);
  if (!total) return null;
  const buf = c.createBuffer(1, total, c.sampleRate), d = buf.getChannelData(0);
  let o = 0;
  for (const ch of r.chunks) { d.set(ch, o); o += ch.length; }
  const latency = (c.outputLatency || 0) + (c.baseLatency || 0) + r.inLat;
  return { buffer: buf, firstT: r.firstT === null ? c.currentTime - total / c.sampleRate : r.firstT, latency, label: r.label };
}
