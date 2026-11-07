import { clamp, TAU, EAR, C_SOUND } from "./util.js";

export const ROOMS = {
  studio: { name: "Студія звукозапису", W: 6, D: 5, H: 3, rt: 0.35, refl: 0.32, wet: 0.10, hf: 7000, walls: true },
  room:   { name: "Житлова кімната", W: 5, D: 4.5, H: 2.7, rt: 0.6, refl: 0.5, wet: 0.16, hf: 6000, walls: true },
  hall:   { name: "Концертний зал", W: 22, D: 26, H: 12, rt: 1.9, refl: 0.5, wet: 0.24, hf: 5000, walls: true },
  church: { name: "Собор", W: 30, D: 50, H: 22, rt: 4.5, refl: 0.62, wet: 0.36, hf: 3800, walls: true },
  field:  { name: "Відкрите поле", W: 60, D: 60, H: 0, rt: 0.3, refl: 0.45, wet: 0.03, hf: 8000, walls: false }
};
export const MATS = {
  concrete: { name: "Бетон", cut: 380, gain: 0.32 },
  wood: { name: "Дерево", cut: 1100, gain: 0.5 },
  fabric: { name: "Тканина", cut: 3800, gain: 0.8 }
};
export const MOTIONS = {
  none: "Нерухомо", orbit: "Коло навколо слухача", sway: "Маятник ліво–право",
  approach: "Наближення–віддалення", rise: "Вгору–вниз"
};

export function bounds(p) { const R = ROOMS[p.room]; return { hx: R.W / 2 - 0.2, hz: R.D / 2 - 0.2 }; }
export function maxHeight(p) { return Math.max(4, Math.round(ROOMS[p.room].H - EAR)); }

/** Інтерполяція записаної траєкторії. */
export function autoAt(a, t) {
  if (t <= a[0].t) return a[0];
  const last = a[a.length - 1];
  if (t >= last.t) return last;
  let lo = 0, hi = a.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (a[m].t <= t) lo = m; else hi = m; }
  const A = a[lo], B = a[hi], k = (t - A.t) / (B.t - A.t || 1);
  return { x: A.x + (B.x - A.x) * k, y: A.y + (B.y - A.y) * k, z: A.z + (B.z - A.z) * k };
}
export function basePos(tr, t) {
  return tr.auto && tr.auto.length ? autoAt(tr.auto, t) : { x: tr.x, y: tr.y, z: tr.z };
}
export function trackPos(tr, t, p) {
  const L = p.listener;
  let { x, y, z } = basePos(tr, t);
  const m = tr.motion;
  if (m.type !== "none") {
    const ph = TAU * t / m.period, dx = x - L.x, dz = z - L.z;
    const r = Math.max(0.3, Math.hypot(dx, dz)), a = Math.atan2(dx, -dz);
    if (m.type === "orbit") { x = L.x + r * Math.sin(a + ph); z = L.z - r * Math.cos(a + ph); }
    else if (m.type === "sway") x += 3 * Math.sin(ph);
    else if (m.type === "approach") { const rr = Math.max(0.35, r * (0.55 + 0.45 * Math.cos(ph))); x = L.x + rr * Math.sin(a); z = L.z - rr * Math.cos(a); }
    else if (m.type === "rise") y += 2 * Math.sin(ph);
  }
  const b = bounds(p);
  return { x: clamp(x, -b.hx, b.hx), y: clamp(y, -EAR + 0.05, 30), z: clamp(z, -b.hz, b.hz) };
}

function segHit(ax, az, bx, bz, cx, cz, dx, dz) {
  const r1x = bx - ax, r1z = bz - az, r2x = dx - cx, r2z = dz - cz, den = r1x * r2z - r1z * r2x;
  if (Math.abs(den) < 1e-9) return false;
  const t = ((cx - ax) * r2z - (cz - az) * r2x) / den, u = ((cx - ax) * r1z - (cz - az) * r1x) / den;
  return t > 0 && t < 1 && u >= 0 && u <= 1;
}
export function occlusion(p, lx, lz, sx, sz) {
  let cut = 20000, gain = 1, n = 0;
  for (const o of p.obstacles) if (segHit(lx, lz, sx, sz, o.x1, o.z1, o.x2, o.z2)) {
    const m = MATS[o.mat]; n++;
    cut = n === 1 ? m.cut : Math.min(cut, m.cut) * 0.7;
    gain *= m.gain;
  }
  return { cut, gain, n };
}

/** Усі просторові параметри джерела в момент t (сек проєкту). */
export function params(tr, t, p) {
  const R = ROOMS[p.room], L = p.listener, pos = trackPos(tr, t, p);
  const d = Math.hypot(pos.x - L.x, pos.y, pos.z - L.z);
  const oc = occlusion(p, L.x, L.z, pos.x, pos.z);
  const airCut = clamp(20000 * Math.exp(-d / 25), 1800, 20000);
  const imgs = R.walls
    ? [[-R.W - pos.x, pos.y, pos.z], [R.W - pos.x, pos.y, pos.z], [pos.x, pos.y, -R.D - pos.z], [pos.x, pos.y, R.D - pos.z],
       [pos.x, -2 * EAR - pos.y, pos.z], [pos.x, 2 * (R.H - EAR) - pos.y, pos.z]]
    : [null, null, null, null, [pos.x, -2 * EAR - pos.y, pos.z], null];
  const refl = imgs.map(im => {
    if (!im || !p.early) return { x: pos.x, y: pos.y, z: pos.z, delay: 0, gain: 0 };
    const di = Math.hypot(im[0] - L.x, im[1], im[2] - L.z);
    return { x: im[0], y: im[1], z: im[2], delay: clamp((di - d) / C_SOUND, 0, 0.95), gain: R.refl };
  });
  return { p: pos, d, occCut: oc.cut, occGain: oc.gain, occN: oc.n, airCut, refl };
}

export function relAz(p, pos) {
  const L = p.listener;
  let a = Math.atan2(pos.x - L.x, -(pos.z - L.z)) - L.yaw;
  a = Math.atan2(Math.sin(a), Math.cos(a));
  return a * 180 / Math.PI;
}
export function describe(p, prm) {
  const az = relAz(p, prm.p), aa = Math.abs(az), side = az > 0 ? "праворуч" : "ліворуч";
  const dir = aa < 15 ? "прямо перед вами" : aa < 65 ? "спереду " + side : aa < 115 ? side : aa < 165 ? "позаду " + side : "прямо позаду";
  const d = prm.d;
  const dist = d < 1.2 ? "зовсім поруч" : d < 3.5 ? "близько" : d < 9 ? "на середній відстані" : d < 20 ? "далеко" : "дуже далеко";
  const elev = prm.p.y > 1.2 ? ", вище за голову" : prm.p.y < -0.8 ? ", нижче за вуха" : "";
  const occ = prm.occN ? ", за перешкодою — звук глухіший" : "";
  return `Звучить ${dir}, ${dist}${elev}${occ}.`;
}
