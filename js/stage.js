import { TAU, clamp, css } from "./util.js";
import { store, findTrack, checkpoint, notify } from "./state.js";
import { ROOMS, bounds, maxHeight } from "./spatial.js";
import { now } from "./engine.js";

/** Сцена згори: джерела, слухач, перешкоди, запис траєкторій. */
export function initStage(cv, box) {
  const g = cv.getContext("2d");
  const view = { s: 1, ox: 0, oy: 0, w: 0, h: 0 };
  const screenPos = new Map();
  let drag = null, wallDraft = null;

  function resize() {
    const r = box.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    view.w = r.width; view.h = r.height;
  }
  new ResizeObserver(resize).observe(box);
  resize();

  const W2S = (x, z) => [view.ox + x * view.s, view.oy + z * view.s];
  const S2W = (px, py) => [(px - view.ox) / view.s, (py - view.oy) / view.s];
  const snap = v => Math.round(v * 2) / 2;

  function draw(prmMap) {
    if (!view.w) return;
    const p = store.p, R = ROOMS[p.room], L = p.listener, C = css();
    view.s = Math.min((view.w - 68) / R.W, (view.h - 68) / R.D);
    view.ox = view.w / 2; view.oy = view.h / 2;
    g.clearRect(0, 0, view.w, view.h);
    g.fillStyle = C["--floor"]; g.fillRect(0, 0, view.w, view.h);
    const [rx, ry] = W2S(-R.W / 2, -R.D / 2), rw = R.W * view.s, rh = R.D * view.s;
    // сітка
    const step = R.W <= 8 ? 1 : R.W <= 30 ? 2 : 5;
    g.strokeStyle = C["--grid"]; g.lineWidth = 1; g.beginPath();
    for (let x = -Math.floor(R.W / 2 / step) * step; x <= R.W / 2; x += step) { const [sx] = W2S(x, 0); g.moveTo(sx, ry); g.lineTo(sx, ry + rh); }
    for (let z = -Math.floor(R.D / 2 / step) * step; z <= R.D / 2; z += step) { const [, sy] = W2S(0, z); g.moveTo(rx, sy); g.lineTo(rx + rw, sy); }
    g.stroke();
    g.strokeStyle = C["--wall"]; g.lineWidth = R.walls ? 4 : 1; g.setLineDash(R.walls ? [] : [6, 6]);
    g.strokeRect(rx, ry, rw, rh); g.setLineDash([]);
    g.fillStyle = C["--muted"]; g.font = "500 11px 'JetBrains Mono', monospace"; g.textAlign = "center";
    g.fillText(`${R.name} · ${R.W}×${R.D}${R.walls ? "×" + R.H : ""} м · сцена ↑`, view.w / 2, Math.max(14, ry - 10));
    // кільця відстані
    const [lx, ly] = W2S(L.x, L.z);
    g.save(); g.beginPath(); g.rect(rx, ry, rw, rh); g.clip();
    g.strokeStyle = C["--muted"]; g.setLineDash([2, 4]);
    [1, 2, 5, 10, 20].forEach(d => {
      if (d * view.s < 18 || d > Math.max(R.W, R.D)) return;
      g.globalAlpha = 0.28; g.beginPath(); g.arc(lx, ly, d * view.s, 0, TAU); g.stroke();
      g.globalAlpha = 0.6; g.fillText(d + " м", lx + d * view.s * 0.707 + 14, ly - d * view.s * 0.707);
    });
    g.restore(); g.setLineDash([]); g.globalAlpha = 1;
    // перешкоди
    (wallDraft ? p.obstacles.concat([wallDraft]) : p.obstacles).forEach(o => {
      const [a, b] = W2S(o.x1, o.z1), [c, d] = W2S(o.x2, o.z2);
      g.strokeStyle = C["--mat-" + o.mat]; g.lineWidth = o.mat === "fabric" ? 5 : 7; g.lineCap = "round";
      g.setLineDash(o.mat === "fabric" ? [8, 6] : []);
      g.beginPath(); g.moveTo(a, b); g.lineTo(c, d); g.stroke();
    });
    g.setLineDash([]); g.lineCap = "butt";
    // джерела
    screenPos.clear();
    p.tracks.forEach(tr => {
      const prm = prmMap.get(tr.id), pos = prm.p, [sx, sy] = W2S(pos.x, pos.z), is3d = tr.mode === "3d";
      screenPos.set(tr.id, [sx, sy]);
      if (is3d) {
        if (tr.auto.length > 1) {
          g.strokeStyle = tr.color; g.globalAlpha = 0.45; g.lineWidth = 1.5; g.beginPath();
          tr.auto.forEach((k, i) => { const [ax, ay] = W2S(k.x, k.z); i ? g.lineTo(ax, ay) : g.moveTo(ax, ay); });
          g.stroke();
        }
        g.strokeStyle = prm.occN ? C["--warn"] : tr.color; g.globalAlpha = prm.occN ? 0.75 : 0.3; g.lineWidth = 1.5;
        g.setLineDash(prm.occN ? [4, 4] : []); g.beginPath(); g.moveTo(lx, ly); g.lineTo(sx, sy); g.stroke(); g.setLineDash([]);
        if (tr.motion.type === "orbit" && !tr.auto.length) {
          g.globalAlpha = 0.25; g.strokeStyle = tr.color; g.setLineDash([3, 5]);
          g.beginPath(); g.arc(lx, ly, Math.hypot(tr.x - L.x, tr.z - L.z) * view.s, 0, TAU); g.stroke(); g.setLineDash([]);
        }
        g.globalAlpha = 1;
      }
      const rad = clamp(9 + pos.y * 1.6, 5, 17);
      if (pos.y > 0.05) { g.fillStyle = "rgba(0,0,0,.18)"; g.beginPath(); g.ellipse(sx + pos.y * 2, sy + pos.y * 3, rad, rad * 0.6, 0, 0, TAU); g.fill(); }
      if (tr.id === store.selTrack) { g.strokeStyle = C["--fg"]; g.lineWidth = 2; g.beginPath(); g.arc(sx, sy, rad + 5, 0, TAU); g.stroke(); }
      g.beginPath(); g.arc(sx, sy, rad, 0, TAU);
      if (is3d) { g.fillStyle = tr.color; g.globalAlpha = tr.mute ? 0.35 : 1; g.fill(); g.globalAlpha = 1; g.strokeStyle = C["--bg"]; g.lineWidth = 2; g.stroke(); }
      else { g.strokeStyle = tr.color; g.lineWidth = 2; g.setLineDash([3, 3]); g.stroke(); g.setLineDash([]); }
      if (drag && drag.rec && drag.id === tr.id) { g.strokeStyle = C["--rec"]; g.lineWidth = 2; g.beginPath(); g.arc(sx, sy, rad + 9, 0, TAU); g.stroke(); }
      g.fillStyle = C["--fg"]; g.font = "600 12px Onest, system-ui, sans-serif"; g.textAlign = "left";
      g.fillText(tr.name + (is3d ? "" : " · стерео"), sx + rad + 6, sy - 2);
      g.fillStyle = C["--muted"]; g.font = "11px 'JetBrains Mono', monospace";
      g.fillText(`${prm.d.toFixed(1)} м · ${pos.y >= 0 ? "↑" : "↓"}${Math.abs(pos.y).toFixed(1)}`, sx + rad + 6, sy + 12);
    });
    // голова слухача
    g.save(); g.translate(lx, ly); g.rotate(L.yaw);
    g.fillStyle = C["--head"];
    g.beginPath(); g.moveTo(-6, -12); g.lineTo(0, -21); g.lineTo(6, -12); g.fill();
    g.beginPath(); g.ellipse(-13, 0, 3.5, 6, 0, 0, TAU); g.ellipse(13, 0, 3.5, 6, 0, 0, TAU); g.fill();
    g.beginPath(); g.arc(0, 0, 13, 0, TAU); g.fill();
    g.restore();
    g.fillStyle = C["--bg"]; g.font = "600 10px Onest, system-ui, sans-serif"; g.textAlign = "center";
    g.fillText("ВИ", lx, ly + 4);
  }

  function hitTrack(px, py) {
    let best = null, bd = 18;
    screenPos.forEach(([sx, sy], id) => { const d = Math.hypot(px - sx, py - sy); if (d < bd) { bd = d; best = id; } });
    return best;
  }
  const evPos = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  function distSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, t = l2 ? clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1) : 0;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  }
  /** Запис точки траєкторії в момент t (перезаписує точки між попередньою і цією). */
  function writeAuto(tr, t, x, z) {
    const y = tr.auto.length ? tr.auto[tr.auto.length - 1].y : tr.y;
    if (!tr.auto.length) {
      tr.auto.push({ t: 0, x: tr.x, y: tr.y, z: tr.z });
      if (t > 0.05) tr.auto.push({ t: t - 0.03, x: tr.x, y: tr.y, z: tr.z });
    }
    const from = drag.lastT;
    const yy = currentY(tr, t, y);
    tr.auto = tr.auto.filter(k => !(k.t > from && k.t <= t));
    const k = { t, x, y: yy, z };
    const i = tr.auto.findIndex(q => q.t > t);
    if (i < 0) tr.auto.push(k); else tr.auto.splice(i, 0, k);
    drag.lastT = t;
  }
  function currentY(tr, t) {
    if (!tr.auto.length) return tr.y;
    let best = tr.auto[0];
    for (const k of tr.auto) { if (k.t <= t) best = k; else break; }
    return best.y;
  }

  cv.addEventListener("pointerdown", e => {
    const p = store.p, [px, py] = evPos(e), [wx, wz] = S2W(px, py), L = p.listener, [lx, ly] = W2S(L.x, L.z);
    if (store.tool === "wall") { wallDraft = { x1: snap(wx), z1: snap(wz), x2: snap(wx), z2: snap(wz), mat: store.mat }; cv.setPointerCapture(e.pointerId); return; }
    if (store.tool === "erase") {
      let bi = -1, bd = 12;
      p.obstacles.forEach((o, i) => { const [a, b] = W2S(o.x1, o.z1), [c, d] = W2S(o.x2, o.z2), dd = distSeg(px, py, a, b, c, d); if (dd < bd) { bd = dd; bi = i; } });
      if (bi >= 0) { checkpoint(); p.obstacles.splice(bi, 1); }
      return;
    }
    const id = hitTrack(px, py);
    if (id) {
      checkpoint();
      const tr = findTrack(id);
      drag = { kind: "src", id, lx: wx, lz: wz, rec: store.recMotion && store.playing && tr.mode === "3d", x: wx, z: wz, lastT: now() - 0.001 };
      if (store.selTrack !== id) { store.selTrack = id; notify("select"); }
    } else if (Math.hypot(px - lx, py - ly) < 22) { checkpoint(); drag = { kind: "listener" }; }
    if (drag) cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener("pointermove", e => {
    const p = store.p, [px, py] = evPos(e), [wx, wz] = S2W(px, py), b = bounds(p);
    if (wallDraft) { wallDraft.x2 = snap(wx); wallDraft.z2 = snap(wz); return; }
    if (!drag) { cv.style.cursor = store.tool !== "move" ? "crosshair" : hitTrack(px, py) ? "grab" : "default"; return; }
    const cx = clamp(wx, -b.hx, b.hx), cz = clamp(wz, -b.hz, b.hz);
    if (drag.kind === "src") {
      const tr = findTrack(drag.id);
      if (!tr) return;
      if (drag.rec) { drag.x = cx; drag.z = cz; writeAuto(tr, now(), cx, cz); }
      else if (tr.auto.length) {
        const dx = wx - drag.lx, dz = wz - drag.lz;
        tr.auto.forEach(k => { k.x = clamp(k.x + dx, -b.hx, b.hx); k.z = clamp(k.z + dz, -b.hz, b.hz); });
        tr.x = clamp(tr.x + dx, -b.hx, b.hx); tr.z = clamp(tr.z + dz, -b.hz, b.hz);
      } else { tr.x = cx; tr.z = cz; }
      drag.lx = wx; drag.lz = wz;
      notify("geometry");
    } else { p.listener.x = cx; p.listener.z = cz; notify("geometry"); }
  });
  const endDrag = () => {
    if (wallDraft) {
      if (Math.hypot(wallDraft.x2 - wallDraft.x1, wallDraft.z2 - wallDraft.z1) > 0.3) { checkpoint(); store.p.obstacles.push(wallDraft); }
      wallDraft = null;
    }
    if (drag && drag.rec) notify("structure");
    drag = null;
  };
  cv.addEventListener("pointerup", endDrag);
  cv.addEventListener("pointercancel", endDrag);
  cv.addEventListener("wheel", e => {
    const [px, py] = evPos(e), id = hitTrack(px, py);
    if (!id) return;
    e.preventDefault();
    const tr = findTrack(id), dy = -Math.sign(e.deltaY) * 0.1, top = maxHeight(store.p);
    checkpoint(false);
    if (tr.auto.length) tr.auto.forEach(k => (k.y = clamp(Math.round((k.y + dy) * 10) / 10, -1.6, top)));
    tr.y = clamp(Math.round((tr.y + dy) * 10) / 10, -1.6, top);
    if (store.selTrack !== id) { store.selTrack = id; notify("select"); } else notify("geometry");
  }, { passive: false });

  /** Якщо користувач тримає джерело нерухомо під час запису руху — продовжуємо писати позицію. */
  function tickDrag() {
    if (drag && drag.rec && store.playing) {
      const tr = findTrack(drag.id);
      if (tr && now() - drag.lastT > 0.05) writeAuto(tr, now(), drag.x, drag.z);
    }
  }
  return { draw, tickDrag };
}
