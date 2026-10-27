#!/usr/bin/env node
/**
 * capture.mjs — proof for X posts, captured off the real thing.
 *
 *   node capture/capture.mjs shot <url> <name.jpg> [--crop w:h:x:y] [--full] [--wait ms] [--click "Text"]
 *   node capture/capture.mjs rec  <url> <name.mp4> [--seconds 12] [--scroll 900] [--click "Text"]
 *   node capture/capture.mjs clip <input.mp4|mov> <name.mp4> [--from s] [--to s] [--width 1280]
 *   node capture/capture.mjs frames <video> <sheet.jpg>     contact sheet to check what a clip shows
 *
 * Output lands in data/x/media/ (or $X_DATA_DIR/media) unless <name> is an absolute path.
 * Pages on DASHBOARD_URL's origin (a local dashboard behind a cookie gate) get the
 * DASHBOARD_COOKIE_NAME=DASHBOARD_KEY cookie from the environment or .env.local; the key is
 * never printed.
 * Recordings are CDP screencasts assembled by ffmpeg at 30fps, not Playwright's low-bitrate
 * recorder. WebGL (the globe) needs the GPU flags below.
 */
import { chromium } from "playwright";
import ffmpegPath from "ffmpeg-static";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, mkdtempSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, isAbsolute, extname } from "node:path";
import { tmpdir, homedir } from "node:os";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DATA = process.env.X_DATA_DIR ? resolve(process.env.X_DATA_DIR) : join(ROOT, "data", "x");
const MEDIA = join(DATA, "media");
const args = process.argv.slice(2);
const [cmd, src, name] = args;
const flag = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(`--${k}`);
const outPath = (n) => (isAbsolute(n) ? n : join(MEDIA, n));
const ff = (a) => execFileSync(ffmpegPath, ["-y", "-loglevel", "error", ...a], { stdio: ["ignore", "inherit", "inherit"] });

