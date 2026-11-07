import { usedBufIds } from "./state.js";

/* ---------------- WAV ---------------- */
export function wavEncode(ab, bits = 24) {
  const ch = ab.numberOfChannels, n = ab.length, bps = bits / 8, bytes = n * ch * bps;
  const u8 = new Uint8Array(44 + bytes), v = new DataView(u8.buffer);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) u8[o + i] = s.charCodeAt(i); };
  ws(0, "RIFF"); v.setUint32(4, 36 + bytes, true); ws(8, "WAVE"); ws(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, ab.sampleRate, true);
  v.setUint32(28, ab.sampleRate * ch * bps, true); v.setUint16(32, ch * bps, true); v.setUint16(34, bits, true);
  ws(36, "data"); v.setUint32(40, bytes, true);
  const chans = [];
  for (let c = 0; c < ch; c++) chans.push(ab.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const s = Math.max(-1, Math.min(1, chans[c][i]));
    if (bits === 16) { v.setInt16(o, Math.round(s * 32767), true); o += 2; }
    else {
      let x = Math.round(s * 8388607); if (x < 0) x += 16777216;
      u8[o++] = x & 255; u8[o++] = (x >> 8) & 255; u8[o++] = (x >> 16) & 255;
    }
  }
  return u8;
}
/** Розбір PCM WAV (16/24/32 біт, 32-біт float). Повертає null, якщо формат інший. */
export function wavDecode(u8) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const str = (o, n) => String.fromCharCode(...u8.subarray(o, o + n));
  if (str(0, 4) !== "RIFF" || str(8, 4) !== "WAVE") return null;
  let o = 12, fmt = null;
  while (o + 8 <= u8.length) {
    const id = str(o, 4), size = v.getUint32(o + 4, true), body = o + 8;
    if (id === "fmt ") fmt = { tag: v.getUint16(body, true), ch: v.getUint16(body + 2, true), sr: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
    else if (id === "data" && fmt) {
      const bps = fmt.bits / 8, n = Math.floor(size / (bps * fmt.ch)), chans = [];
      for (let c = 0; c < fmt.ch; c++) chans.push(new Float32Array(n));
      let p = body;
      for (let i = 0; i < n; i++) for (let c = 0; c < fmt.ch; c++) {
        let s;
        if (fmt.tag === 3 && fmt.bits === 32) s = v.getFloat32(p, true);
        else if (fmt.bits === 16) s = v.getInt16(p, true) / 32768;
        else if (fmt.bits === 24) { let x = u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16); if (x & 0x800000) x -= 16777216; s = x / 8388608; }
        else if (fmt.bits === 32) s = v.getInt32(p, true) / 2147483648;
        else return null;
        chans[c][i] = s; p += bps;
      }
      return { sampleRate: fmt.sr, channels: chans };
    }
    o = body + size + (size & 1);
  }
  return null;
}
export function toAudioBuffer({ sampleRate, channels }) {
  const b = new AudioBuffer({ length: Math.max(1, channels[0].length), numberOfChannels: channels.length, sampleRate });
  channels.forEach((d, i) => b.copyToChannel(d, i));
  return b;
}

/* ---------------- ZIP (без стиснення) ---------------- */
const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
  return t;
})();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

export function zipWrite(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const nm = new TextEncoder().encode(f.name), data = f.data, crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true); lh.setUint16(26, nm.length, true);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
    cd.setUint16(14, 0x21, true); cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true); cd.setUint16(28, nm.length, true); cd.setUint32(42, offset, true);
    parts.push(lh, nm, data);
    central.push(cd, nm);
    offset += 30 + nm.length + data.length;
  }
  const cdSize = central.reduce((s, x) => s + x.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}
export async function zipRead(u8) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let e = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error("Це не ZIP-файл.");
  const count = v.getUint16(e + 10, true);
  let p = v.getUint32(e + 16, true);
  const out = new Map(), dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true);
    const nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), lo = v.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
    const dataAt = lo + 30 + v.getUint16(lo + 26, true) + v.getUint16(lo + 28, true);
    let data = u8.subarray(dataAt, dataAt + csize);
    if (method === 8) {
      if (typeof DecompressionStream === "undefined") throw new Error("Стиснений ZIP не підтримується цим браузером.");
      data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    } else if (method !== 0) throw new Error("Невідомий метод стиснення ZIP.");
    out.set(name, data);
    p += 46 + nl + xl + cl;
  }
  return out;
}

