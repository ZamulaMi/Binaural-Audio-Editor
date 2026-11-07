import { clamp, css, uid } from "./util.js";
import { store, buffers, findClip, findTrack, checkpoint, notify, projectEnd, selected, selectOnly } from "./state.js";
import { now, seek, reschedule, removeTrackLive } from "./engine.js";
import { peaksOf, SPP } from "./peaks.js";

export const RH = 30, HW = 184;
const SNAP_BEATS = { bar: 4, beat: 1, "1/8": 0.5, "1/16": 0.25 };
const TIME_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

/**
 * Часова шкала на canvas: доріжки з кнопками M/S/R/3D, кліпи з фейдами й гейном,
 * множинний вибір, рамка виділення, копіювання перетягуванням, маркери, цикл.
 */
export function initTimeline(cv, wrap, scrollIn, hooks) {
  const g = cv.getContext("2d");
  let W = 0, H = 0, drag = null, recGhost = null;
  const lh = () => store.laneH;
  const tracks = () => store.p.tracks;
  const tx = t => HW + (t - store.scroll) * store.zoom;
  const xt = x => store.scroll + (x - HW) / store.zoom;
  const top = () => wrap.scrollTop;
  const laneAt = y => Math.floor((y - RH) / lh());
  const laneY = i => RH + i * lh();

  function resize() {
    if (!store.p) return;
    const dpr = window.devicePixelRatio || 1;
    W = wrap.clientWidth;
    H = RH + (tracks().length + 1) * lh();
    cv.style.height = H + "px";
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  new ResizeObserver(() => resize()).observe(wrap);
  const visibleSecs = () => (W - HW) / store.zoom;

  /* ---------- прив'язка ---------- */
  function snapStep() {
    if (store.snapRes === "off") return 0;
    if (store.snapRes === "0.1s") return 0.1;
    return SNAP_BEATS[store.snapRes] * 60 / store.p.bpm;
  }
  /** Найближча «магнітна» точка (плейхед, маркери, межі циклу, краї інших кліпів) у межах 8 px. */
  function magnet(t, exclude) {
    const thr = 8 / store.zoom, p = store.p;
    let best = null, bd = thr;
    const test = v => { const d = Math.abs(v - t); if (d < bd) { bd = d; best = v; } };
    test(0); test(now());
    p.markers.forEach(m => test(m.t));
    if (p.loop.on) { test(p.loop.a); test(p.loop.b); }
    p.tracks.forEach(tr => tr.clips.forEach(c => { if (!exclude || !exclude.has(c.id)) { test(c.start); test(c.start + c.dur); } }));
    return best;
  }
  function snapT(t, e, exclude) {
    if (e && e.altKey) return t;
    if (store.snapRes !== "off") { const m = magnet(t, exclude); if (m !== null) return m; }
    const s = snapStep();
    return s ? Math.round(t / s) * s : t;
  }
  /** Прив'язка під час переміщення: пробуємо і початок, і кінець кліпу. */
  function snapMove(start, dur, e, exclude) {
    if (e && e.altKey) return start;
    if (store.snapRes !== "off") {
      const a = magnet(start, exclude), b = magnet(start + dur, exclude);
      const da = a === null ? Infinity : Math.abs(a - start), db = b === null ? Infinity : Math.abs(b - start - dur);
      if (da < Infinity || db < Infinity) return da <= db ? a : b - dur;
    }
    const s = snapStep();
    return s ? Math.round(start / s) * s : start;
  }

  /* ---------- малювання ---------- */
  function roundRect(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    g.beginPath();
    g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  function fitText(s, w) {
    if (w <= 8) return "";
    if (g.measureText(s).width <= w) return s;
    while (s.length > 1 && g.measureText(s + "…").width > w) s = s.slice(0, -1);
    return s + "…";
  }
  const HB = [{ act: "mute", label: "M", x: 12, w: 24 }, { act: "solo", label: "S", x: 40, w: 24 }, { act: "arm", label: "R", x: 68, w: 24 }, { act: "mode", label: "", x: 96, w: 32 }];
  function headerBtnAt(x, y) {
    const i = laneAt(y), tr = tracks()[i];
    if (!tr) return null;
    const by = laneY(i) + 30;
    if (y < by || y > by + 18) return null;
    const b = HB.find(b => x >= b.x && x <= b.x + b.w);
    return b ? { tr, act: b.act } : null;
  }
  function timeGrid() {
    const step = TIME_STEPS.find(s => s * store.zoom >= 70) || 600;
    return { step, minor: step / 5 };
  }
  function clipEnv(c, u) {
    const fi = Math.max(1e-4, c.fi || 0), fo = Math.max(1e-4, c.fo || 0);
    return Math.pow(10, (c.gain || 0) / 20) * Math.max(0, Math.min(1, (c.fi ? u / fi : 1), (c.fo ? (c.dur - u) / fo : 1)));
  }

  function draw() {
    if (!W) resize();
    const p = store.p, C = css(), pos = now(), L = lh(), rt = top(), n = p.tracks.length;
    g.clearRect(0, 0, W, H);
    g.fillStyle = C["--panel"]; g.fillRect(0, 0, W, H);
    p.tracks.forEach((tr, i) => {
      g.fillStyle = tr.id === store.selTrack ? C["--lane-sel"] : i % 2 ? C["--lane-alt"] : C["--lane"];
      g.fillRect(HW, laneY(i), W - HW, L);
    });
    g.fillStyle = C["--lane"]; g.fillRect(HW, laneY(n), W - HW, H - laneY(n));
    // сітка
    const t0 = xt(HW), t1 = xt(W), b = 60 / p.bpm;
    if (store.rulerMode === "bars") {
      const pxBeat = b * store.zoom, every = pxBeat >= 12 ? 1 : pxBeat * 4 >= 12 ? 4 : pxBeat * 16 >= 14 ? 16 : 64;
      for (let k = Math.max(0, Math.floor(t0 / b / every) * every); k * b <= t1; k += every) {
        const x = Math.round(tx(k * b)) + 0.5;
        g.strokeStyle = C["--line"]; g.globalAlpha = k % 4 === 0 ? 0.95 : 0.35;
        g.beginPath(); g.moveTo(x, RH); g.lineTo(x, H); g.stroke();
      }
    } else {
      const { step, minor } = timeGrid();
      for (let k = Math.max(0, Math.floor(t0 / minor)); k * minor <= t1; k++) {
        const x = Math.round(tx(k * minor)) + 0.5;
        g.strokeStyle = C["--line"]; g.globalAlpha = Math.abs((k * minor) / step - Math.round((k * minor) / step)) < 1e-6 ? 0.9 : 0.35;
        g.beginPath(); g.moveTo(x, RH); g.lineTo(x, H); g.stroke();
      }
    }
    g.globalAlpha = 1;
    if (p.loop.on) {
      g.fillStyle = C["--cycle"]; g.globalAlpha = 0.06;
      const a = Math.max(HW, tx(p.loop.a));
      g.fillRect(a, RH, Math.max(0, tx(p.loop.b) - a), H - RH);
      g.globalAlpha = 1;
    }
    // маркери крізь доріжки
    g.setLineDash([3, 4]); g.strokeStyle = C["--marker"]; g.globalAlpha = 0.55;
    p.markers.forEach(m => { const x = Math.round(tx(m.t)) + 0.5; if (x > HW && x < W) { g.beginPath(); g.moveTo(x, RH); g.lineTo(x, H); g.stroke(); } });
    g.setLineDash([]); g.globalAlpha = 1;

    // кліпи
    g.save(); g.beginPath(); g.rect(HW, rt + RH, W - HW, H - rt - RH); g.clip();
    p.tracks.forEach((tr, i) => {
      const y = laneY(i) + 4, h = L - 8;
      tr.clips.forEach(c => {
        const x1 = tx(c.start), x2 = tx(c.start + c.dur);
        if (x2 < HW || x1 > W) return;
        const sel = store.sel.has(c.id), muted = c.muted, col = muted ? C["--muted"] : tr.color, w = x2 - x1, HD = 15;
        // тіло регіону
        g.fillStyle = col; g.globalAlpha = muted ? 0.14 : sel ? 0.5 : 0.32;
        roundRect(x1, y, w, h, 4); g.fill();
        // заголовок з назвою
        g.globalAlpha = muted ? 0.5 : 1;
        g.save(); roundRect(x1, y, w, h, 4); g.clip();
        g.fillRect(x1, y, w, HD);
        g.restore();
        g.globalAlpha = 1;
        const buf = buffers.get(c.buf);
        if (buf && h > 24) {
          const pk = peaksOf(buf), mid = y + HD + (h - HD) / 2, amp = (h - HD - 6) / 2;
          g.fillStyle = sel ? "#ffffff" : "rgba(255,255,255,.78)"; g.globalAlpha = muted ? 0.35 : 1;
          const from = Math.max(x1, HW), to = Math.min(x2, W), spp = buf.sampleRate / SPP;
          for (let x = Math.floor(from); x < to; x++) {
            const u = (x - x1) / store.zoom, t = c.offset + u, k = Math.floor(t * spp), k2 = Math.max(k + 1, Math.floor((t + 1 / store.zoom) * spp));
            let m = 0;
            for (let j = k; j < k2 && j < pk.length; j++) if (pk[j] > m) m = pk[j];
            const hh = Math.max(0.5, Math.min(1, m * clipEnv(c, u)) * amp);
            g.fillRect(x, mid - hh, 1, hh * 2);
          }
          g.globalAlpha = 1;
        }
        // фейди
        const fiX = x1 + (c.fi || 0) * store.zoom, foX = x2 - (c.fo || 0) * store.zoom;
        g.strokeStyle = "#ffffff"; g.globalAlpha = 0.8; g.lineWidth = 1.2;
        if (c.fi) { g.beginPath(); g.moveTo(x1, y + h); g.quadraticCurveTo(x1 + (fiX - x1) * 0.15, y + HD, fiX, y + HD); g.stroke(); }
        if (c.fo) { g.beginPath(); g.moveTo(foX, y + HD); g.quadraticCurveTo(x2 - (x2 - foX) * 0.15, y + HD, x2, y + h); g.stroke(); }
        g.globalAlpha = 1;
        if (sel || w > 40) {
          g.fillStyle = C["--region-text"];
          g.beginPath(); g.arc(Math.max(fiX, x1 + 4), y + HD / 2, 3, 0, Math.PI * 2); g.fill();
          g.beginPath(); g.arc(Math.min(foX, x2 - 4), y + HD / 2, 3, 0, Math.PI * 2); g.fill();
        }
        g.strokeStyle = sel ? "#ffffff" : "rgba(0,0,0,.55)"; g.lineWidth = sel ? 1.6 : 1;
        roundRect(x1 + 0.5, y + 0.5, w - 1, h - 1, 4); g.stroke();
        const lx = Math.max(x1, HW) + 8;
        g.fillStyle = muted ? C["--fg"] : C["--region-text"]; g.font = "600 11px Onest, system-ui, sans-serif"; g.textAlign = "left";
        const label = (muted ? "⊘ " : "") + (c.name || tr.name) + (c.gain ? `  ${c.gain > 0 ? "+" : ""}${c.gain.toFixed(1)} dB` : "");
        g.fillText(fitText(label, x2 - lx - 10), lx, y + 11.5);
      });
      if (tr.auto.length > 1) {
        const a = tr.auto[0].t, z = tr.auto[tr.auto.length - 1].t;
        g.strokeStyle = tr.color; g.lineWidth = 2; g.setLineDash([2, 3]);
        g.beginPath(); g.moveTo(tx(a), y + h + 2); g.lineTo(tx(z), y + h + 2); g.stroke(); g.setLineDash([]);
      }
    });
    if (recGhost) {
      const i = p.tracks.findIndex(t => t.id === recGhost.track);
      g.fillStyle = C["--rec"]; g.globalAlpha = 0.3;
      roundRect(tx(recGhost.start), laneY(i < 0 ? n : i) + 4, Math.max(2, (pos - recGhost.start) * store.zoom), L - 8, 5); g.fill();
      g.globalAlpha = 1;
    }
    if (drag && drag.kind === "marquee" && drag.active) {
      const x = Math.min(drag.x0, drag.x1), y = Math.min(drag.y0, drag.y1);
      g.fillStyle = C["--accent"]; g.globalAlpha = 0.12; g.fillRect(x, y, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
      g.globalAlpha = 1; g.strokeStyle = C["--accent"]; g.strokeRect(x + 0.5, y + 0.5, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
    }
    g.restore();

    // заголовки доріжок
    g.save(); g.beginPath(); g.rect(0, rt + RH, HW, H); g.clip();
    g.fillStyle = C["--panel"]; g.fillRect(0, RH, HW, H - RH);
    p.tracks.forEach((tr, i) => {
      const y = laneY(i);
      g.fillStyle = tr.id === store.selTrack ? C["--lane-sel"] : C["--panel"]; g.fillRect(0, y, HW, L);
      g.fillStyle = tr.color; g.fillRect(0, y, 5, L);
      g.fillStyle = C["--fg"]; g.font = "600 13px Onest, system-ui, sans-serif"; g.textAlign = "left";
      g.fillText(fitText(tr.name, HW - 28), 12, y + 21);
      if (tr.auto.length) { g.fillStyle = C["--muted"]; g.font = "500 10px 'JetBrains Mono', monospace"; g.fillText("рух", HW - 30, y + 21); }
      const by = y + 30;
      if (L >= 50) HB.forEach(bt => {
        const on = bt.act === "mute" ? tr.mute : bt.act === "solo" ? tr.solo : bt.act === "arm" ? tr.arm : tr.mode === "3d";
        const col = bt.act === "mute" ? C["--mute"] : bt.act === "solo" ? C["--solo"] : bt.act === "arm" ? C["--rec"] : tr.color;
        roundRect(bt.x, by, bt.w, 18, 4);
        g.fillStyle = on ? col : C["--panel-2"]; g.fill();
        g.strokeStyle = "rgba(0,0,0,.6)"; g.lineWidth = 1; g.stroke();
        g.fillStyle = on ? (bt.act === "arm" ? "#fff" : C["--region-text"]) : bt.act === "arm" ? C["--rec"] : C["--muted"];
        g.font = "600 11px Onest, system-ui, sans-serif"; g.textAlign = "center";
        g.fillText(bt.act === "mode" ? (tr.mode === "3d" ? "3D" : "ST") : bt.label, bt.x + bt.w / 2, by + 13);
      });
      g.textAlign = "left";
      g.strokeStyle = C["--line"]; g.lineWidth = 1; g.beginPath(); g.moveTo(0, y + L - 0.5); g.lineTo(W, y + L - 0.5); g.stroke();
    });
    g.fillStyle = C["--muted"]; g.font = "500 12px Onest, system-ui, sans-serif";
    g.fillText("+ перетягніть аудіо сюди", 14, laneY(n) + L / 2 + 4);
    if (drag && drag.kind === "reorder" && drag.active) {
      g.fillStyle = C["--accent"]; g.fillRect(0, laneY(drag.to) - 2, W, 3);
    }
    g.restore();

    // лінійка (липка: малюється на висоті прокрутки)
    g.fillStyle = C["--panel-2"]; g.fillRect(0, rt, W, RH);
    g.strokeStyle = C["--line"]; g.beginPath(); g.moveTo(0, rt + RH - 0.5); g.lineTo(W, rt + RH - 0.5); g.stroke();
    g.save(); g.beginPath(); g.rect(HW, rt, W - HW, RH); g.clip();
    g.fillStyle = C["--muted"]; g.font = "500 11px 'JetBrains Mono', monospace"; g.textAlign = "left";
    if (store.rulerMode === "bars") {
      const barEvery = Math.max(1, Math.ceil(46 / (b * 4 * store.zoom)));
      for (let bar = Math.max(0, Math.floor(t0 / (b * 4))); bar * b * 4 <= t1; bar++) {
        if (bar % barEvery) continue;
        const x = tx(bar * b * 4);
        g.fillRect(x, rt + RH - 8, 1, 8);
        g.fillText(String(bar + 1), x + 4, rt + 22);
      }
    } else {
      const { step } = timeGrid();
      for (let k = Math.max(0, Math.floor(t0 / step)); k * step <= t1; k++) {
        const t = k * step, x = tx(t), m = Math.floor(t / 60), s = t - m * 60;
        g.fillRect(x, rt + RH - 8, 1, 8);
        g.fillText(`${m}:${(step < 1 ? s.toFixed(step < 0.1 ? 2 : 1) : String(Math.round(s))).padStart(step < 1 ? 4 : 2, "0")}`, x + 4, rt + 22);
      }
    }
    if (p.loop.on) {
      g.fillStyle = C["--cycle"]; g.globalAlpha = 0.9;
      roundRect(tx(p.loop.a), rt + 2, Math.max(0, tx(p.loop.b) - tx(p.loop.a)), 10, 3); g.fill();
      g.globalAlpha = 1;
    }
    p.markers.forEach(m => {
      const x = tx(m.t);
      g.fillStyle = C["--marker"];
      g.beginPath(); g.moveTo(x, rt + 14); g.lineTo(x + 7, rt + 18); g.lineTo(x, rt + 22); g.fill();
      g.fillRect(x, rt + 14, 1.5, RH - 14);
      g.font = "600 10px Onest, system-ui, sans-serif"; g.fillText(fitText(m.name, 120), x + 9, rt + 25);
    });
    g.restore();
    g.fillStyle = C["--panel-2"]; g.fillRect(0, rt, HW, RH);
    g.fillStyle = C["--muted"]; g.font = "500 11px 'JetBrains Mono', monospace"; g.textAlign = "left";
    g.fillText(store.rulerMode === "bars" ? `${p.bpm} BPM · такти` : "хв:сек", 12, rt + 19);
    g.strokeStyle = C["--line"]; g.beginPath(); g.moveTo(HW - 0.5, rt); g.lineTo(HW - 0.5, H); g.stroke();
    // плейхед
    const px = tx(pos);
    if (px >= HW && px <= W) {
      g.fillStyle = store.recording ? C["--rec"] : C["--playhead"];
      g.fillRect(Math.round(px), rt, 1.5, H - rt);
      g.beginPath(); g.moveTo(px - 6, rt); g.lineTo(px + 6, rt); g.lineTo(px, rt + 8); g.fill();
    }
    if (store.playing && !drag && (px > W - 30 || px < HW)) store.scroll = Math.max(0, pos - 1);
    syncScroll();
  }
  function syncScroll() {
    const max = Math.max(projectEnd() + 10, store.scroll + visibleSecs());
    scrollIn.max = String(Math.max(0, max - visibleSecs()));
    if (document.activeElement !== scrollIn) scrollIn.value = String(store.scroll);
  }
  scrollIn.addEventListener("input", () => { store.scroll = +scrollIn.value; });

  /* ---------- влучання ---------- */
  const evPos = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  function clipAt(x, y) {
    const i = laneAt(y), tr = tracks()[i];
    if (!tr || x < HW) return null;
    const ly = y - laneY(i);
    for (let k = tr.clips.length - 1; k >= 0; k--) {
      const c = tr.clips[k], x1 = tx(c.start), x2 = tx(c.start + c.dur);
      if (x < x1 - 3 || x > x2 + 3) continue;
      let zone = "body";
      if (ly < 16) {
        if (Math.abs(x - (x1 + (c.fi || 0) * store.zoom)) < 7) zone = "fi";
        else if (Math.abs(x - (x2 - (c.fo || 0) * store.zoom)) < 7) zone = "fo";
      }
      if (zone === "body" && x2 - x1 > 18) { if (x - x1 < 6) zone = "L"; else if (x2 - x < 6) zone = "R"; }
      return { tr, c, zone, lane: i };
    }
    return null;
  }
  function markerAt(x) {
    let best = null, bd = 6;
    store.p.markers.forEach(m => { const d = Math.abs(tx(m.t) - x); if (d < bd) { bd = d; best = m; } });
    return best;
  }
  const ensureCk = () => { if (drag && !drag.ck) { checkpoint(); drag.ck = true; } };

  /* ---------- миша ---------- */
  cv.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    const [x, y] = evPos(e), rt = top();
    hooks.closeMenus();
    if (y < rt + RH) {
      if (x < HW) return;
      cv.setPointerCapture(e.pointerId);
      const mk = markerAt(x);
      if (mk) { drag = { kind: "marker", id: mk.id }; seek(mk.t); return; }
      if (e.shiftKey) { const t = snapT(xt(x), e); drag = { kind: "loop", a: t }; return; }
      drag = { kind: "seek" }; seek(Math.max(0, xt(x)));
      return;
    }
    const lane = laneAt(y), tr = tracks()[lane];
    if (x < HW) {
      if (!tr) return;
      const b = headerBtnAt(x, y);
      if (b) { hooks.trackAction(b.tr, b.act); return; }
      store.selTrack = tr.id; notify("select");
      cv.setPointerCapture(e.pointerId);
      drag = { kind: "reorder", from: lane, to: lane, y0: y };
      return;
    }
    cv.setPointerCapture(e.pointerId);
    const hit = clipAt(x, y);
    if (hit) {
      const id = hit.c.id, mod = e.ctrlKey || e.metaKey;
      const wasSel = store.sel.has(id);
      if (e.shiftKey) store.sel.add(id);
      else if (!wasSel && !mod) selectOnly(id);
      store.selTrack = hit.tr.id; notify("select");
      if (hit.zone === "body") {
        drag = { kind: "move", id, x0: x, y0: y, lane0: lane, mod, wasSel, moved: false,
          origs: selected().concat(mod && !wasSel ? [{ t: hit.tr, c: hit.c }] : []).map(({ t, c }) => ({ id: c.id, start: c.start, lane: tracks().indexOf(t) })) };
      } else drag = { kind: hit.zone, id, x0: x, orig: { ...hit.c } };
      return;
    }
    drag = { kind: "marquee", x0: x, y0: y, x1: x, y1: y, add: e.shiftKey, base: new Set(store.sel), lane, active: false };
  });

  cv.addEventListener("pointermove", e => {
    const [x, y] = evPos(e);
    if (!drag) { setCursor(x, y); return; }
    const k = drag.kind;
    if (k === "seek") { if (!store.playing) seek(Math.max(0, xt(x))); return; }
    if (k === "loop") {
      ensureCk();
      const t = snapT(xt(x), e);
      store.p.loop = { on: true, a: Math.max(0, Math.min(drag.a, t)), b: Math.max(drag.a, t) };
      return;
    }
    if (k === "marker") { ensureCk(); const m = store.p.markers.find(m => m.id === drag.id); if (m) m.t = Math.max(0, snapT(xt(x), e)); return; }
    if (k === "reorder") {
      if (Math.abs(y - drag.y0) > 4) drag.active = true;
      drag.to = clamp(Math.round((y - RH) / lh()), 0, tracks().length);
      return;
    }
    if (k === "marquee") {
      drag.x1 = Math.max(HW, x); drag.y1 = y;
      if (Math.hypot(x - drag.x0, y - drag.y0) > 4) drag.active = true;
      if (drag.active) {
        const ta = xt(Math.min(drag.x0, drag.x1)), tb = xt(Math.max(drag.x0, drag.x1));
        const la = laneAt(Math.min(drag.y0, drag.y1)), lb = laneAt(Math.max(drag.y0, drag.y1));
        const s = drag.add ? new Set(drag.base) : new Set();
        tracks().forEach((tr, i) => { if (i >= la && i <= lb) tr.clips.forEach(c => { if (c.start < tb && c.start + c.dur > ta) s.add(c.id); }); });
        store.sel = s;
      }
      return;
    }
    if (k === "move") {
      if (!drag.moved && Math.hypot(x - drag.x0, y - drag.y0) < 4) return;
      if (!drag.moved) {
        drag.moved = true; ensureCk();
        if (drag.mod) { // Ctrl + перетягування = копія
          const map = new Map();
          drag.origs.forEach(o => {
            const f = findClip(o.id), nc = { ...f.c, id: uid() };
            f.t.clips.push(nc); map.set(o.id, nc.id);
          });
          drag.origs.forEach(o => (o.id = map.get(o.id)));
          drag.id = map.get(drag.id);
          store.sel = new Set(map.values());
        }
      }
      const ids = new Set(drag.origs.map(o => o.id));
      const prim = drag.origs.find(o => o.id === drag.id), pc = findClip(drag.id).c;
      let ns = snapMove(prim.start + (x - drag.x0) / store.zoom, pc.dur, e, ids);
      let delta = ns - prim.start;
      delta = Math.max(delta, -Math.min(...drag.origs.map(o => o.start)));
      const n = tracks().length;
      let ld = laneAt(y) - drag.lane0;
      ld = clamp(ld, -Math.min(...drag.origs.map(o => o.lane)), n - 1 - Math.max(...drag.origs.map(o => o.lane)));
      drag.origs.forEach(o => {
        const f = findClip(o.id);
        if (!f) return;
        f.c.start = o.start + delta;
        const to = tracks()[o.lane + ld];
        if (to && to !== f.t) { f.t.clips = f.t.clips.filter(c => c !== f.c); to.clips.push(f.c); }
      });
      return;
    }
    const f = findClip(drag.id);
    if (!f) return;
    ensureCk();
    const { c } = f, o = drag.orig, dt = (x - drag.x0) / store.zoom, buf = buffers.get(c.buf), ex = new Set([c.id]);
    if (k === "L") {
      let s = snapT(o.start + dt, e, ex);
      s = clamp(s, Math.max(0, o.start - o.offset), o.start + o.dur - 0.02);
      c.offset = o.offset + (s - o.start); c.dur = o.dur - (s - o.start); c.start = s;
      c.fi = Math.min(c.fi, c.dur); c.fo = Math.min(c.fo, c.dur - c.fi);
    } else if (k === "R") {
      const end = snapT(o.start + o.dur + dt, e, ex);
      c.dur = clamp(end - c.start, 0.02, (buf ? buf.duration : 1e9) - c.offset);
      c.fo = Math.min(c.fo, c.dur); c.fi = Math.min(c.fi, c.dur - c.fo);
    } else if (k === "fi") c.fi = clamp((o.fi || 0) + dt, 0, c.dur - (c.fo || 0));
    else if (k === "fo") c.fo = clamp((o.fo || 0) - dt, 0, c.dur - (c.fi || 0));
  });

  function up(e) {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.kind === "loop") {
      if (store.p.loop.b - store.p.loop.a < 0.05) store.p.loop.on = false;
      notify("transport");
    } else if (d.kind === "reorder" && d.active && d.to !== d.from && d.to !== d.from + 1) {
      checkpoint();
      const arr = tracks(), [tr] = arr.splice(d.from, 1);
      arr.splice(d.to > d.from ? d.to - 1 : d.to, 0, tr);
      notify("structure");
    } else if (d.kind === "marquee" && !d.active) {
      if (!d.add) store.sel.clear();
      const tr = tracks()[d.lane];
      if (tr) store.selTrack = tr.id;
      notify("select");
      seek(Math.max(0, snapT(xt(d.x0), e)));
    } else if (d.kind === "marquee") notify("select");
    else if (d.kind === "move") {
      if (!d.moved && d.mod) { if (d.wasSel) store.sel.delete(d.id); else store.sel.add(d.id); notify("select"); }
      else if (!d.moved && !d.mod && !(e && e.shiftKey)) { selectOnly(d.id); notify("select"); }
      if (d.moved) { reschedule(); notify("structure"); }
    } else if (["L", "R", "fi", "fo"].includes(d.kind) && d.ck) { reschedule(); notify("structure"); }
  }
  cv.addEventListener("pointerup", up);
  cv.addEventListener("pointercancel", () => up(null));
  function setCursor(x, y) {
    if (y < top() + RH) { cv.style.cursor = x > HW ? (markerAt(x) ? "ew-resize" : "pointer") : "default"; return; }
    if (x < HW) { cv.style.cursor = headerBtnAt(x, y) ? "pointer" : tracks()[laneAt(y)] ? "grab" : "default"; return; }
    const h = clipAt(x, y);
    cv.style.cursor = !h ? "crosshair" : h.zone === "body" ? "grab" : h.zone === "fi" || h.zone === "fo" ? "nesw-resize" : "ew-resize";
  }
  cv.addEventListener("dblclick", e => {
    const [x, y] = evPos(e);
    if (y < top() + RH) { const m = markerAt(x); if (m) renameMarker(m, e); return; }
    if (x < HW) { const tr = tracks()[laneAt(y)]; if (tr && !headerBtnAt(x, y)) hooks.editText(e.clientX, e.clientY, tr.name, v => { checkpoint(); tr.name = v; notify("structure"); }); return; }
    const h = clipAt(x, y);
    if (h) renameClip(h.c, e);
  });
  wrap.addEventListener("wheel", e => {
    const [x] = evPos(e);
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const t = xt(Math.max(HW, x));
      store.zoom = clamp(store.zoom * Math.exp(-e.deltaY * 0.0025), 2, 800);
      store.scroll = Math.max(0, t - (Math.max(HW, x) - HW) / store.zoom);
    } else if (e.altKey) {
      e.preventDefault();
      laneZoom(e.deltaY < 0 ? 1.15 : 1 / 1.15);
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
      e.preventDefault();
      store.scroll = Math.max(0, store.scroll + (e.deltaX || e.deltaY) / store.zoom);
    }
  }, { passive: false });
  wrap.addEventListener("dragover", e => { e.preventDefault(); e.stopPropagation(); wrap.classList.add("drop"); });
  wrap.addEventListener("dragleave", () => wrap.classList.remove("drop"));
  wrap.addEventListener("drop", e => {
    e.preventDefault(); e.stopPropagation(); wrap.classList.remove("drop");
    const [x, y] = evPos(e), tr = tracks()[laneAt(y)];
    if (e.dataTransfer.files.length) hooks.dropFiles([...e.dataTransfer.files], tr || null, Math.max(0, snapT(xt(x))));
  });

  /* ---------- контекстне меню ---------- */
  cv.addEventListener("contextmenu", e => {
    e.preventDefault();
    const [x, y] = evPos(e), rt = top(), t = Math.max(0, xt(x));
    let items;
    if (y < rt + RH) {
      const m = x > HW && markerAt(x);
      items = m ? [
        { label: "Перейменувати маркер", run: () => renameMarker(m, e) },
        { label: "Видалити маркер", run: () => { checkpoint(); store.p.markers = store.p.markers.filter(q => q !== m); } }
      ] : [
        { label: "Додати маркер тут", kbd: "M", run: () => addMarker(snapT(t)) },
        { label: "Початок циклу тут", kbd: "I", run: () => setLoopEdge("a", snapT(t)) },
        { label: "Кінець циклу тут", kbd: "O", run: () => setLoopEdge("b", snapT(t)) }
      ];
    } else if (x < HW) {
      const i = laneAt(y), tr = tracks()[i];
      if (!tr) { items = [{ label: "Нова доріжка", kbd: "N", run: () => hooks.newTrack() }]; }
      else {
        store.selTrack = tr.id; notify("select");
        items = [
          { label: "Перейменувати", run: () => hooks.editText(e.clientX, e.clientY, tr.name, v => { checkpoint(); tr.name = v; notify("structure"); }) },
          { label: "Дублювати доріжку", run: () => duplicateTrack(tr) },
          { label: "Перемістити вгору", disabled: i === 0, run: () => moveTrack(i, -1) },
          { label: "Перемістити вниз", disabled: i === tracks().length - 1, run: () => moveTrack(i, 1) },
          "-",
          { label: "Виділити всі кліпи доріжки", run: () => { store.sel = new Set(tr.clips.map(c => c.id)); notify("select"); } },
          { label: "Видалити доріжку", danger: true, run: () => { checkpoint(); removeTrackLive(tr.id); store.p.tracks = tracks().filter(q => q !== tr); notify("structure"); } }
        ];
      }
    } else {
      const h = clipAt(x, y);
      if (h) {
        if (!store.sel.has(h.c.id)) selectOnly(h.c.id);
        store.selTrack = h.tr.id; notify("select");
        items = [
          { label: "Розрізати в позиції плейхеда", kbd: "S", run: split },
          { label: "Розрізати тут", run: () => splitAt(snapT(t), [h]) },
          "-",
          { label: "Копіювати", kbd: "Ctrl C", run: copy },
          { label: "Вирізати", kbd: "Ctrl X", run: cut },
          { label: "Дублювати", kbd: "Ctrl D", run: duplicate },
          { label: "Видалити", kbd: "Del", danger: true, run: remove },
          "-",
          { label: "Перейменувати", run: () => renameClip(h.c, e) },
          { label: h.c.muted ? "Увімкнути кліп" : "Вимкнути кліп", kbd: "U", run: toggleMute },
          { label: "Нормалізувати гучність", run: normalize },
          { label: "Реверс", run: reverse },
          { label: "Прибрати фейди й гейн", run: resetClip }
        ];
      } else {
        const tr = tracks()[laneAt(y)];
        if (tr) { store.selTrack = tr.id; notify("select"); }
        items = [
          { label: "Вставити", kbd: "Ctrl V", disabled: !store.clipboard, run: () => paste(snapT(t)) },
          { label: "Додати маркер тут", kbd: "M", run: () => addMarker(snapT(t)) },
          { label: "Виділити всі кліпи", kbd: "Ctrl A", run: selectAll }
        ];
      }
    }
    hooks.contextMenu(items, e.clientX, e.clientY);
  });

  /* ---------- операції ---------- */
  const done = () => { reschedule(); notify("structure"); return true; };
  function splitAt(t, list) {
    const hits = list.filter(({ c }) => t > c.start + 0.01 && t < c.start + c.dur - 0.01);
    if (!hits.length) return false;
    checkpoint();
    hits.forEach(({ t: tr, c }) => {
      const nc = { ...c, id: uid(), start: t, offset: c.offset + (t - c.start), dur: c.start + c.dur - t, fi: 0 };
      c.dur = t - c.start; c.fo = 0; c.fi = Math.min(c.fi, c.dur);
      nc.fo = Math.min(nc.fo, nc.dur);
      tr.clips.push(nc);
    });
    return done();
  }
  function split() {
    let list = selected();
    if (!list.length) { const tr = findTrack(store.selTrack); list = tr ? tr.clips.map(c => ({ t: tr, c })) : []; }
    return splitAt(now(), list);
  }
  function duplicate() {
    const list = selected();
    if (!list.length) return false;
    checkpoint();
    const a = Math.min(...list.map(x => x.c.start)), z = Math.max(...list.map(x => x.c.start + x.c.dur)), shift = z - a;
    const ids = [];
    list.forEach(({ t, c }) => { const nc = { ...c, id: uid(), start: c.start + shift }; t.clips.push(nc); ids.push(nc.id); });
    store.sel = new Set(ids);
    return done();
  }
  function remove() {
    const list = selected();
    if (!list.length) return false;
    checkpoint();
    list.forEach(({ t, c }) => { t.clips = t.clips.filter(q => q !== c); });
    store.sel.clear();
    return done();
  }
  function copy() {
    const list = selected();
    if (!list.length) return false;
    const a = Math.min(...list.map(x => x.c.start)), l0 = Math.min(...list.map(x => tracks().indexOf(x.t)));
    store.clipboard = list.map(({ t, c }) => ({ lane: tracks().indexOf(t) - l0, clip: { ...c, start: c.start - a } }));
    hooks.status(`Скопійовано кліпів: ${list.length}.`);
    return true;
  }
  function cut() { if (!copy()) return false; return remove(); }
  function paste(at = now()) {
    if (!store.clipboard || !tracks().length) return false;
    checkpoint();
    const base = Math.max(0, tracks().findIndex(t => t.id === store.selTrack)), ids = [];
    store.clipboard.forEach(({ lane, clip }) => {
      const tr = tracks()[Math.min(tracks().length - 1, base + lane)];
      const nc = { ...clip, id: uid(), start: at + clip.start };
      tr.clips.push(nc); ids.push(nc.id);
    });
    store.sel = new Set(ids);
    return done();
  }
  function selectAll() { store.sel = new Set(tracks().flatMap(t => t.clips.map(c => c.id))); notify("select"); return true; }
  function deselect() { if (!store.sel.size) return false; store.sel.clear(); notify("select"); return true; }
  function nudge(dir, fine) {
    const list = selected();
    if (!list.length) return false;
    checkpoint(false);
    const step = fine ? 0.01 : snapStep() || 0.1;
    const d = Math.max(dir * step, -Math.min(...list.map(x => x.c.start)));
    list.forEach(({ c }) => (c.start += d));
    return done();
  }
  function toggleMute() {
    const list = selected();
    if (!list.length) return false;
    checkpoint();
    const v = !list.every(x => x.c.muted);
    list.forEach(({ c }) => (c.muted = v));
    return done();
  }
  function normalize() {
    const list = selected();
    if (!list.length) return false;
    checkpoint();
    list.forEach(({ c }) => {
      const b = buffers.get(c.buf);
      if (!b) return;
      const s = Math.floor(c.offset * b.sampleRate), e = Math.min(b.length, Math.ceil((c.offset + c.dur) * b.sampleRate));
      let pk = 0;
      for (let ch = 0; ch < b.numberOfChannels; ch++) { const d = b.getChannelData(ch); for (let i = s; i < e; i++) { const a = Math.abs(d[i]); if (a > pk) pk = a; } }
      if (pk > 0) c.gain = clamp(Math.round((-20 * Math.log10(pk) - 0.3) * 10) / 10, -24, 24);
    });
    hooks.status("Гучність кліпів вирівняно до −0,3 dBFS (без зміни аудіо).");
    return done();
  }
  function reverse() {
    const list = selected();
    if (!list.length) return false;
    checkpoint();
    const made = new Map();
    list.forEach(({ c }) => {
      const b = buffers.get(c.buf);
      if (!b) return;
      let id = made.get(c.buf);
      if (!id) {
        const r = new AudioBuffer({ length: b.length, numberOfChannels: b.numberOfChannels, sampleRate: b.sampleRate });
        for (let ch = 0; ch < b.numberOfChannels; ch++) { const d = b.getChannelData(ch).slice(); d.reverse(); r.copyToChannel(d, ch); }
        id = uid(); buffers.set(id, r); made.set(c.buf, id);
      }
      c.offset = Math.max(0, b.duration - c.offset - c.dur); c.buf = id;
      const fi = c.fi; c.fi = c.fo; c.fo = fi;
    });
    return done();
  }
  function resetClip() {
    const list = selected();
    if (!list.length) return false;
    checkpoint();
    list.forEach(({ c }) => { c.fi = 0; c.fo = 0; c.gain = 0; });
    return done();
  }
  function renameClip(c, e) {
    hooks.editText(e.clientX, e.clientY, c.name || "", v => { checkpoint(); c.name = v; notify("structure"); });
  }
  function renameMarker(m, e) {
    hooks.editText(e.clientX, e.clientY, m.name, v => { checkpoint(); m.name = v; });
  }
  function addMarker(t = now()) {
    checkpoint();
    const n = store.p.markers.length + 1;
    store.p.markers.push({ id: uid(), t, name: "Маркер " + n });
    store.p.markers.sort((a, b) => a.t - b.t);
    hooks.status(`Додано маркер ${n}. Подвійний клік по ньому на лінійці — перейменувати.`);
    return true;
  }
  function gotoMarker(dir) {
    const t = now(), eps = 0.02;
    const pts = [0, projectEnd(), ...store.p.markers.map(m => m.t)].sort((a, b) => a - b);
    const target = dir > 0 ? pts.find(v => v > t + eps) : [...pts].reverse().find(v => v < t - eps);
    if (target === undefined) return false;
    seek(target);
    return true;
  }
  function setLoopEdge(edge, t = now()) {
    checkpoint();
    const L = store.p.loop;
    L[edge] = t;
    if (L.b <= L.a) { if (edge === "a") L.b = L.a + 240 / store.p.bpm; else L.a = Math.max(0, L.b - 240 / store.p.bpm); }
    L.on = true;
    notify("transport");
    return true;
  }
  function moveTrack(i, d) {
    const arr = tracks(), j = i + d;
    if (j < 0 || j >= arr.length) return;
    checkpoint();
    [arr[i], arr[j]] = [arr[j], arr[i]];
    notify("structure");
  }
  function duplicateTrack(tr) {
    checkpoint();
    const copyTr = JSON.parse(JSON.stringify(tr));
    copyTr.id = uid(); copyTr.name = tr.name + " (копія)"; copyTr.arm = false;
    copyTr.clips.forEach(c => (c.id = uid()));
    tracks().splice(tracks().indexOf(tr) + 1, 0, copyTr);
    store.selTrack = copyTr.id;
    hooks.trackAdded(copyTr);
    notify("structure");
  }
  function selectTrackDelta(d) {
    const i = tracks().findIndex(t => t.id === store.selTrack), j = clamp(i + d, 0, tracks().length - 1);
    if (tracks()[j]) { store.selTrack = tracks()[j].id; notify("select"); }
  }
  function zoomBy(k) {
    const center = store.playing ? now() : store.playhead;
    const x = clamp(tx(center), HW, W);
    store.zoom = clamp(store.zoom * k, 2, 800);
    store.scroll = Math.max(0, center - (x - HW) / store.zoom);
  }
  function laneZoom(k) { store.laneH = clamp(Math.round(store.laneH * k), 44, 160); resize(); }
  function fit() {
    const end = Math.max(8, projectEnd() + 2);
    store.zoom = clamp((W - HW - 16) / end, 2, 800);
    store.scroll = 0;
  }
  function revealPlayhead() {
    const x = tx(now());
    if (x < HW || x > W - 20) store.scroll = Math.max(0, now() - visibleSecs() / 4);
  }
  const setRecGhost = v => { recGhost = v; };
  return {
    draw, resize, fit, zoomBy, laneZoom, setRecGhost, revealPlayhead,
    split, duplicate, remove, copy, cut, paste, selectAll, deselect, nudge, toggleMute, normalize, reverse, resetClip,
    addMarker, gotoMarker, setLoopEdge, selectTrackDelta, snapStep
  };
}
