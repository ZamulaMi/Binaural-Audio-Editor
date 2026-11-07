import { $, esc, uid, clamp, fmtTime, fmtDb, COLORS } from "./util.js";
import { store, buffers, newProject, addTrack, findTrack, checkpoint, markDirty, onChange, notify, undo, redo, setProject, selected, selectOnly, normalizeProject } from "./state.js";
import { ROOMS, MOTIONS, params, describe, relAz, bounds, maxHeight } from "./spatial.js";
import { eng, ensureCtx, now, play, pause, seek, tick, liveStatic, liveAll, setRoomLive, setWetLive, setMasterLive,
  resetForProject, addTrackLive, removeTrackLive, trackPeak, masterPeaks, renderMix, reschedule } from "./engine.js";
import { startRecording, stopRecording, inputLevel, listInputs, setDevice } from "./recorder.js";
import { wavEncode, zipWrite, saveBlob, projectToZip, zipToProject, idbSave, idbList, idbLoad, idbDelete } from "./fileio.js";
import { demoProject, ensureDemoBuffers } from "./demo.js";
import { initStage } from "./stage.js";
import { initTimeline } from "./timeline.js";

const inClaude = !!(window.claude && typeof window.claude.use === "function");
const setStatus = s => { $("status").textContent = s; };
let lastStorage = null;
try { lastStorage = window.localStorage; } catch (e) { lastStorage = null; }
const lsGet = k => { try { return lastStorage ? lastStorage.getItem(k) : null; } catch (e) { return null; } };
const lsSet = (k, v) => { try { if (lastStorage) lastStorage.setItem(k, v); } catch (e) { /* сховище недоступне */ } };

/* ================= сцена й таймлайн ================= */
const stage = initStage($("cv"), $("cbox"));
const timeline = initTimeline($("tl"), $("tlwrap"), $("tlScroll"), {
  dropFiles: (files, tr, at) => addFiles(files, tr, at),
  trackAction: (tr, act) => trackAction(tr, act),
  contextMenu: (items, x, y) => openContextMenu(items, x, y),
  editText: (x, y, value, cb) => editText(x, y, value, cb),
  closeMenus: () => closeMenus(),
  newTrack: () => newEmptyTrack(),
  trackAdded: tr => addTrackLive(tr),
  status: s => setStatus(s)
});

/* ================= контекстне меню й редагування підписів ================= */
const ctx = $("ctx");
function openContextMenu(items, x, y) {
  ctx.innerHTML = items.map((it, i) => it === "-" ? "<hr>" :
    `<button data-i="${i}" ${it.disabled ? "disabled" : ""} class="${it.danger ? "danger" : ""}"><span>${esc(it.label)}</span>${it.kbd ? `<kbd>${esc(it.kbd)}</kbd>` : ""}</button>`).join("");
  ctx.hidden = false;
  const r = ctx.getBoundingClientRect();
  ctx.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + "px";
  ctx.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + "px";
  ctx.onclick = e => {
    const b = e.target.closest("button[data-i]");
    if (!b) return;
    closeMenus();
    items[+b.dataset.i].run();
  };
}
function closeMenus() { ctx.hidden = true; $("fileMenu").open = false; }
document.addEventListener("pointerdown", e => { if (!ctx.hidden && !ctx.contains(e.target)) ctx.hidden = true; }, true);
const inl = $("inlineEdit");
let inlCb = null;
function editText(x, y, value, cb) {
  inlCb = cb;
  inl.value = value;
  inl.hidden = false;
  inl.style.left = Math.max(8, Math.min(x - 20, innerWidth - 230)) + "px";
  inl.style.top = Math.max(8, Math.min(y - 16, innerHeight - 40)) + "px";
  inl.focus(); inl.select();
}
function commitInline(ok) {
  if (inl.hidden) return;
  inl.hidden = true;
  const cb = inlCb; inlCb = null;
  if (ok && cb && inl.value.trim()) cb(inl.value.trim());
}
inl.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); commitInline(true); }
  else if (e.key === "Escape") { e.preventDefault(); commitInline(false); }
  e.stopPropagation();
});
inl.addEventListener("blur", () => commitInline(true));

/* ================= кнопки доріжки (мікшер і таймлайн) ================= */
function trackAction(tr, act) {
  checkpoint();
  if (act === "mode") { tr.mode = tr.mode === "3d" ? "stereo" : "3d"; liveStatic(tr); }
  else if (act === "mute") { tr.mute = !tr.mute; liveStatic(tr); }
  else if (act === "solo") { tr.solo = !tr.solo; liveAll(); }
  else if (act === "arm") { const v = !tr.arm; store.p.tracks.forEach(t => (t.arm = false)); tr.arm = v; }
  store.selTrack = tr.id;
  renderMixer(); renderInspector();
}

/* ================= транспорт ================= */
function syncTransport() {
  const b = $("playBtn"), p = store.p;
  b.classList.toggle("is-playing", store.playing);
  b.setAttribute("aria-label", store.playing ? "Пауза" : "Відтворити");
  $("recBtn").classList.toggle("on", store.recording);
  $("recBtn").setAttribute("aria-pressed", String(store.recording));
  $("metroBtn").setAttribute("aria-pressed", String(!!p.metro));
  $("loopBtn").setAttribute("aria-pressed", String(!!p.loop.on));
  $("motionBtn").setAttribute("aria-pressed", String(store.recMotion));
  if (document.activeElement !== $("bpmIn")) $("bpmIn").value = p.bpm;
}
let playOrigin = 0;
$("playBtn").onclick = () => { if (store.recording) finishRecording(); else if (store.playing) pause(); else { playOrigin = store.playhead; play(store.playhead); } };
$("stopBtn").onclick = () => {
  if (store.recording) { finishRecording(); return; }
  if (store.playing) { pause(); seek(playOrigin); } else seek(0);
};
$("homeBtn").onclick = () => { if (!store.recording) seek(store.p.loop.on ? store.p.loop.a : 0); };
$("recBtn").onclick = () => toggleRecord();
$("metroBtn").onclick = () => { store.p.metro = !store.p.metro; markDirty(); syncTransport(); };
$("loopBtn").onclick = () => {
  checkpoint();
  const p = store.p;
  p.loop.on = !p.loop.on;
  if (p.loop.on && p.loop.b - p.loop.a < 0.5) { const bar = 240 / p.bpm; p.loop.a = Math.floor(now() / bar) * bar; p.loop.b = p.loop.a + bar * 4; }
  syncTransport();
};
$("motionBtn").onclick = () => {
  store.recMotion = !store.recMotion; syncTransport();
  setStatus(store.recMotion ? "Запис руху увімкнено: запустіть відтворення й тягніть джерело на сцені — шлях запишеться в часі." : "Запис руху вимкнено.");
};
$("bpmIn").onchange = e => { checkpoint(); store.p.bpm = clamp(Math.round(+e.target.value) || 96, 30, 300); syncTransport(); };

