#!/usr/bin/env node
/**
 * daily.mjs — the browser half of x-studio, run by Dagu (`x-capture` DAG) outside any sandbox.
 *
 * No Chromium can start inside a loop lane's sandbox (macOS denies its mach bootstrap
 * check-in), so the writer never opens a browser. Instead it appends what it wants shot to
 * data/x/capture-requests.json, and this job — no model involved — captures:
 *   1. every pending request, then clears it from the request file;
 *   2. a small standing set of dashboard views whose numbers change day to day
 *      (capture/standing.json; see capture/standing.example.json).
 * Results land in data/x/media/ and are listed in data/x/captures.json, newest first, which
 * x-studio reads to pick its proof.
 *
 * Request shape: {"kind":"shot"|"rec", "url":"...", "name":"20261025-slug.jpg",
 *                 "crop":"w:h:x:y", "full":true, "seconds":15, "scroll":900, "click":"Text",
 *                 "why":"what post this is for"}
 */
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DIR = process.env.X_DATA_DIR ? resolve(process.env.X_DATA_DIR) : join(ROOT, "data", "x");
const REQUESTS = join(DIR, "capture-requests.json");
const MANIFEST = join(DIR, "captures.json");
const CAPTURE = join(ROOT, "capture", "capture.mjs");

const today = new Intl.DateTimeFormat("en-CA", { timeZone: process.env.X_TZ || "America/Chicago" }).format(new Date()).replaceAll("-", "");
// Standing views: [{kind, url, name, crop?, why}]. "{date}" in a name becomes yyyymmdd.
// The original setup shot three local dashboard pages (loop stats, project fleet, a 3D graph).
const STANDING_FILE = join(ROOT, "capture", "standing.json");
const STANDING = (existsSync(STANDING_FILE) ? JSON.parse(readFileSync(STANDING_FILE, "utf8")) : [])
  .map((v) => ({ ...v, name: String(v.name).replaceAll("{date}", today) }));

const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return d; } };
const writeJson = (f, v) => { const t = `${f}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(v, null, 2) + "\n"); renameSync(t, f); };
const safeName = (n) => /^[\w][\w.-]*\.(jpg|jpeg|png|mp4)$/i.test(n) && !n.includes("..");

function capture(r) {
  if (!safeName(String(r.name || ""))) return { ok: false, error: "bad name (letters, digits, - _ . and a .jpg/.png/.mp4 extension)" };
  if (!/^https?:\/\//.test(String(r.url || ""))) return { ok: false, error: "url must be http(s)" };
  const a = [CAPTURE, r.kind === "rec" ? "rec" : "shot", r.url, r.name];
  if (r.crop) a.push("--crop", String(r.crop));
  if (r.full) a.push("--full");
  if (r.click) a.push("--click", String(r.click));
  if (r.kind === "rec") { a.push("--seconds", String(r.seconds || 12)); if (r.scroll) a.push("--scroll", String(r.scroll)); }
  try {
    execFileSync(process.execPath, a, { stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.stderr || e.message).split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300) };
  }
}

mkdirSync(join(DIR, "media"), { recursive: true });
const requests = readJson(REQUESTS, []);
// Clear the requests before capturing so a request x-studio adds mid-run isn't lost.
writeJson(REQUESTS, []);
const manifest = readJson(MANIFEST, []);
const done = [];
for (const r of [...requests, ...STANDING]) {
  if (STANDING.includes(r) && existsSync(join(DIR, "media", r.name))) continue;
  const res = capture(r);
  done.push({ ...r, ...res, capturedAt: new Date().toISOString(), requested: !STANDING.includes(r) });
  console.log(`${res.ok ? "ok  " : "FAIL"} ${r.name}${res.error ? ` — ${res.error}` : ""}`);
}
writeJson(MANIFEST, [...done, ...manifest].slice(0, 300));
const failed = done.filter((d) => !d.ok).length;
console.log(`${done.length - failed} captured, ${failed} failed`);
process.exit(failed && failed === done.length ? 1 : 0);
