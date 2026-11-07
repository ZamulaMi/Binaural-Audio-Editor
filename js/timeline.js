import { clamp, css, uid } from "./util.js";
import { store, buffers, findClip, findTrack, checkpoint, notify, projectEnd } from "./state.js";
import { now, seek, reschedule } from "./engine.js";
import { peaksOf, SPP } from "./peaks.js";

export const RH = 28, LH = 58, HW = 156;

/** Часова шкала: доріжки, кліпи, плейхед, цикл. Малюється на canvas. */
export function initTimeline(cv, wrap, scrollIn, hooks) {
  const g = cv.getContext("2d");
  let W = 0, H = 0, drag = null, recGhost = null;

  const tx = t => HW + (t - store.scroll) * store.zoom;
  const xt = x => store.scroll + (x - HW) / store.zoom;
  const beat = () => 60 / store.p.bpm;
  const snapT = (t, e) => (store.snap && !(e && e.altKey) ? Math.round(t / (beat() / 4)) * (beat() / 4) : t);

  function resize() {
    if (!store.p) return;
    const dpr = window.devicePixelRatio || 1;
    W = wrap.clientWidth;
    H = RH + (store.p.tracks.length + 1) * LH;
    cv.style.height = H + "px";
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  new ResizeObserver(() => resize()).observe(wrap);

  function fit() {
    const end = Math.max(8, projectEnd() + 2);
    store.zoom = clamp((W - HW - 16) / end, 4, 400);
    store.scroll = 0;
  }
  function visibleSecs() { return (W - HW) / store.zoom; }

  function draw() {
    if (!W) resize();
    const p = store.p, C = css(), pos = now();
    g.clearRect(0, 0, W, H);
    g.fillStyle = C["--panel"]; g.fillRect(0, 0, W, H);
    // доріжки
    p.tracks.forEach((tr, i) => {
      const y = RH + i * LH;
      g.fillStyle = i % 2 ? C["--panel"] : C["--panel-2"];
      g.fillRect(HW, y, W - HW, LH);
    });
    g.fillStyle = C["--bg"]; g.globalAlpha = 0.5; g.fillRect(HW, RH + p.tracks.length * LH, W - HW, LH); g.globalAlpha = 1;
    // сітка тактів
    const b = beat(), pxBeat = b * store.zoom, t0 = xt(HW), t1 = xt(W);
    const every = pxBeat >= 12 ? 1 : pxBeat * 4 >= 12 ? 4 : pxBeat * 16 >= 14 ? 16 : 64;
    for (let k = Math.floor(t0 / b / every) * every; k * b <= t1; k += every) {
      if (k < 0) continue;
      const x = Math.round(tx(k * b)) + 0.5, bar = k % 4 === 0;
      g.strokeStyle = C["--line"]; g.globalAlpha = bar ? 0.9 : 0.4;
      g.beginPath(); g.moveTo(x, RH); g.lineTo(x, H); g.stroke();
    }
    g.globalAlpha = 1;
    // цикл
    if (p.loop.on) {
      g.fillStyle = C["--accent"]; g.globalAlpha = 0.08;
      g.fillRect(Math.max(HW, tx(p.loop.a)), RH, Math.max(0, tx(p.loop.b) - Math.max(HW, tx(p.loop.a))), H - RH);
      g.globalAlpha = 1;
    }
    // кліпи
    g.save(); g.beginPath(); g.rect(HW, RH, W - HW, H - RH); g.clip();
    p.tracks.forEach((tr, i) => {
      const y = RH + i * LH + 5, h = LH - 10;
      tr.clips.forEach(c => {
        const x1 = tx(c.start), x2 = tx(c.start + c.dur);
        if (x2 < HW || x1 > W) return;
        const sel = c.id === store.selClip;
        g.fillStyle = tr.color; g.globalAlpha = sel ? 0.34 : 0.2;
        roundRect(x1, y, x2 - x1, h, 5); g.fill();
        g.globalAlpha = 1;
        const buf = buffers.get(c.buf);
        if (buf) {
          const pk = peaksOf(buf), mid = y + h / 2 + 5, amp = (h - 16) / 2;
          g.fillStyle = tr.color; g.globalAlpha = 0.9;
          const from = Math.max(x1, HW), to = Math.min(x2, W);
          for (let x = Math.floor(from); x < to; x++) {
            const t = c.offset + (x - x1) / store.zoom, k = Math.floor(t * buf.sampleRate / SPP);
            const k2 = Math.max(k + 1, Math.floor((t + 1 / store.zoom) * buf.sampleRate / SPP));
            let m = 0;
            for (let j = k; j < k2 && j < pk.length; j++) if (pk[j] > m) m = pk[j];
            const hh = Math.max(1, m * amp);
            g.fillRect(x, mid - hh, 1, hh * 2);
          }
          g.globalAlpha = 1;
        }
        g.strokeStyle = sel ? C["--fg"] : tr.color; g.lineWidth = sel ? 2 : 1;
        roundRect(x1 + 0.5, y + 0.5, x2 - x1 - 1, h - 1, 5); g.stroke();
        if (x2 - x1 > 30) {
          g.fillStyle = C["--fg"]; g.font = "600 11px Onest, system-ui, sans-serif"; g.textAlign = "left";
          g.fillText(clipText(c.name || tr.name, x2 - Math.max(x1, HW) - 12), Math.max(x1, HW) + 6, y + 13);
        }
      });
      // позначка записаної траєкторії
      if (tr.auto.length > 1) {
        const a = tr.auto[0].t, z = tr.auto[tr.auto.length - 1].t;
        g.strokeStyle = tr.color; g.lineWidth = 2; g.setLineDash([2, 3]);
        g.beginPath(); g.moveTo(tx(a), y + h + 2); g.lineTo(tx(z), y + h + 2); g.stroke(); g.setLineDash([]);
      }
    });
    if (recGhost) {
      const i = p.tracks.findIndex(t => t.id === recGhost.track);
      const y = RH + (i < 0 ? p.tracks.length : i) * LH + 5;
      g.fillStyle = C["--rec"]; g.globalAlpha = 0.3;
      roundRect(tx(recGhost.start), y, Math.max(2, (pos - recGhost.start) * store.zoom), LH - 10, 5); g.fill();
      g.globalAlpha = 1;
    }
    g.restore();
    // лінійка
    g.fillStyle = C["--panel-2"]; g.fillRect(0, 0, W, RH);
    g.strokeStyle = C["--line"]; g.beginPath(); g.moveTo(0, RH - 0.5); g.lineTo(W, RH - 0.5); g.stroke();
    g.fillStyle = C["--muted"]; g.font = "500 11px 'JetBrains Mono', monospace"; g.textAlign = "left";
    const barEvery = Math.max(1, Math.ceil(46 / (pxBeat * 4)));
    for (let bar = Math.max(0, Math.floor(t0 / (b * 4))); bar * b * 4 <= t1; bar++) {
      if (bar % barEvery) continue;
      const x = tx(bar * b * 4);
      if (x < HW) continue;
      g.fillRect(x, RH - 8, 1, 8);
      g.fillText(String(bar + 1), x + 3, 17);
    }
    if (p.loop.on) {
      g.fillStyle = C["--accent"];
      const a = tx(p.loop.a), z = tx(p.loop.b);
      if (z > HW) g.fillRect(Math.max(HW, a), RH - 5, Math.max(0, z - Math.max(HW, a)), 4);
    }
    // заголовки доріжок
    g.fillStyle = C["--panel"]; g.fillRect(0, RH, HW, H - RH);
    p.tracks.forEach((tr, i) => {
      const y = RH + i * LH;
      if (tr.id === store.selTrack) { g.fillStyle = C["--panel-2"]; g.fillRect(0, y, HW, LH); }
      g.fillStyle = tr.color; g.fillRect(0, y + 6, 4, LH - 12);
      g.fillStyle = C["--fg"]; g.font = "600 13px Onest, system-ui, sans-serif"; g.textAlign = "left";
      g.fillText(clipText(tr.name, HW - 24), 14, y + 24);
      g.fillStyle = C["--muted"]; g.font = "500 11px 'JetBrains Mono', monospace";
      const tags = [tr.mode === "3d" ? "3D" : "ST", tr.mute ? "M" : "", tr.solo ? "S" : "", tr.auto.length ? "рух" : ""].filter(Boolean).join(" · ");
      g.fillText(tags, 14, y + 42);
      if (tr.arm) { g.fillStyle = C["--rec"]; g.beginPath(); g.arc(HW - 16, y + 20, 5, 0, Math.PI * 2); g.fill(); }
      g.strokeStyle = C["--line"]; g.beginPath(); g.moveTo(0, y + LH - 0.5); g.lineTo(W, y + LH - 0.5); g.stroke();
    });
    g.fillStyle = C["--muted"]; g.font = "500 12px Onest, system-ui, sans-serif";
    g.fillText("+ перетягніть аудіо сюди", 14, RH + p.tracks.length * LH + 34);
    g.fillStyle = C["--panel-2"]; g.fillRect(0, 0, HW, RH);
    g.fillStyle = C["--muted"]; g.font = "500 11px 'JetBrains Mono', monospace";
    g.fillText(`${p.bpm} BPM · такти`, 14, 18);
    g.strokeStyle = C["--line"]; g.beginPath(); g.moveTo(HW - 0.5, 0); g.lineTo(HW - 0.5, H); g.stroke();
    // плейхед
    const px = tx(pos);
    if (px >= HW && px <= W) {
      g.fillStyle = store.recording ? C["--rec"] : C["--accent"];
      g.fillRect(Math.round(px) - 1, 0, 2, H);
      g.beginPath(); g.moveTo(px - 6, 0); g.lineTo(px + 6, 0); g.lineTo(px, 8); g.fill();
    }
    // автоскрол
    if (store.playing && !drag && (px > W - 30 || px < HW)) { store.scroll = Math.max(0, pos - 1); }
    syncScroll();
  }
  function roundRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  function clipText(s, w) {
    if (g.measureText(s).width <= w) return s;
    while (s.length > 1 && g.measureText(s + "…").width > w) s = s.slice(0, -1);
    return s + "…";
  }
  function syncScroll() {
    const max = Math.max(projectEnd() + 10, store.scroll + visibleSecs());
    scrollIn.max = String(Math.max(0, max - visibleSecs()));
    if (document.activeElement !== scrollIn) scrollIn.value = String(store.scroll);
  }
  scrollIn.addEventListener("input", () => { store.scroll = +scrollIn.value; });

  /* ---------- взаємодія ---------- */
  const evPos = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const laneAt = y => Math.floor((y - RH) / LH);
  function clipAt(x, y) {
    const i = laneAt(y), tr = store.p.tracks[i];
    if (!tr) return null;
    for (let k = tr.clips.length - 1; k >= 0; k--) {
      const c = tr.clips[k], x1 = tx(c.start), x2 = tx(c.start + c.dur);
      if (x >= x1 - 3 && x <= x2 + 3) {
        const edge = x - x1 < 7 && x2 - x1 > 18 ? "L" : x2 - x < 7 && x2 - x1 > 18 ? "R" : null;
        return { tr, c, edge };
      }
    }
    return null;
  }

  cv.addEventListener("pointerdown", e => {
    const [x, y] = evPos(e);
    cv.setPointerCapture(e.pointerId);
    if (y < RH && x > HW) {
      if (e.shiftKey) { checkpoint(); const t = snapT(xt(x), e); drag = { kind: "loop", a: t }; store.p.loop = { on: true, a: t, b: t }; }
      else { drag = { kind: "seek" }; seek(Math.max(0, xt(x))); }
      return;
    }
    const lane = laneAt(y), tr = store.p.tracks[lane];
    if (x < HW) {
      if (tr) { store.selTrack = tr.id; notify("select"); }
      return;
    }
    const hit = clipAt(x, y);
    if (hit) {
      checkpoint();
      store.selClip = hit.c.id; store.selTrack = hit.tr.id; notify("select");
      drag = { kind: hit.edge ? "trim" + hit.edge : "move", id: hit.c.id, x0: x, orig: { ...hit.c }, lane, moved: false };
      return;
    }
    store.selClip = null;
    if (tr) store.selTrack = tr.id;
    notify("select");
    seek(Math.max(0, snapT(xt(x), e)));
  });
  cv.addEventListener("pointermove", e => {
    const [x, y] = evPos(e);
    if (!drag) {
      const h = x > HW && y > RH ? clipAt(x, y) : null;
      cv.style.cursor = h ? (h.edge ? "ew-resize" : "grab") : y < RH && x > HW ? "pointer" : "default";
      return;
    }
    if (drag.kind === "seek") { if (!store.playing) seek(Math.max(0, xt(x))); return; }
    if (drag.kind === "loop") {
      const t = snapT(xt(x), e);
      store.p.loop.a = Math.max(0, Math.min(drag.a, t)); store.p.loop.b = Math.max(drag.a, t);
      return;
    }
    const f = findClip(drag.id);
    if (!f) return;
    const { c } = f, o = drag.orig, dt = (x - drag.x0) / store.zoom, buf = buffers.get(c.buf);
    drag.moved = drag.moved || Math.abs(x - drag.x0) > 2;
    if (drag.kind === "move") {
      c.start = Math.max(0, snapT(o.start + dt, e));
      const lane = clamp(laneAt(y), 0, store.p.tracks.length - 1);
      if (lane !== drag.lane) {
        const from = store.p.tracks[drag.lane], to = store.p.tracks[lane];
        from.clips = from.clips.filter(q => q !== c); to.clips.push(c);
        drag.lane = lane; store.selTrack = to.id;
      }
    } else if (drag.kind === "trimL") {
      let s = snapT(o.start + dt, e);
      s = clamp(s, Math.max(0, o.start - o.offset), o.start + o.dur - 0.05);
      c.offset = o.offset + (s - o.start); c.dur = o.dur - (s - o.start); c.start = s;
    } else if (drag.kind === "trimR") {
      const end = snapT(o.start + o.dur + dt, e);
      c.dur = clamp(end - c.start, 0.05, (buf ? buf.duration : 1e9) - c.offset);
    }
  });
  const up = () => {
    if (drag && drag.kind === "loop" && store.p.loop.b - store.p.loop.a < 0.1) store.p.loop.on = false;
    if (drag && (drag.kind === "move" || drag.kind.startsWith("trim")) && drag.moved) { reschedule(); notify("structure"); }
    if (drag && drag.kind === "loop") notify("transport");
    drag = null;
  };
  cv.addEventListener("pointerup", up);
  cv.addEventListener("pointercancel", up);
  cv.addEventListener("dblclick", e => {
    const [x, y] = evPos(e);
    if (x < HW && store.p.tracks[laneAt(y)]) hooks.renameTrack(store.p.tracks[laneAt(y)]);
  });
  wrap.addEventListener("wheel", e => {
    const [x] = evPos(e);
    if (e.ctrlKey || e.metaKey || e.altKey) {
      e.preventDefault();
      const t = xt(x);
      store.zoom = clamp(store.zoom * Math.exp(-e.deltaY * 0.0025), 4, 400);
      store.scroll = Math.max(0, t - (x - HW) / store.zoom);
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
      e.preventDefault();
      store.scroll = Math.max(0, store.scroll + (e.deltaX || e.deltaY) / store.zoom);
    }
  }, { passive: false });
  // перетягування файлів на доріжку
  wrap.addEventListener("dragover", e => { e.preventDefault(); e.stopPropagation(); wrap.classList.add("drop"); });
  wrap.addEventListener("dragleave", () => wrap.classList.remove("drop"));
  wrap.addEventListener("drop", e => {
    e.preventDefault(); e.stopPropagation(); wrap.classList.remove("drop");
    const [x, y] = evPos(e), tr = store.p.tracks[laneAt(y)];
    const files = [...e.dataTransfer.files];
    if (files.length) hooks.dropFiles(files, tr || null, Math.max(0, snapT(xt(x))));
  });

  /* ---------- операції з кліпами ---------- */
  function split() {
    const t = now();
    const targets = [];
    if (store.selClip) { const f = findClip(store.selClip); if (f) targets.push(f); }
    if (!targets.length) { const tr = findTrack(store.selTrack); if (tr) tr.clips.forEach(c => targets.push({ t: tr, c })); }
    const hits = targets.filter(({ c }) => t > c.start + 0.02 && t < c.start + c.dur - 0.02);
    if (!hits.length) return false;
    checkpoint();
    hits.forEach(({ t: tr, c }) => {
      const nc = { ...c, id: uid(), start: t, offset: c.offset + (t - c.start), dur: c.start + c.dur - t };
      c.dur = t - c.start;
      tr.clips.push(nc);
    });
    reschedule(); notify("structure");
    return true;
  }
  function duplicate() {
    const f = store.selClip && findClip(store.selClip);
    if (!f) return false;
    checkpoint();
    const nc = { ...f.c, id: uid(), start: f.c.start + f.c.dur };
    f.t.clips.push(nc); store.selClip = nc.id;
    reschedule(); notify("structure");
    return true;
  }
  function remove() {
    const f = store.selClip && findClip(store.selClip);
    if (!f) return false;
    checkpoint();
    f.t.clips = f.t.clips.filter(c => c !== f.c); store.selClip = null;
    reschedule(); notify("structure");
    return true;
  }
  function zoomBy(k) {
    const center = store.playing ? now() : store.scroll + visibleSecs() / 2;
    store.zoom = clamp(store.zoom * k, 4, 400);
    store.scroll = Math.max(0, center - visibleSecs() / 2);
  }
  const setRecGhost = v => { recGhost = v; };
  return { draw, resize, fit, split, duplicate, remove, zoomBy, setRecGhost };
}