/* ================= запис з мікрофона ================= */
let recInfo = null;
function micErrorText(err) {
  const n = err && err.name;
  if (n === "NotAllowedError" || n === "SecurityError")
    return inClaude
      ? "Мікрофон заблоковано в цьому перегляді Claude. Відкрийте BAE як окремий веб-сайт (див. README) — там браузер запитає дозвіл."
      : "Доступ до мікрофона заборонено. Дозвольте його в налаштуваннях сайту в браузері й спробуйте ще раз.";
  if (n === "NotFoundError" || n === "OverconstrainedError") return "Мікрофон не знайдено. Підключіть пристрій запису або виберіть інший вхід.";
  if (n === "NotReadableError") return "Мікрофон зайнятий іншою програмою.";
  if (n === "NotSupportedError") return "Браузер не дає доступу до мікрофона. Потрібен HTTPS або localhost.";
  return "Не вдалося почати запис: " + (err && err.message || err);
}
async function toggleRecord() {
  if (store.recording) return finishRecording();
  if (store.playing) pause();
  try { await startRecording(); }
  catch (err) { setStatus(micErrorText(err)); return; }
  refreshDevices();
  let target = store.p.tracks.find(t => t.arm);
  if (!target) {
    checkpoint();
    const n = store.p.tracks.filter(t => t.name.startsWith("Запис")).length + 1;
    target = addTrack({ name: "Запис " + n, x: 0, z: -1.5, y: 0, send: 0.35, arm: true });
    store.selTrack = target.id;
    notify("structure");
  }
  recInfo = { track: target.id };
  store.recording = true;
  play(store.playhead);
  timeline.setRecGhost({ track: target.id, start: store.playhead });
  setStatus(`Запис на доріжку «${target.name}»… Натисніть ● або Пробіл, щоб зупинити.`);
}
async function finishRecording() {
  const startPos = eng.startPos, t0 = eng.t0;
  store.recording = false;
  pause();
  timeline.setRecGhost(null);
  const r = await stopRecording();
  $("inMeter").style.transform = "scaleX(0)";
  if (!r) { setStatus("Запис порожній."); return; }
  let start = startPos + (r.firstT - t0) - r.latency - (store.p.latencyMs || 0) / 1000, offset = 0;
  if (start < 0) { offset = -start; start = 0; }
  const bufId = uid();
  buffers.set(bufId, r.buffer);
  checkpoint();
  let tr = findTrack(recInfo && recInfo.track);
  if (!tr) tr = addTrack({ name: "Запис", arm: true });
  const stamp = new Date().toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
  const clip = { id: uid(), buf: bufId, start, offset, dur: Math.max(0.05, r.buffer.duration - offset), name: "Запис " + stamp, gain: 0, fi: 0, fo: 0, muted: false };
  tr.clips.push(clip);
  selectOnly(clip.id); store.selTrack = tr.id;
  notify("structure");
  setStatus(`Записано ${clip.dur.toFixed(1)} с з «${r.label}». Компенсація затримки: ${Math.round(r.latency * 1000 + (store.p.latencyMs || 0))} мс.`);
}
async function refreshDevices() {
  const sel = $("devSel");
  try {
    const list = await listInputs();
    const cur = sel.value;
    sel.innerHTML = `<option value="">Типовий вхід</option>` + list.filter(d => d.deviceId && d.deviceId !== "default")
      .map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || "Вхід " + (i + 1))}</option>`).join("");
    sel.value = cur;
  } catch (e) { /* пристрої недоступні */ }
}
$("devSel").onchange = e => setDevice(e.target.value);
$("latIn").oninput = e => { store.p.latencyMs = +e.target.value; $("latOut").textContent = e.target.value + " мс"; markDirty(); };

/* ================= інспектор ================= */
function renderInspector() {
  const tr = findTrack(store.selTrack), el = $("insp"), p = store.p;
  if (!tr) { el.innerHTML = `<h2>Джерело</h2><div class="hint">Додайте доріжку або виберіть джерело на сцені.</div>`; return; }
  const L = p.listener, r = Math.hypot(tr.x - L.x, tr.z - L.z), az = Math.round(Math.atan2(tr.x - L.x, -(tr.z - L.z)) * 180 / Math.PI);
  const R = ROOMS[p.room], maxR = Math.ceil(Math.hypot(R.W, R.D) / 2), hasAuto = tr.auto.length > 0;
  const autoText = hasAuto
    ? `Записана траєкторія: ${tr.auto.length} точок, ${fmtTime(tr.auto[0].t)}–${fmtTime(tr.auto[tr.auto.length - 1].t)}. Перетягування джерела зсуває весь шлях.`
    : "Увімкніть «Рух ●», запустіть відтворення й тягніть джерело — шлях запишеться в часі.";
  el.innerHTML = `
    <h2>Джерело</h2>
    <div class="sel-name"><span class="dot" style="--c:${tr.color}"></span><span id="selName">${esc(tr.name)}</span></div>
    <div class="hear" id="hear"></div>
    <div class="readout">
      <div><small>Відстань</small><b id="roD">–</b></div>
      <div><small>Азимут</small><b id="roA">–</b></div>
      <div><small>Висота</small><b id="roH">–</b></div>
    </div>
    <div class="seg" role="group" aria-label="Режим"><button data-mode="3d" aria-pressed="${tr.mode === "3d"}">3D бінаурально</button><button data-mode="stereo" aria-pressed="${tr.mode === "stereo"}">Звичайне стерео</button></div>
    <div class="field"><label for="iDist">Відстань</label><input type="range" id="iDist" min="0.3" max="${maxR}" step="0.1" value="${r.toFixed(1)}" ${hasAuto ? "disabled" : ""}><output id="oDist">${r.toFixed(1)} м</output></div>
    <div class="field"><label for="iAz">Напрямок</label><input type="range" id="iAz" min="-180" max="180" step="1" value="${az}" ${hasAuto ? "disabled" : ""}><output id="oAz">${az}°</output></div>
    <div class="field"><label for="iH">Висота</label><input type="range" id="iH" min="-1.6" max="${maxHeight(p)}" step="0.1" value="${tr.y}"><output id="oH">${tr.y.toFixed(1)} м</output></div>
    <div class="field"><label for="iMot">Рух</label><select id="iMot" class="span2">${Object.entries(MOTIONS).map(([k, v]) => `<option value="${k}" ${tr.motion.type === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>
    <div class="field"><label for="iPer">Період руху</label><input type="range" id="iPer" min="2" max="40" step="0.5" value="${tr.motion.period}" ${tr.motion.type === "none" ? "disabled" : ""}><output id="oPer">${tr.motion.period} с</output></div>
    <div class="autobox"><span>${autoText}</span>${hasAuto ? `<button class="btn small" id="clrAuto">Очистити траєкторію</button>` : ""}</div>`;
  el.querySelectorAll("[data-mode]").forEach(b => (b.onclick = () => { checkpoint(); tr.mode = b.dataset.mode; liveStatic(tr); renderInspector(); renderMixer(); }));
  const setPolar = () => {
    checkpoint(false);
    const rr = +$("iDist").value, a = +$("iAz").value * Math.PI / 180, b = bounds(p);
    tr.x = clamp(L.x + rr * Math.sin(a), -b.hx, b.hx); tr.z = clamp(L.z - rr * Math.cos(a), -b.hz, b.hz);
    $("oDist").textContent = rr.toFixed(1) + " м"; $("oAz").textContent = $("iAz").value + "°";
  };
  $("iDist").oninput = setPolar; $("iAz").oninput = setPolar;
  $("iH").oninput = e => {
    checkpoint(false);
    const ny = +e.target.value, dy = ny - tr.y;
    tr.y = ny; tr.auto.forEach(k => (k.y = clamp(k.y + dy, -1.6, maxHeight(p))));
    $("oH").textContent = tr.y.toFixed(1) + " м";
  };
  $("iMot").onchange = e => { checkpoint(); tr.motion.type = e.target.value; $("iPer").disabled = tr.motion.type === "none"; };
  $("iPer").oninput = e => { checkpoint(false); tr.motion.period = +e.target.value; $("oPer").textContent = tr.motion.period + " с"; };
  if (hasAuto) $("clrAuto").onclick = () => { checkpoint(); tr.auto = []; renderInspector(); };
}
function syncInspectorGeometry() {
  const tr = findTrack(store.selTrack);
  if (!tr || !$("iDist")) return;
  const L = store.p.listener, r = Math.hypot(tr.x - L.x, tr.z - L.z), az = Math.round(Math.atan2(tr.x - L.x, -(tr.z - L.z)) * 180 / Math.PI);
  $("iDist").value = r; $("oDist").textContent = r.toFixed(1) + " м";
  $("iAz").value = az; $("oAz").textContent = az + "°";
  $("iH").value = tr.y; $("oH").textContent = tr.y.toFixed(1) + " м";
}
function updateReadouts(prmMap) {
  const tr = findTrack(store.selTrack);
  if (!tr || !$("hear")) return;
  const prm = prmMap.get(tr.id);
  $("hear").textContent = tr.mode === "stereo" ? "Звичайне стерео: простір вимкнено, напрямок задає панорама в мікшері." : describe(store.p, prm);
  $("roD").textContent = prm.d.toFixed(1) + " м";
  $("roA").textContent = Math.round(relAz(store.p, prm.p)) + "°";
  $("roH").textContent = (prm.p.y >= 0 ? "+" : "") + prm.p.y.toFixed(1) + " м";
}

/* ================= простір ================= */
$("roomSel").innerHTML = Object.entries(ROOMS).map(([k, r]) => `<option value="${k}">${r.name}</option>`).join("");
function syncRoomUI() {
  const p = store.p, R = ROOMS[p.room];
  $("roomSel").value = p.room;
  $("wetIn").value = p.wet; $("wetOut").textContent = Math.round(p.wet * 100) + "%";
  $("earlyIn").checked = p.early;
  $("yawIn").value = Math.round(p.listener.yaw * 180 / Math.PI); $("yawOut").textContent = $("yawIn").value + "°";
  $("latIn").value = p.latencyMs || 0; $("latOut").textContent = (p.latencyMs || 0) + " мс";
  $("roomInfo").textContent = `RT60 ≈ ${R.rt} с · ${R.walls ? "відбиття від 4 стін, підлоги й стелі" : "лише відбиття від землі"} · затримки й рівні рахуються з геометрії.`;
}
$("roomSel").onchange = e => {
  checkpoint();
  const p = store.p;
  p.room = e.target.value; p.wet = ROOMS[p.room].wet;
  const b = bounds(p);
  p.tracks.forEach(t => { t.x = clamp(t.x, -b.hx, b.hx); t.z = clamp(t.z, -b.hz, b.hz); });
  p.listener.x = clamp(p.listener.x, -b.hx, b.hx); p.listener.z = clamp(p.listener.z, -b.hz, b.hz);
  setRoomLive(); syncRoomUI(); renderInspector();
};
$("wetIn").oninput = e => { checkpoint(false); store.p.wet = +e.target.value; $("wetOut").textContent = Math.round(store.p.wet * 100) + "%"; setWetLive(); };
$("earlyIn").onchange = e => { checkpoint(); store.p.early = e.target.checked; };
$("yawIn").oninput = e => { checkpoint(false); store.p.listener.yaw = +e.target.value * Math.PI / 180; $("yawOut").textContent = e.target.value + "°"; };
function setTool(t) {
  store.tool = t;
  [["toolMove", "move"], ["toolWall", "wall"], ["toolErase", "erase"]].forEach(([id, v]) => $(id).setAttribute("aria-pressed", String(v === t)));
}
$("toolMove").onclick = () => setTool("move");
$("toolWall").onclick = () => setTool("wall");
$("toolErase").onclick = () => setTool("erase");
$("matSel").onchange = e => (store.mat = e.target.value);

/* ================= мікшер ================= */
function stripHTML(tr) {
  const is3d = tr.mode === "3d";
  return `<div class="strip ${tr.id === store.selTrack ? "selected" : ""}" data-id="${tr.id}" style="--c:${tr.color}">
    <div class="strip-head"><input class="tname" id="nm${tr.id}" value="${esc(tr.name)}" aria-label="Назва доріжки"><button class="x" data-act="del" aria-label="Видалити доріжку">✕</button></div>
    <div class="btnrow">
      <button class="chip ${is3d ? "on3d" : ""}" data-act="mode" title="3D бінаурально / стерео">${is3d ? "3D" : "ST"}</button>
      <button class="chip m ${tr.mute ? "on" : ""}" data-act="mute" title="Вимкнути звук">M</button>
      <button class="chip s ${tr.solo ? "on" : ""}" data-act="solo" title="Соло">S</button>
      <button class="chip r ${tr.arm ? "on" : ""}" data-act="arm" title="Готовність до запису">R</button>
    </div>
    <div class="fz"><div class="meter"><i id="mt${tr.id}"></i></div><input type="range" class="vfader" id="fd${tr.id}" data-k="vol" min="-48" max="6" step="0.5" value="${tr.vol}" aria-label="Гучність ${esc(tr.name)}"></div>
    <div class="db" id="db${tr.id}">${fmtDb(tr.vol)}</div>
    <label class="mini">Пан<input type="range" id="pn${tr.id}" data-k="pan" min="-1" max="1" step="0.01" value="${tr.pan}" ${is3d ? "disabled title='У 3D-режимі напрямок задає сцена'" : ""}></label>
    <label class="mini">Низ<input type="range" id="e0${tr.id}" data-k="eq0" min="-12" max="12" step="0.5" value="${tr.eq[0]}"></label>
    <label class="mini">Сер<input type="range" id="e1${tr.id}" data-k="eq1" min="-12" max="12" step="0.5" value="${tr.eq[1]}"></label>
    <label class="mini">Верх<input type="range" id="e2${tr.id}" data-k="eq2" min="-12" max="12" step="0.5" value="${tr.eq[2]}"></label>
    <label class="mini">Рев<input type="range" id="sd${tr.id}" data-k="send" min="0" max="1.5" step="0.01" value="${tr.send}"></label>
  </div>`;
}
const meterEls = new Map();
function renderMixer() {
  const p = store.p;
  $("strips").innerHTML = p.tracks.map(stripHTML).join("") + `
    <div class="strip master" style="--c:var(--fg)">
      <div class="strip-head"><b class="mname">Майстер</b></div>
      <div class="fz"><div class="meter"><i id="mtL"></i></div><div class="meter"><i id="mtR"></i></div><input type="range" class="vfader" id="fdM" min="-24" max="6" step="0.5" value="${p.masterDb}" aria-label="Гучність майстра"></div>
      <div class="db" id="dbM">${fmtDb(p.masterDb)}</div>
      <div class="hint tiny">Лімітер −2 dB на виході</div>
    </div>
    <button class="strip addstrip" id="addTrackBtn2">＋<span>Нова доріжка</span></button>`;
  $("fdM").oninput = e => { checkpoint(false); p.masterDb = +e.target.value; $("dbM").textContent = fmtDb(p.masterDb); setMasterLive(); };
  $("addTrackBtn2").onclick = newEmptyTrack;
  meterEls.clear();
  p.tracks.forEach(t => meterEls.set(t.id, $("mt" + t.id)));
}
function markSelected() {
  document.querySelectorAll(".strip[data-id]").forEach(s => s.classList.toggle("selected", s.dataset.id === store.selTrack));
}
$("strips").addEventListener("input", e => {
  const s = e.target.closest(".strip[data-id]");
  if (!s) return;
  const tr = findTrack(s.dataset.id), k = e.target.dataset.k;
  checkpoint(false);
  if (e.target.classList.contains("tname")) { tr.name = e.target.value; if (tr.id === store.selTrack && $("selName")) $("selName").textContent = tr.name; return; }
  const v = +e.target.value;
  if (k === "vol") { tr.vol = v; $("db" + tr.id).textContent = fmtDb(v); }
  else if (k === "pan") tr.pan = v;
  else if (k === "send") tr.send = v;
  else if (k && k.startsWith("eq")) tr.eq[+k[2]] = v;
  liveStatic(tr);
});
$("strips").addEventListener("click", e => {
  const s = e.target.closest(".strip[data-id]");
  if (!s) return;
  const tr = findTrack(s.dataset.id), btn = e.target.closest("button"), act = btn && btn.dataset.act;
  if (act === "del") {
    if (!btn.classList.contains("armed")) {
      btn.classList.add("armed"); btn.textContent = "Видалити?";
      setTimeout(() => { if (btn.isConnected) { btn.classList.remove("armed"); btn.textContent = "✕"; } }, 2500);
      return;
    }
    checkpoint();
    removeTrackLive(tr.id);
    store.p.tracks = store.p.tracks.filter(t => t !== tr);
    if (store.selTrack === tr.id) store.selTrack = store.p.tracks[0] ? store.p.tracks[0].id : null;
    notify("structure");
    return;
  }
  if (act) { trackAction(tr, act); return; }
  if (store.selTrack !== tr.id) { store.selTrack = tr.id; renderInspector(); }
  markSelected();
});
function newEmptyTrack() {
  checkpoint();
  const k = store.p.tracks.length, a = (k * 47 % 300 - 150) * Math.PI / 180;
  const tr = addTrack({ x: 2.5 * Math.sin(a), z: -2.5 * Math.cos(a) });
  store.selTrack = tr.id;
  addTrackLive(tr);
  notify("structure");
  return tr;
}
$("addTrackBtn").onclick = newEmptyTrack;

/* ================= аудіофайли ================= */
async function addFiles(files, intoTrack = null, at = null) {
  const c = ensureCtx();
  let added = 0;
  for (const f of files) {
    if (!(f.type.startsWith("audio") || /\.(wav|mp3|ogg|oga|flac|m4a|aac|opus|webm)$/i.test(f.name))) continue;
    try {
      const buf = await c.decodeAudioData(await f.arrayBuffer());
      const id = uid();
      buffers.set(id, buf);
      checkpoint();
      const name = f.name.replace(/\.[^.]+$/, "").slice(0, 40);
      let tr = intoTrack;
      if (!tr) {
        const k = store.p.tracks.length, a = (k * 47 % 300 - 150) * Math.PI / 180;
        tr = addTrack({ name, x: 2.5 * Math.sin(a), z: -2.5 * Math.cos(a) });
      }
      const clip = { id: uid(), buf: id, start: at !== null ? at : store.playhead, offset: 0, dur: buf.duration, name, gain: 0, fi: 0, fo: 0, muted: false };
      tr.clips.push(clip);
      store.selTrack = tr.id; selectOnly(clip.id);
      added++;
      setStatus(`Додано «${name}» (${buf.duration.toFixed(1)} с, ${buf.numberOfChannels === 2 ? "стерео → моно-джерело в 3D" : "моно"}).`);
    } catch (err) { setStatus(`Не вдалося прочитати «${f.name}». Підтримуються WAV, MP3, OGG, FLAC, M4A.`); }
  }
  if (added) { reschedule(); notify("structure"); }
}
$("fileIn").onchange = e => { addFiles([...e.target.files]); e.target.value = ""; };
const app = $("app");
app.addEventListener("dragover", e => { e.preventDefault(); });
app.addEventListener("drop", e => { e.preventDefault(); if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]); });

