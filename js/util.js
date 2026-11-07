export const SR = 48000;
export const TAU = Math.PI * 2;
export const EAR = 1.7; // висота вух над підлогою, м
export const C_SOUND = 343; // швидкість звуку, м/с

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const dbToGain = db => (db <= -48 ? 0 : Math.pow(10, db / 20));
export const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5);
export const $ = id => document.getElementById(id);
export const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function fmtTime(s) {
  s = Math.max(0, s);
  const m = Math.floor(s / 60), r = s - m * 60;
  return String(m).padStart(2, "0") + ":" + r.toFixed(1).padStart(4, "0");
}
export const fmtDb = v => (v <= -48 ? "−∞ dB" : (v > 0 ? "+" : "") + v.toFixed(1) + " dB");

export const COLORS = ["#e0884a", "#4aa3d8", "#b07ad6", "#4fbf8f", "#d8607a", "#d4b13c", "#6fc7c7", "#9a9df0"];

const cssCache = {};
let cssAge = 0;
const CSS_NAMES = ["--floor", "--grid", "--wall", "--fg", "--muted", "--head", "--warn", "--accent", "--panel", "--panel-2",
  "--bg", "--line", "--rec", "--mat-concrete", "--mat-wood", "--mat-fabric"];
/** Кольори теми для canvas (оновлюються раз на ~30 кадрів). */
export function css() {
  if (cssAge-- <= 0) {
    const cs = getComputedStyle(document.documentElement);
    CSS_NAMES.forEach(n => (cssCache[n] = cs.getPropertyValue(n).trim()));
    cssAge = 30;
  }
  return cssCache;
}
