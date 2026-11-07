/** Кеш піків хвилі для таймлайну: максимум |x| на кожні SPP семплів. */
export const SPP = 256;
const cache = new WeakMap();
export function peaksOf(buf) {
  let p = cache.get(buf);
  if (p) return p;
  const n = Math.ceil(buf.length / SPP);
  p = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      let m = p[i];
      const end = Math.min(d.length, (i + 1) * SPP);
      for (let j = i * SPP; j < end; j++) { const a = d[j] < 0 ? -d[j] : d[j]; if (a > m) m = a; }
      p[i] = m;
    }
  }
  cache.set(buf, p);
  return p;
}