/* ================= таймлайн: панель ================= */
const need = (ok, msg) => { if (!ok) setStatus(msg); };
$("splitBtn").onclick = () => need(timeline.split(), "Поставте плейхед усередину кліпу, щоб розрізати.");
$("dupBtn").onclick = () => need(timeline.duplicate(), "Виберіть кліп на таймлайні.");
$("delClipBtn").onclick = () => need(timeline.remove(), "Виберіть кліп на таймлайні.");
$("markerBtn").onclick = () => timeline.addMarker();
$("snapSel").onchange = e => { store.snapRes = e.target.value; };
$("rulerSel").onchange = e => { store.rulerMode = e.target.value; };
$("zoomIn").onclick = () => timeline.zoomBy(1.5);
$("zoomOut").onclick = () => timeline.zoomBy(1 / 1.5);
$("zoomFit").onclick = () => timeline.fit();
$("laneIn").onclick = () => timeline.laneZoom(1.25);
$("laneOut").onclick = () => timeline.laneZoom(0.8);

/* ---- властивості вибраних кліпів ---- */
function renderClipBar() {
  const list = selected(), el = $("clipbar");
  if (!list.length) { el.innerHTML = `<span class="hint">Кліп не вибрано. Клік — вибір, Shift/Ctrl — кілька, рамка по порожньому місцю — групою.</span>`; return; }
  const c = list[0].c, many = list.length > 1;
  el.innerHTML = `
    <b class="cb-title">${many ? "Вибрано кліпів: " + list.length : esc(c.name || list[0].t.name)}</b>
    ${many ? "" : `<label>Початок <input type="number" id="cbStart" step="0.01" min="0" value="${c.start.toFixed(3)}"> с</label>
    <label>Довжина <span class="mono">${c.dur.toFixed(2)} с</span></label>`}
    <label>Гейн <input type="range" id="cbGain" min="-24" max="24" step="0.1" value="${c.gain || 0}"><output id="cbGainO">${(c.gain || 0).toFixed(1)} dB</output></label>
    <label>Фейд ↗ <input type="number" id="cbFi" step="0.05" min="0" value="${(c.fi || 0).toFixed(2)}"> с</label>
    <label>Фейд ↘ <input type="number" id="cbFo" step="0.05" min="0" value="${(c.fo || 0).toFixed(2)}"> с</label>
    <label class="check small"><input type="checkbox" id="cbMute" ${c.muted ? "checked" : ""}> Вимкнений</label>
    <button class="btn small" id="cbNorm">Нормалізувати</button>
    <button class="btn small" id="cbRev">Реверс</button>`;
  const each = f => { list.forEach(({ c }) => f(c)); reschedule(); };
  if (!many) $("cbStart").onchange = e => { checkpoint(); c.start = Math.max(0, +e.target.value || 0); reschedule(); notify("structure"); };
  $("cbGain").oninput = e => { checkpoint(false); const v = +e.target.value; $("cbGainO").textContent = v.toFixed(1) + " dB"; list.forEach(({ c }) => (c.gain = v)); };
  $("cbGain").onchange = () => reschedule();
  $("cbFi").onchange = e => { checkpoint(); each(c => (c.fi = clamp(+e.target.value || 0, 0, c.dur - c.fo))); notify("structure"); };
  $("cbFo").onchange = e => { checkpoint(); each(c => (c.fo = clamp(+e.target.value || 0, 0, c.dur - c.fi))); notify("structure"); };
  $("cbMute").onchange = e => { checkpoint(); each(c => (c.muted = e.target.checked)); notify("structure"); };
  $("cbNorm").onclick = () => timeline.normalize();
  $("cbRev").onclick = () => timeline.reverse();
}

