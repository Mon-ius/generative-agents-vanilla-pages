// screenshot.mjs — dev-only: load a URL in headless Chrome and capture a PNG of the
// live app (used to eyeball the rendered town while iterating on the tile art). Like
// svg2png.mjs it self-launches a headless Chrome over CDP, so no npm dependency.
//
// usage:
//   node tools/screenshot.mjs <url> <out.png> [--w 1500] [--h 800] [--wait 1500]
//        [--eval 'js run in the page after boot'] [--clip '#map-host']
//
// The script waits for window.__app.map to exist (the app's composition root) before
// running --eval, so camera calls like window.__app.map.camera.centerOn(...) are safe.

import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { platform } from "node:os";

const args = process.argv.slice(2);
const [url, outPng] = args;
if (!url || !outPng) { console.error("usage: node tools/screenshot.mjs <url> <out.png> [--w n --h n --wait ms --eval js --clip sel]"); process.exit(2); }
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const W = +opt("--w", 1500), H = +opt("--h", 800);
const WAIT = +opt("--wait", 1500);
const EVAL = opt("--eval", "");
const CLIP = opt("--clip", "");

const PORT = +(process.env.CDP_PORT || 9389);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH ||
  (platform() === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : platform() === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "google-chrome");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpUp() { try { await fetch(`${BASE}/json/version`); return true; } catch { return false; } }
async function ensureChrome() {
  if (await cdpUp()) return null;
  const proc = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${PORT}`, "--remote-allow-origins=*",
    "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--force-device-scale-factor=1",
    `--user-data-dir=/tmp/screenshot-${PORT}`, "about:blank",
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
const eval1 = async (expr, awaitPromise = false) => (await send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true })).result;
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: +opt("--dpr", 1), mobile: false });
await send("Page.navigate", { url });

// wait for the app composition root + map view to exist
let booted = false;
for (let i = 0; i < 80; i++) {
  const r = await eval1("!!(window.__app && window.__app.map && window.__app.map.layout)");
  if (r && r.value) { booted = true; break; }
  await sleep(250);
}
if (!booted) console.error("warning: window.__app.map not detected; capturing anyway");

if (EVAL) { try { const rv = await eval1(EVAL, true); if (rv && rv.value !== undefined) console.error("eval ->", typeof rv.value === "string" ? rv.value : JSON.stringify(rv.value)); } catch (e) { console.error("eval error:", e && e.message); } }
await sleep(WAIT);

let clip;
if (CLIP) {
  const r = await eval1(`(()=>{const el=document.querySelector(${JSON.stringify(CLIP)});if(!el)return null;const b=el.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};})()`);
  if (r && r.value) clip = { ...r.value, scale: 1 };
}
const shotParams = { format: "png", captureBeyondViewport: false };
if (clip) shotParams.clip = clip;
const shot = await send("Page.captureScreenshot", shotParams);
ws.close();
if (owned) { try { owned.kill("SIGKILL"); } catch {} }
if (!shot || !shot.data) { console.error("capture failed"); process.exit(1); }
writeFileSync(outPng, Buffer.from(shot.data, "base64"));
console.log(`captured ${url} -> ${outPng} (${clip ? `${Math.round(clip.width)}x${Math.round(clip.height)} clip` : `${W}x${H}`})`);
process.exit(0);
