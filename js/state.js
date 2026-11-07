import { COLORS, uid } from "./util.js";

/** AudioBuffer-и проєкту за id. Дані кліпів посилаються на них. */
export const buffers = new Map();

/** Стан сесії. `store.p` — сам проєкт (серіалізується в JSON). */
export const store = {
  p: null,
  selTrack: null,
  selClip: null,
  playhead: 0,
  playing: false,
  recording: false,
  recMotion: false,
  tool: "move",
  mat: "concrete",
  zoom: 40, // пікселів на секунду
  scroll: 0, // секунд
  snap: true,
  dirty: false,
  projectId: null,
  savedAt: null
};

export function newProject(name = "Новий проєкт") {
  return {
    version: 1, name, bpm: 96, metro: false,
    room: "room", wet: 0.16, early: true,
    listener: { x: 0, z: 0, yaw: 0 },
    obstacles: [], tracks: [],
    loop: { on: false, a: 0, b: 8 },
    masterDb: 0, latencyMs: 0
  };
}

export function addTrack(props = {}, p = store.p) {
  const tr = Object.assign({
    id: uid(), name: "Доріжка " + (p.tracks.length + 1), color: COLORS[p.tracks.length % COLORS.length],
    x: 0, y: 0, z: -2, vol: 0, mute: false, solo: false, arm: false, pan: 0, mode: "3d",
    eq: [0, 0, 0], send: 0.5, motion: { type: "none", period: 8 }, auto: [], clips: []
  }, props);
  p.tracks.push(tr);
  return tr;
}
export const findTrack = id => store.p.tracks.find(t => t.id === id);
export function findClip(id) {
  for (const t of store.p.tracks) { const c = t.clips.find(c => c.id === id); if (c) return { t, c }; }
  return null;
}
export function projectEnd(p = store.p) {
  let e = 0;
  for (const t of p.tracks) for (const c of t.clips) e = Math.max(e, c.start + c.dur);
  return e;
}
export function usedBufIds(p = store.p) {
  const s = new Set();
  p.tracks.forEach(t => t.clips.forEach(c => s.add(c.buf)));
  return [...s];
}

/* ---- події ---- */
const listeners = new Set();
export const onChange = f => listeners.add(f);
export const notify = kind => listeners.forEach(f => f(kind));

/* ---- скасування / повтор ---- */
const undoStack = [], redoStack = [];
let lastCk = 0;
/** Знімок стану ПЕРЕД зміною. force=false об'єднує часті зміни (повзунки) в один крок. */
export function checkpoint(force = true) {
  const n = performance.now();
  const merge = !force && n - lastCk < 700;
  lastCk = n;
  if (!merge) {
    undoStack.push(JSON.stringify(store.p));
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
  }
  markDirty();
}
export function markDirty() { if (!store.dirty) { store.dirty = true; notify("dirty"); } }
function fixSelection() {
  if (!findTrack(store.selTrack)) store.selTrack = store.p.tracks[0] ? store.p.tracks[0].id : null;
  if (store.selClip && !findClip(store.selClip)) store.selClip = null;
}
export function undo() {
  if (!undoStack.length) return false;
  redoStack.push(JSON.stringify(store.p));
  store.p = JSON.parse(undoStack.pop());
  fixSelection(); store.dirty = true; notify("load");
  return true;
}
export function redo() {
  if (!redoStack.length) return false;
  undoStack.push(JSON.stringify(store.p));
  store.p = JSON.parse(redoStack.pop());
  fixSelection(); store.dirty = true; notify("load");
  return true;
}
export function setProject(p, id = null) {
  store.p = p; store.projectId = id;
  undoStack.length = 0; redoStack.length = 0;
  store.selTrack = p.tracks[0] ? p.tracks[0].id : null;
  store.selClip = null; store.playhead = 0; store.scroll = 0; store.dirty = false;
  notify("load");
}