/* ---------------- збереження файлів ---------------- */
/** Віддає файл користувачу: у Claude — через capability `downloads`, деінде — звичайне завантаження. */
export async function saveBlob(blob, filename) {
  let dl = null;
  if (window.claude && typeof window.claude.use === "function") {
    try { dl = await window.claude.use("downloads"); } catch (e) { dl = null; }
    if (!dl) throw Object.assign(new Error("Збереження файлів недоступне в цьому перегляді."), { code: "unavailable" });
    await dl.save({ filename, data: blob });
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
}

/* ---------------- файл проєкту ---------------- */
export function projectToZip(p, buffers) {
  const files = [{ name: "project.json", data: new TextEncoder().encode(JSON.stringify(p, null, 1)) }];
  for (const id of usedBufIds(p)) {
    if (id.startsWith("demo:")) continue;
    const b = buffers.get(id);
    if (b) files.push({ name: "audio/" + id + ".wav", data: wavEncode(b, 24) });
  }
  return zipWrite(files);
}
export async function zipToProject(u8, decodeFallback) {
  const files = await zipRead(u8);
  const pj = files.get("project.json");
  if (!pj) throw new Error("У файлі немає project.json — це не проєкт BAE.");
  const p = JSON.parse(new TextDecoder().decode(pj));
  const bufs = new Map();
  for (const [name, data] of files) {
    const m = name.match(/^audio\/(.+)\.wav$/);
    if (!m) continue;
    const w = wavDecode(data);
    bufs.set(m[1], w ? toAudioBuffer(w) : await decodeFallback(data));
  }
  return { p, bufs };
}

/* ---------------- бібліотека проєктів у браузері (IndexedDB) ---------------- */
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("bae", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("projects", { keyPath: "id" });
      d.createObjectStore("buffers", { keyPath: "id" });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = t => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });

export async function idbSave(id, p, buffers) {
  const d = await openDB();
  const ids = usedBufIds(p).filter(b => !b.startsWith("demo:"));
  const have = new Set(await req(d.transaction("buffers").objectStore("buffers").getAllKeys()));
  const t = d.transaction(["projects", "buffers"], "readwrite");
  const bs = t.objectStore("buffers");
  for (const b of ids) {
    if (have.has(b)) continue;
    const ab = buffers.get(b);
    if (!ab) continue;
    const ch = [];
    for (let i = 0; i < ab.numberOfChannels; i++) ch.push(ab.getChannelData(i).slice());
    bs.put({ id: b, sr: ab.sampleRate, ch });
  }
  t.objectStore("projects").put({ id, name: p.name, updated: Date.now(), json: JSON.stringify(p), bufIds: ids });
  await done(t);
  d.close();
}
export async function idbList() {
  const d = await openDB();
  const all = await req(d.transaction("projects").objectStore("projects").getAll());
  d.close();
  return all.map(r => ({ id: r.id, name: r.name, updated: r.updated, n: r.bufIds.length })).sort((a, b) => b.updated - a.updated);
}
export async function idbLoad(id) {
  const d = await openDB();
  const t = d.transaction(["projects", "buffers"]);
  const rec = await req(t.objectStore("projects").get(id));
  if (!rec) { d.close(); return null; }
  const bufs = new Map();
  for (const b of rec.bufIds) {
    const r = await req(t.objectStore("buffers").get(b));
    if (r) bufs.set(b, toAudioBuffer({ sampleRate: r.sr, channels: r.ch }));
  }
  d.close();
  return { p: JSON.parse(rec.json), bufs };
}
export async function idbDelete(id) {
  const d = await openDB();
  const t = d.transaction(["projects", "buffers"], "readwrite");
  const ps = t.objectStore("projects");
  await req(ps.delete(id));
  const rest = await req(ps.getAll());
  const keep = new Set(rest.flatMap(r => r.bufIds));
  const keys = await req(t.objectStore("buffers").getAllKeys());
  keys.forEach(k => { if (!keep.has(k)) t.objectStore("buffers").delete(k); });
  await done(t);
  d.close();
}
