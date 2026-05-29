// svg2png.mjs — rasterize an SVG file to a pixel-exact, TRANSPARENT PNG using
// headless Chrome. Dev-only (not shipped/served). Self-contained: it launches a
// headless Chrome itself if one isn't already listening on CDP_PORT, so callers
// just run: `node tools/svg2png.mjs <in.svg> <out.png> [width] [height]`.
//
// Why Chrome: it renders SVG (paths, gradients, opacity) exactly as the browser
// will, with zero extra dependency. A transparent default background keeps the
// sprite cut-outs' alpha so the atlas composites correctly over the map.

import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { platform } from "node:os";

const PORT = +(process.env.CDP_PORT || 9388);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH ||
  (platform() === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : platform() === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe"
      : "google-chrome");

const [inSvg, outPng, wArg, hArg] = process.argv.slice(2);
if (!inSvg || !outPng) { console.error("usage: node tools/svg2png.mjs <in.svg> <out.png> [width] [height]"); process.exit(2); }

const svgText = readFileSync(inSvg, "utf8");
const wm = /<svg[^>]*\bwidth="(\d+(?:\.\d+)?)"/.exec(svgText);
const hm = /<svg[^>]*\bheight="(\d+(?:\.\d+)?)"/.exec(svgText);
const W = Math.round(+(wArg || (wm && wm[1])) || 0);
const H = Math.round(+(hArg || (hm && hm[1])) || 0);
if (!W || !H) { console.error("could not determine width/height (pass them or add width/height to the <svg>)"); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpUp() { try { await fetch(`${BASE}/json/version`); return true; } catch { return false; } }

async function ensureChrome() {
  if (await cdpUp()) return null;
  const proc = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${PORT}`, "--remote-allow-origins=*",
    "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--force-device-scale-factor=1",
    `--user-data-dir=/tmp/svg2png-${PORT}`, "about:blank",
  ], { stdio: "ignore" });
  for (let i = 0; i < 80; i++) { if (await cdpUp()) return proc; await sleep(250); }
  try { proc.kill("SIGKILL"); } catch {}
  throw new Error("could not start headless Chrome (set CHROME_PATH?)");
}

async function target() {
  for (let i = 0; i < 40; i++) {
    try { const list = await (await fetch(`${BASE}/json`)).json(); const p = list.find((t) => t.type === "page"); if (p && p.webSocketDebuggerUrl) return p; } catch {}
    await sleep(250);
  }
  throw new Error("no debuggable Chrome page");
}

const owned = await ensureChrome();
const t = await target();
const ws = new WebSocket(t.webSocketDebuggerUrl);
let _id = 0; const pending = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const id = ++_id; pending.set(id, (m) => res(m.result)); ws.send(JSON.stringify({ id, method, params })); });
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
const html = `<!doctype html><meta charset="utf8"><style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>${svgText}`;
await send("Page.navigate", { url: "data:text/html;charset=utf-8," + encodeURIComponent(html) });
await sleep(800);
const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: W, height: H, scale: 1 }, captureBeyondViewport: true });
ws.close();
if (owned) { try { owned.kill("SIGKILL"); } catch {} }
if (!shot || !shot.data) { console.error("capture failed"); process.exit(1); }
writeFileSync(outPng, Buffer.from(shot.data, "base64"));
console.log(`rasterized ${inSvg} -> ${outPng} (${W}x${H})`);
process.exit(0);