/* ================= проєкт: збереження ================= */
function syncSaveState() {
  if (document.activeElement !== $("projName")) $("projName").value = store.p.name;
  const s = $("saveState");
  if (store.dirty) { s.textContent = "Є незбережені зміни"; s.dataset.state = "dirty"; }
  else if (store.savedAt) { s.textContent = "Збережено о " + store.savedAt.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" }); s.dataset.state = "ok"; }
  else { s.textContent = "Ще не збережено"; s.dataset.state = ""; }
}
$("projName").oninput = e => { checkpoint(false); store.p.name = e.target.value || "Без назви"; };
let saving = false;
async function saveToLibrary(silent = false) {
  if (saving) return;
  saving = true;
  if (!store.projectId) store.projectId = uid();
  const wasDirty = store.dirty;
  store.dirty = false;
  try {
    await idbSave(store.projectId, store.p, buffers);
    store.savedAt = new Date();
    lsSet("bae:last", store.projectId);
    if (!silent) setStatus(`Проєкт «${store.p.name}» збережено в бібліотеці браузера.`);
  } catch (e) {
    store.dirty = wasDirty;
    if (!silent) setStatus("Не вдалося зберегти в браузері (" + (e && e.message || e) + "). Збережіть проєкт у файл.");
  } finally { saving = false; syncSaveState(); }
}
setInterval(() => { if (store.dirty && !store.recording) saveToLibrary(true); }, 20000);

async function loadProject(p, bufs, id) {
  if (store.recording) await finishRecording();
  if (store.p && store.dirty) await saveToLibrary(true);
  if (store.playing) pause();
  bufs.forEach((b, k) => buffers.set(k, b));
  normalizeProject(p);
  ensureDemoBuffers(p);
  setProject(p, id);
  store.savedAt = id ? new Date() : null;
  if (id) lsSet("bae:last", id);
  timeline.fit();
}
async function exportProjectFile() {
  try {
    setStatus("Пакую проєкт…");
    const blob = projectToZip(store.p, buffers);
    const fname = (store.p.name || "проєкт").replace(/[\\/:*?"<>|]+/g, "_") + ".bae.zip";
    await saveBlob(blob, fname);
    setStatus(`Проєкт збережено у файл ${fname} (${(blob.size / 1048576).toFixed(1)} МБ).`);
  } catch (e) { setStatus(e && e.code === "declined" ? "Збереження скасовано." : "Не вдалося зберегти файл: " + (e && e.message || e)); }
}
$("projIn").onchange = async e => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    const { p, bufs } = await zipToProject(new Uint8Array(await f.arrayBuffer()), async data => ensureCtx().decodeAudioData(data.slice().buffer));
    await loadProject(p, bufs, null);
    setStatus(`Відкрито проєкт «${p.name}» з файлу.`);
  } catch (err) { setStatus("Не вдалося відкрити проєкт: " + (err && err.message || err)); }
};
async function exportMix() {
  const btn = $("exportBtn");
  btn.disabled = true;
  setStatus("Рендер бінауральної суміші…");
  try {
    const ab = await renderMix();
    const base = (store.p.name || "mix").replace(/[\\/:*?"<>|]+/g, "_") + " - binaural";
    const wav = wavEncode(ab, 24);
    if (inClaude) await saveBlob(zipWrite([{ name: base + ".wav", data: wav }]), base + ".zip");
    else await saveBlob(new Blob([wav], { type: "audio/wav" }), base + ".wav");
    setStatus(`Експортовано: ${base}.wav · 24 біт, 48 кГц, ${ab.duration.toFixed(1)} с${inClaude ? " (у ZIP-архіві)" : ""}.`);
  } catch (e) {
    setStatus(e && e.code === "declined" ? "Збереження скасовано." : "Експорт не вдався: " + (e && e.message || e));
  } finally { btn.disabled = false; }
}
$("exportBtn").onclick = exportMix;

/* ---- меню «Файл» ---- */
const menu = $("fileMenu");
document.addEventListener("click", e => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
menu.addEventListener("click", async e => {
  const b = e.target.closest("button[data-cmd]");
  if (!b) return;
  menu.open = false;
  const cmd = b.dataset.cmd;
  if (cmd === "new") { await loadProject(newProject(), new Map(), null); setStatus("Створено новий проєкт. Додайте аудіо або запишіть з мікрофона."); }
  else if (cmd === "demo") { await loadProject(demoProject(), new Map(), null); setStatus("Відкрито демо-проєкт."); }
  else if (cmd === "open") openLibrary();
  else if (cmd === "save") saveToLibrary();
  else if (cmd === "copy") { store.projectId = null; store.p.name += " (копія)"; await saveToLibrary(); }
  else if (cmd === "export") exportProjectFile();
  else if (cmd === "import") $("projIn").click();
  else if (cmd === "audio") $("fileIn").click();
});

/* ---- бібліотека ---- */
async function openLibrary() {
  const dlg = $("dlg"), list = $("dlgList");
  dlg.hidden = false;
  list.innerHTML = `<div class="hint">Завантаження…</div>`;
  let items = [];
  try { items = await idbList(); }
  catch (e) { list.innerHTML = `<div class="hint">Бібліотека недоступна в цьому браузері. Використовуйте «Зберегти у файл».</div>`; return; }
  if (!items.length) { list.innerHTML = `<div class="hint">Збережених проєктів ще немає. Натисніть «Зберегти» (Ctrl+S) — проєкт з'явиться тут.</div>`; return; }
  list.innerHTML = items.map(it => `<div class="proj ${it.id === store.projectId ? "cur" : ""}" data-id="${it.id}">
      <div class="proj-main"><b>${esc(it.name)}</b><small>${new Date(it.updated).toLocaleString("uk-UA")}${it.id === store.projectId ? " · відкритий зараз" : ""}</small></div>
      <button class="btn small" data-a="open">Відкрити</button>
      <button class="btn small ghost" data-a="del">Видалити</button></div>`).join("");
}
$("dlgClose").onclick = () => ($("dlg").hidden = true);
$("dlg").addEventListener("click", async e => {
  if (e.target.id === "dlg") { $("dlg").hidden = true; return; }
  const b = e.target.closest("button[data-a]");
  if (!b) return;
  const id = b.closest(".proj").dataset.id;
  if (b.dataset.a === "open") {
    try {
      const r = await idbLoad(id);
      if (!r) throw new Error("проєкт не знайдено");
      await loadProject(r.p, r.bufs, id);
      $("dlg").hidden = true;
      setStatus(`Відкрито «${r.p.name}».`);
    } catch (err) { setStatus("Не вдалося відкрити: " + (err && err.message || err)); }
  } else {
    if (!b.classList.contains("armed")) { b.classList.add("armed"); b.textContent = "Точно видалити?"; return; }
    await idbDelete(id);
    if (id === store.projectId) { store.projectId = null; store.savedAt = null; store.dirty = true; syncSaveState(); }
    openLibrary();
  }
});

/* ================= клавіатура ================= */
// Кнопки й повзунки, натиснуті мишею, не тримають фокус — інакше Пробіл «натискав» би їх удруге.
document.addEventListener("pointerup", e => {
  const el = e.target.closest("button, summary, input[type=range], input[type=checkbox]");
  if (el && e.pointerType) setTimeout(() => el.blur(), 0);
}, true);
const HOTKEYS = [
  ["Транспорт", [
    ["Пробіл", "Відтворення / пауза"], ["R", "Запис з мікрофона"], ["Home / End", "На початок / в кінець проєкту"],
    ["← / →", "Плейхед на крок сітки (Shift — на такт)"], ["[ / ]", "Попередній / наступний маркер"],
    ["L", "Цикл увімк./вимк."], ["I / O", "Початок / кінець циклу в позиції плейхеда"], ["K", "Метроном"]]],
  ["Редагування", [
    ["S", "Розрізати в позиції плейхеда"], ["Delete", "Видалити вибрані кліпи"], ["Ctrl C / X / V", "Копіювати / вирізати / вставити"],
    ["Ctrl D", "Дублювати"], ["Ctrl A", "Виділити всі кліпи"], ["Esc", "Зняти виділення"],
    ["← / → з кліпами", "Зсунути на крок сітки (Alt — на 10 мс)"], ["U", "Вимкнути / увімкнути кліп"],
    ["M", "Додати маркер"], ["G", "Прив'язка до сітки увімк./вимк."], ["Ctrl Z / Ctrl Shift Z", "Скасувати / повторити"]]],
  ["Вигляд і доріжки", [
    ["= / −", "Масштаб часу"], ["Z", "Вмістити весь проєкт"], ["↑ / ↓", "Попередня / наступна доріжка"],
    ["N", "Нова доріжка"], ["Ctrl + коліщатко", "Масштаб під курсором"], ["Alt + коліщатко", "Висота доріжок"]]],
  ["Проєкт", [["Ctrl S", "Зберегти"], ["Ctrl O", "Бібліотека проєктів"], ["Ctrl E", "Експорт бінаурального WAV"], ["?", "Ця довідка"]]],
  ["Миша на таймлайні", [
    ["Shift / Ctrl + клік", "Додати / перемкнути вибір"], ["Рамка по порожньому", "Вибір групою"], ["Ctrl + тягнути", "Копія кліпу"],
    ["Тягнути край", "Обрізати"], ["Квадратики вгорі", "Фейди"], ["Alt під час дії", "Без прив'язки"],
    ["Shift + тягнути по лінійці", "Межі циклу"], ["Правий клік", "Контекстне меню"], ["Подвійний клік", "Перейменувати"]]]
];
$("helpList").innerHTML = HOTKEYS.map(([h, rows]) => `<section><h3>${h}</h3><dl>${rows.map(([k, v]) => `<dt><kbd>${esc(k)}</kbd></dt><dd>${esc(v)}</dd>`).join("")}</dl></section>`).join("");
const toggleHelp = v => ($("help").hidden = v === undefined ? !$("help").hidden : !v);
$("helpBtn").onclick = () => toggleHelp(true);
$("helpClose").onclick = () => toggleHelp(false);
$("help").addEventListener("click", e => { if (e.target.id === "help") toggleHelp(false); });

function stepPlayhead(dir, bar) {
  const b = 60 / store.p.bpm, step = bar ? b * 4 : timeline.snapStep() || b;
  const t = now(), target = dir > 0 ? Math.floor(t / step + 1e-6) * step + step : Math.ceil(t / step - 1e-6) * step - step;
  seek(Math.max(0, target));
  timeline.revealPlayhead();
}
document.addEventListener("keydown", e => {
  if (e.isComposing || e.repeat && /^(KeyR|KeyS|KeyM|KeyN|Space)$/.test(e.code)) return;
  const el = e.target;
  const textual = el.closest && el.closest("input:not([type=range]):not([type=checkbox]),select,textarea");
  const mod = e.ctrlKey || e.metaKey, code = e.code;
  const run = f => { e.preventDefault(); e.stopPropagation(); f(); };
  if (mod && code === "KeyS") return run(() => saveToLibrary());
  if (code === "Escape") {
    if (!$("help").hidden) return run(() => toggleHelp(false));
    if (!$("dlg").hidden) return run(() => ($("dlg").hidden = true));
    if (!ctx.hidden || $("fileMenu").open) return run(closeMenus);
    if (!textual) return run(() => timeline.deselect());
  }
  if (textual) return;
  // кнопка/повзунок з фокусом не повинні отримати цей Пробіл чи Enter
  if (el !== document.body && /^(Space|Enter)$/.test(code)) el.blur && el.blur();
  if (mod) {
    if (code === "KeyZ") return run(() => (e.shiftKey ? redo() : undo()));
    if (code === "KeyY") return run(redo);
    if (code === "KeyD") return run(() => need(timeline.duplicate(), "Виберіть кліп."));
    if (code === "KeyC") return run(() => need(timeline.copy(), "Виберіть кліп."));
    if (code === "KeyX") return run(() => need(timeline.cut(), "Виберіть кліп."));
    if (code === "KeyV") return run(() => need(timeline.paste(), "Буфер обміну порожній."));
    if (code === "KeyA") return run(timeline.selectAll);
    if (code === "KeyO") return run(openLibrary);
    if (code === "KeyE") return run(exportMix);
    return;
  }
  if (e.altKey && !/^Arrow/.test(code)) return;
  switch (code) {
    case "Space": return run(() => $("playBtn").click());
    case "Home": return run(() => { seek(0); timeline.revealPlayhead(); });
    case "End": return run(() => { seek(Math.max(0, projectEndTime())); timeline.revealPlayhead(); });
    case "KeyR": return run(toggleRecord);
    case "KeyS": return run(() => need(timeline.split(), "Поставте плейхед усередину кліпу, щоб розрізати."));
    case "Delete": case "Backspace": return run(() => timeline.remove());
    case "KeyL": return run(() => $("loopBtn").click());
    case "KeyK": return run(() => $("metroBtn").click());
    case "KeyI": return run(() => timeline.setLoopEdge("a"));
    case "KeyO": return run(() => timeline.setLoopEdge("b"));
    case "KeyM": return run(() => timeline.addMarker());
    case "KeyU": return run(() => need(timeline.toggleMute(), "Виберіть кліп."));
    case "KeyG": return run(() => { store.snapRes = store.snapRes === "off" ? "1/16" : "off"; $("snapSel").value = store.snapRes; setStatus(store.snapRes === "off" ? "Прив'язку вимкнено." : "Прив'язка: 1/16."); });
    case "KeyN": return run(newEmptyTrack);
    case "KeyZ": return run(timeline.fit);
    case "Equal": case "NumpadAdd": return run(() => timeline.zoomBy(1.5));
    case "Minus": case "NumpadSubtract": return run(() => timeline.zoomBy(1 / 1.5));
    case "BracketLeft": return run(() => { timeline.gotoMarker(-1); timeline.revealPlayhead(); });
    case "BracketRight": return run(() => { timeline.gotoMarker(1); timeline.revealPlayhead(); });
    case "ArrowUp": return run(() => timeline.selectTrackDelta(-1));
    case "ArrowDown": return run(() => timeline.selectTrackDelta(1));
    case "ArrowLeft": case "ArrowRight": {
      const dir = code === "ArrowLeft" ? -1 : 1;
      return run(() => { if (!timeline.nudge(dir, e.altKey)) stepPlayhead(dir, e.shiftKey); });
    }
    case "Slash": if (e.shiftKey) return run(() => toggleHelp()); return;
    case "F1": return run(() => toggleHelp());
  }
}, true);
const projectEndTime = () => store.p.tracks.reduce((m, t) => t.clips.reduce((mm, c) => Math.max(mm, c.start + c.dur), m), 0);

/* ================= події стану ================= */
onChange(kind => {
  if (kind === "load") { resetForProject(); renderAll(); }
  else if (kind === "structure") { timeline.resize(); renderMixer(); renderInspector(); renderClipBar(); }
  else if (kind === "select") { markSelected(); renderInspector(); renderClipBar(); }
  else if (kind === "geometry") syncInspectorGeometry();
  else if (kind === "transport") syncTransport();
  if (kind === "dirty" || kind === "load") syncSaveState();
});
function renderAll() {
  syncRoomUI(); renderMixer(); renderInspector(); renderClipBar(); syncTransport(); syncSaveState(); timeline.resize();
  $("snapSel").value = store.snapRes; $("rulerSel").value = store.rulerMode;
}

/* ================= кадр ================= */
const meterScale = pk => clamp((20 * Math.log10(pk + 1e-6) + 48) / 54, 0, 1);
function frame() {
  const p = store.p, t = now();
  const prmMap = new Map();
  p.tracks.forEach(tr => prmMap.set(tr.id, params(tr, t, p)));
  tick(prmMap);
  stage.tickDrag();
  stage.draw(prmMap);
  timeline.draw();
  updateReadouts(prmMap);
  meterEls.forEach((el, id) => { if (el) el.style.transform = `scaleY(${meterScale(trackPeak(id))})`; });
  const [l, r] = masterPeaks();
  if ($("mtL")) { $("mtL").style.transform = `scaleY(${meterScale(l)})`; $("mtR").style.transform = `scaleY(${meterScale(r)})`; }
  const beat = 60 / p.bpm, b = Math.floor(t / beat);
  $("clock").textContent = fmtTime(t);
  $("bars").textContent = `${Math.floor(b / 4) + 1}.${(b % 4) + 1}`;
  if (store.recording) $("inMeter").style.transform = `scaleX(${meterScale(inputLevel())})`;
  requestAnimationFrame(frame);
}

/* ================= старт ================= */
async function boot() {
  let loaded = false;
  const last = lsGet("bae:last");
  if (last) {
    try {
      const r = await idbLoad(last);
      if (r) { await loadProject(r.p, r.bufs, last); loaded = true; setStatus(`Відкрито останній проєкт «${r.p.name}».`); }
    } catch (e) { /* бібліотека недоступна */ }
  }
  if (!loaded) {
    await loadProject(demoProject(), new Map(), null);
    setStatus("Демо-проєкт: 6 інструментів у концертному залі. Надягніть навушники й натисніть ▶.");
  }
  requestAnimationFrame(frame);
}
boot();