/** Read a setting from the environment first, then from .env.local at the repo root. */
function setting(k) {
  if (process.env[k]) return process.env[k];
  try {
    const m = readFileSync(join(ROOT, ".env.local"), "utf8").match(new RegExp(`^${k}=(.*)$`, "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
  } catch { return null; }
}

/**
 * Playwright's bundled Chromium first: inside a loop's sandbox, system Chrome dies on its
 * crash reporter and profile lock (both live outside the writable roots). System Chrome is
 * the fallback for interactive use, and the one that renders WebGL best.
 */
function cachedBrowsers() {
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  const newest = (prefix) => {
    try { return readdirSync(cache).filter((d) => d.startsWith(prefix)).sort((a, b) => +b.split("-").pop() - +a.split("-").pop()); } catch { return []; }
  };
  const out = [];
  for (const d of newest("chromium_headless_shell-")) out.push(join(cache, d, "chrome-headless-shell-mac-arm64", "chrome-headless-shell"));
  for (const d of newest("chromium-")) out.push(join(cache, d, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"));
  return out.filter((p) => existsSync(p));
}

async function launch() {
  const gpu = ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"];
  const quiet = ["--disable-crash-reporter", "--disable-breakpad", "--no-first-run"];
  let first;
  for (const executablePath of cachedBrowsers()) {
    try { return await chromium.launch({ executablePath, args: [...gpu, ...quiet] }); } catch (e) { first ??= e; }
  }
  try { return await chromium.launch({ args: [...gpu, ...quiet] }); } catch (e) { first ??= e; }
  try { return await chromium.launch({ channel: "chrome", args: gpu }); } catch (e) { throw first ?? e; }
}

async function page(url) {
  const b = await launch();
  const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: "dark" });
  const u = new URL(url);
  const dash = setting("DASHBOARD_URL") ? new URL(setting("DASHBOARD_URL")) : null;
  if (dash && u.origin === dash.origin) {
    const key = setting("DASHBOARD_KEY");
    if (key) await ctx.addCookies([{ name: setting("DASHBOARD_COOKIE_NAME") || "dashboard_key", value: key, domain: u.hostname, path: "/" }]);
  }
  const p = await ctx.newPage();
  try { await p.goto(url, { waitUntil: "networkidle", timeout: 30000 }); } catch { /* slow sites still render */ }
  if (dash && new URL(p.url()).pathname === "/gate") throw new Error("dashboard gate: DASHBOARD_KEY missing or wrong");
  await p.waitForTimeout(+flag("wait", 2500));
  if (flag("click")) { await p.getByText(flag("click")).first().click().catch(() => {}); await p.waitForTimeout(1500); }
  return { b, p, ctx };
}

const smooth = (p, y, ms) => p.evaluate(([y, ms]) => new Promise((r) => {
  const s = scrollY, t0 = performance.now();
  const step = (n) => { const k = Math.min((n - t0) / ms, 1); const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; scrollTo(0, s + (y - s) * e); k < 1 ? requestAnimationFrame(step) : r(); };
  requestAnimationFrame(step);
}), [y, ms]);

mkdirSync(MEDIA, { recursive: true });
if (!cmd || !src || !name) { console.error("usage: capture.mjs shot|rec|clip|frames <src> <name>"); process.exit(1); }

if (cmd === "shot") {
  const { b, p } = await page(src);
  const png = join(mkdtempSync(join(tmpdir(), "xcap-")), "shot.png");
  await p.screenshot({ path: png, fullPage: has("full") });
  await b.close();
  const vf = [flag("crop") ? `crop=${flag("crop")}` : null, "scale='min(2400,iw)':-2"].filter(Boolean).join(",");
  ff(["-i", png, "-vf", vf, ...(extname(name) === ".png" ? [] : ["-q:v", "3"]), outPath(name)]);
  console.log(outPath(name));
} else if (cmd === "rec") {
  const { b, p, ctx } = await page(src);
  const cdp = await ctx.newCDPSession(p);
  const frames = [];
  cdp.on("Page.screencastFrame", (f) => { frames.push({ t: f.metadata.timestamp, d: f.data }); cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {}); });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: 1920, maxHeight: 1200 });
  const secs = +flag("seconds", 12);
  await p.waitForTimeout(1500);
  if (flag("scroll")) { await smooth(p, +flag("scroll"), Math.max(1500, secs * 1000 - 4000)); await p.waitForTimeout(1500); }
  else await p.waitForTimeout(secs * 1000 - 1500);
  await cdp.send("Page.stopScreencast");
  await b.close();
  if (frames.length < 2) throw new Error("no frames captured");
  const dir = mkdtempSync(join(tmpdir(), "xrec-"));
  let list = "";
  frames.forEach((f, i) => {
    const fn = join(dir, `${String(i).padStart(5, "0")}.jpg`);
    writeFileSync(fn, Buffer.from(f.d, "base64"));
    const dur = i < frames.length - 1 ? frames[i + 1].t - f.t : 0.5;
    list += `file '${fn}'\nduration ${Math.max(dur, 0.001).toFixed(4)}\n`;
  });
  list += `file '${join(dir, `${String(frames.length - 1).padStart(5, "0")}.jpg`)}'\n`;
  writeFileSync(join(dir, "list.txt"), list);
  ff(["-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"), "-vf", "fps=30,scale=1920:-2:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-crf", "18", "-preset", "slow", "-movflags", "+faststart", outPath(name)]);
  rmSync(dir, { recursive: true, force: true });
  console.log(outPath(name), `${frames.length} frames`);
} else if (cmd === "clip") {
  if (!existsSync(src)) throw new Error(`no such file ${src}`);
  const a = [];
  if (flag("from")) a.push("-ss", flag("from"));
  a.push("-i", src);
  if (flag("to")) a.push("-t", String(+flag("to") - +(flag("from") || 0)));
  ff([...a, "-vf", `scale='min(${flag("width", 1280)},iw)':-2,format=yuv420p`, "-c:v", "libx264", "-crf", "20", "-preset", "slow", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", outPath(name)]);
  console.log(outPath(name));
} else if (cmd === "frames") {
  ff(["-i", src, "-vf", "fps=1/2,scale=320:-1,tile=6x2", "-frames:v", "1", outPath(name)]);
  console.log(outPath(name));
} else {
  console.error(`unknown command ${cmd}`); process.exit(1);
}
