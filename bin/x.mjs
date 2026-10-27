#!/usr/bin/env node
/**
 * x.mjs — the X (Twitter) queue. Every read and write of data/x/queue.json goes through here:
 * the x-studio agent adds drafts, the owner approves them (one tap each, in THE FEED or with
 * `approve`), and the x-post agent publishes approved posts at their slot. Nothing in here
 * talks to X.
 *
 * The data directory defaults to ./data/x next to this repo; set X_DATA_DIR to move it.
 *
 *   bin/x.mjs list [--json]               the whole queue, by slot
 *   bin/x.mjs due [--json]                the one approved post to publish now, or {found:false}
 *   bin/x.mjs get <id> [--json]           one post, with absolute media paths
 *   bin/x.mjs slots [--n 6] [--json]      the next free posting slots
 *   bin/x.mjs add <draft.json> [--slot ISO]   validate, then queue as pending (awaiting approval)
 *   bin/x.mjs check <draft.json>          validate only, write nothing
 *   bin/x.mjs approve <id>                the owner's tap: pending → scheduled
 *   bin/x.mjs mark <id> --url <status-url>    posted, confirmed on-page
 *   bin/x.mjs fail <id> --reason "..."    a failed attempt; the second one parks it
 *   bin/x.mjs hold|release|skip|restore <id>
 *   bin/x.mjs set-handle <handle>
 *   bin/x.mjs request-capture --url <url> --name <file> [--kind shot|rec] [--crop w:h:x:y] [--seconds n] [--scroll px] [--click "Text"]
 *
 * capture-requests.json is drained by capture/daily.mjs (the x-capture Dagu job, 6:15).
 *
 * Approval belongs to the human. `approve` and `release` refuse to run when RUN_ID is set
 * (the agent runner exports it), so no agent can schedule its own draft.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmdirSync, statSync } from "node:fs";
import { join, resolve, isAbsolute, extname } from "node:path";
import { homedir } from "node:os";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DIR = process.env.X_DATA_DIR ? resolve(process.env.X_DATA_DIR) : join(ROOT, "data", "x");
const QUEUE = join(DIR, "queue.json");
const MEDIA = join(DIR, "media");
const DENY = join(DIR, "denylist.txt");
const LOCK = join(DIR, ".queue.lock");

export const TZ = process.env.X_TZ || "America/Chicago";
/** Posting times, Central. Two posts a day at most while the account is new. */
export const SLOT_TIMES = ["08:30", "12:30", "17:30"];
export const MAX_PER_DAY = 2;
/** A slot missed by more than this (Mac asleep, browser busy) is rescheduled, never dumped late. */
const STALE_MS = 6 * 3600_000;

const IMAGE = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const VIDEO = new Set([".mp4", ".mov"]);
// From the writing style guide: the tells that make a post read as generated.
const BANNED = [
  "delve", "dive into", "deep dive", "unpack", "unlock", "unleash", "elevate", "empower", "supercharge",
  "game-changer", "game changer", "game-changing", "revolutionize", "seamless", "robust", "leverage",
  "harness", "landscape", "realm", "tapestry", "journey", "embark", "foster", "cultivate", "pivotal",
  "comprehensive", "holistic", "synergy", "streamline", "fast-paced world", "it's important to note",
  "worth noting", "at the end of the day", "key takeaway", "let's explore", "buckle up", "look no further",
  "next level", "a testament to", "underscores", "here's the thing", "the kicker", "let that sink in",
  "no fluff", "great question", "i hope this helps", "ever wondered",
];

// ── time ─────────────────────────────────────────────────────────────────────
function tzOffsetMin(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}
/** "2026-10-24", "08:30" in Central → ISO with the right offset (DST-safe). */
export function centralIso(ymd, hm) {
  const guess = new Date(`${ymd}T${hm}:00Z`);
  const off = tzOffsetMin(new Date(guess.getTime() - tzOffsetMin(guess) * 60000));
  const sign = off < 0 ? "-" : "+";
  const a = Math.abs(off);
  return `${ymd}T${hm}:00${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}
function centralYmd(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const fmt = (iso) => new Date(iso).toLocaleString("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// ── store ────────────────────────────────────────────────────────────────────
export function read() {
  if (!existsSync(QUEUE)) return { account: { handle: null }, posts: [] };
  return JSON.parse(readFileSync(QUEUE, "utf8"));
}
function write(q) {
  q.updatedAt = new Date().toISOString();
  const tmp = `${QUEUE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(q, null, 2) + "\n");
  renameSync(tmp, QUEUE);
}
/** mkdir is atomic; a lock older than a minute belongs to a dead process. */
function locked(fn) {
  mkdirSync(DIR, { recursive: true });
  for (let i = 0; ; i++) {
    try { mkdirSync(LOCK); break; } catch {
      try { if (Date.now() - statSync(LOCK).mtimeMs > 60_000) { rmdirSync(LOCK); continue; } } catch { continue; }
      if (i > 50) throw new Error("queue lock busy");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try { return fn(); } finally { try { rmdirSync(LOCK); } catch {} }
}

/** Statuses that hold a slot: awaiting approval, approved, or paused. */
const holdsSlot = (p) => ["pending", "scheduled", "held", "posted"].includes(p.status);
const byslot = (a, b) => new Date(a.slot) - new Date(b.slot);
export const mediaAbs = (m) => (isAbsolute(m) ? m : join(MEDIA, m));
const srcAbs = (s) => (s.startsWith("~/") ? join(homedir(), s.slice(2)) : isAbsolute(s) ? s : join(ROOT, s));

export function freeSlots(q, n = 6, from = new Date()) {
  const taken = new Map();
  for (const p of q.posts) if (holdsSlot(p)) {
    const k = centralYmd(new Date(p.slot));
    taken.set(k, [...(taken.get(k) || []), new Date(p.slot).getTime()]);
  }
  const out = [];
  let ymd = centralYmd(from);
  for (let d = 0; out.length < n && d < 90; d++, ymd = addDays(ymd, 1)) {
    const day = taken.get(ymd) || [];
    let used = day.length;
    for (const hm of SLOT_TIMES) {
      if (used >= MAX_PER_DAY || out.length >= n) break;
      const iso = centralIso(ymd, hm);
      const t = new Date(iso).getTime();
      if (t <= from.getTime() + 15 * 60000) continue;
      if (day.some((x) => Math.abs(x - t) < 3 * 3600_000)) continue;
      out.push(iso); used++;
    }
  }
  return out;
}

// ── the gate ─────────────────────────────────────────────────────────────────
export function validate(draft, q = read()) {
  const errs = [];
  const deny = existsSync(DENY)
    ? readFileSync(DENY, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    : [];
  if (!Array.isArray(draft.tweets) || !draft.tweets.length) errs.push("tweets: need at least one");
  if ((draft.tweets || []).length > 6) errs.push("tweets: 6 max — a longer thread loses people");
  (draft.tweets || []).forEach((t, i) => {
    const tag = i === 0 ? "post" : `reply ${i}`;
    const text = String(t.text || "");
    const len = [...text.replace(/https?:\/\/\S+/g, "x".repeat(23))].length;
    if (!text.trim()) errs.push(`${tag}: empty`);
    if (len > 280) errs.push(`${tag}: ${len}/280 characters`);
    if (i === 0 && /https?:\/\/|\b[a-z0-9-]+\.(com|app|io|ai|co|dev)\b/i.test(text)) errs.push("post: no links in the main post — X shows it to fewer people; put the link in a reply");
    if (/—|–/.test(text)) errs.push(`${tag}: em/en dash reads as AI — use a period or a line break`);
    if (/(^|\s)#\w/.test(text)) errs.push(`${tag}: no hashtags`);
    if (/[\w.+-]+@[\w-]+\.\w+/.test(text)) errs.push(`${tag}: contains an email address`);
    if (/\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/.test(text)) errs.push(`${tag}: contains a phone number`);
    const low = text.toLowerCase();
    for (const b of BANNED) if (low.includes(b)) errs.push(`${tag}: banned phrase "${b}"`);
    for (const d of deny) if (low.includes(d.toLowerCase())) errs.push(`${tag}: denylisted term "${d}" (data/x/denylist.txt)`);
    const media = t.media || [];
    const vids = media.filter((m) => VIDEO.has(extname(m).toLowerCase()));
    const imgs = media.filter((m) => IMAGE.has(extname(m).toLowerCase()));
    if (vids.length + imgs.length !== media.length) errs.push(`${tag}: unsupported media type`);
    if (vids.length > 1 || (vids.length && imgs.length) || imgs.length > 4) errs.push(`${tag}: one video, or up to four images`);
    for (const m of media) {
      const abs = mediaAbs(m);
      if (!existsSync(abs)) { errs.push(`${tag}: media missing ${m}`); continue; }
      const mb = statSync(abs).size / 1e6;
      if (IMAGE.has(extname(m).toLowerCase()) && mb > 5) errs.push(`${tag}: image ${m} is ${mb.toFixed(1)}MB (5MB max)`);
      if (VIDEO.has(extname(m).toLowerCase()) && mb > 512) errs.push(`${tag}: video ${m} is too large`);
    }
  });
  if (!(draft.tweets?.[0]?.media || []).length) errs.push("post: every post carries proof — attach the screenshot or recording");
  if (!String(draft.proof || "").trim()) errs.push("proof: say where the media and every number came from");
  if (!Array.isArray(draft.sources) || !draft.sources.length) errs.push("sources: list the files the facts were read from");
  for (const s of draft.sources || []) if (!existsSync(srcAbs(s))) errs.push(`sources: not found ${s}`);
  const first = String(draft.tweets?.[0]?.text || "").toLowerCase().slice(0, 60);
  if (first && q.posts.some((p) => p.status !== "skipped" && String(p.tweets?.[0]?.text || "").toLowerCase().slice(0, 60) === first)) {
    errs.push("post: duplicates the opening of a post already in the queue");
  }
  if (draft.slot) {
    const t = new Date(draft.slot).getTime();
    if (Number.isNaN(t)) errs.push("slot: not a date");
    else if (t < Date.now()) errs.push("slot: in the past");
  }
  return errs;
}

function nextId(q) {
  const n = q.posts.reduce((m, p) => Math.max(m, +(String(p.id).match(/\d+/)?.[0] || 0)), 0) + 1;
  return `X${String(n).padStart(3, "0")}`;
}

// ── cli ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name, dflt = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const json = args.includes("--json");
const out = (o, text) => console.log(json ? JSON.stringify(o, null, 2) : text ?? JSON.stringify(o, null, 2));
const die = (msg, code = 1) => { console.error(msg); process.exit(code); };
const withMedia = (p) => ({ ...p, tweets: p.tweets.map((t) => ({ ...t, mediaAbs: (t.media || []).map(mediaAbs) })) });
const stamp = (p, to, extra = {}) => { p.history = [...(p.history || []), { at: new Date().toISOString(), to, ...extra }]; };

/** Move a post whose slot has passed to the next free one. */
function reslot(q, p) {
  if (new Date(p.slot).getTime() > Date.now() + 15 * 60000) return;
  const [slot] = freeSlots({ posts: q.posts.filter((x) => x !== p) }, 1);
  stamp(p, p.status, { rescheduled: { from: p.slot, to: slot } });
  p.slot = slot;
}

function setStatus(id, from, to, extra = {}, fix) {
  return locked(() => {
    const q = read();
    const p = q.posts.find((x) => x.id === id);
    if (!p) die(`no post ${id}`);
    if (!from.includes(p.status)) die(`${id} is ${p.status}; cannot move to ${to}`, 2);
    Object.assign(p, { status: to }, extra);
    if (fix) fix(q, p);
    stamp(p, to, extra);
    write(q);
    return p;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, id] = args;
  switch (cmd) {
    case "list": {
      const q = read();
      const posts = [...q.posts].sort(byslot);
      out({ account: q.account, posts }, posts.map((p) => `${p.id}  ${p.status.padEnd(9)} ${fmt(p.slot).padEnd(24)} ${String(p.tweets[0].text).split("\n")[0].slice(0, 70)}`).join("\n") || "queue empty");
      break;
    }
    case "due": {
      const res = locked(() => {
        const q = read();
        const now = Date.now();
        const moved = [];
        // Stale approved slots move forward instead of going out hours late or several at once.
        for (const p of q.posts.filter((x) => x.status === "scheduled").sort(byslot)) {
          if (now - new Date(p.slot).getTime() > STALE_MS) {
            const from = p.slot;
            reslot(q, p);
            moved.push({ id: p.id, from, to: p.slot });
          }
        }
        if (moved.length) write(q);
        const due = q.posts.filter((p) => p.status === "scheduled" && new Date(p.slot).getTime() <= now + 5 * 60000).sort(byslot)[0];
        return { moved, account: q.account, due };
      });
      if (!res.due) out({ found: false, moved: res.moved, account: res.account }, `nothing due${res.moved.length ? ` (rescheduled ${res.moved.map((m) => m.id).join(", ")})` : ""}`);
      else out({ found: true, moved: res.moved, account: res.account, post: withMedia(res.due) }, `${res.due.id} due ${fmt(res.due.slot)}`);
      break;
    }
    case "get": {
      const p = read().posts.find((x) => x.id === id);
      if (!p) die(`no post ${id}`);
      out(withMedia(p));
      break;
    }
    case "slots": {
      const s = freeSlots(read(), +(flag("n", 6)));
      out(s, s.map(fmt).join("\n"));
      break;
    }
    case "check":
    case "add": {
      if (!id) die("usage: x.mjs add <draft.json> [--slot ISO]");
      const draft = JSON.parse(readFileSync(resolve(id), "utf8"));
      if (flag("slot")) draft.slot = flag("slot");
      const res = locked(() => {
        const q = read();
        const errs = validate(draft, q);
        if (errs.length || cmd === "check") return { ok: !errs.length, errors: errs };
        const slot = draft.slot || freeSlots(q, 1)[0];
        const p = {
          id: nextId(q), status: "pending", slot,
          theme: draft.theme || "", format: draft.format || "",
          tweets: draft.tweets.map((t) => ({ text: t.text, media: t.media || [] })),
          proof: draft.proof, sources: draft.sources, why: draft.why || [], flag: draft.flag || "",
          aiMedia: !!draft.aiMedia, createdBy: draft.createdBy || "x-studio", createdAt: new Date().toISOString(),
          attempts: 0, history: [{ at: new Date().toISOString(), to: "pending" }],
        };
        q.posts.push(p);
        write(q);
        return { ok: true, id: p.id, slot };
      });
      out(res, res.ok ? (res.id ? `queued ${res.id} for ${fmt(res.slot)}, awaiting approval` : "ok") : `REJECTED\n- ${res.errors.join("\n- ")}`);
      if (!res.ok) process.exit(3);
      break;
    }
    case "approve": {
      if (process.env.RUN_ID) die("approval is the owner's tap — an agent run cannot approve a post", 4);
      const p = setStatus(id, ["pending"], "scheduled", { approvedAt: new Date().toISOString() }, reslot);
      out(p, `${id} approved for ${fmt(p.slot)}`);
      break;
    }
    case "mark": {
      const url = flag("url");
      if (!url || !/^https:\/\/(x|twitter)\.com\/\w+\/status\/\d+/.test(url)) die("mark needs --url https://x.com/<handle>/status/<id> — the confirmed post");
      const p = setStatus(id, ["scheduled"], "posted", { url, postedAt: new Date().toISOString() });
      out(p, `${id} posted ${url}`);
      break;
    }
    case "fail": {
      const reason = flag("reason", "unspecified");
      const p = locked(() => {
        const q = read();
        const p = q.posts.find((x) => x.id === id);
        if (!p) die(`no post ${id}`);
        p.attempts = (p.attempts || 0) + 1;
        p.lastError = reason;
        if (p.attempts >= 2) p.status = "failed";
        stamp(p, p.status, { error: reason });
        write(q);
        return p;
      });
      out(p, `${id} attempt ${p.attempts} failed: ${reason}${p.status === "failed" ? " — parked as failed" : ""}`);
      break;
    }
    case "hold": {
      const p = locked(() => {
        const q = read();
        const p = q.posts.find((x) => x.id === id);
        if (!p) die(`no post ${id}`);
        if (!["scheduled", "pending"].includes(p.status)) die(`${id} is ${p.status}; cannot hold`, 2);
        // Remember where it was: releasing a held draft must never approve it.
        p.heldFrom = p.status;
        p.status = "held";
        stamp(p, "held", { heldFrom: p.heldFrom });
        write(q);
        return p;
      });
      out(p, `${id} held`);
      break;
    }
    case "release": {
      if (process.env.RUN_ID) die("releasing a hold is the owner's call — an agent run cannot do it", 4);
      const p = locked(() => {
        const q = read();
        const p = q.posts.find((x) => x.id === id);
        if (!p) die(`no post ${id}`);
        if (p.status !== "held") die(`${id} is ${p.status}; nothing to release`, 2);
        p.status = p.heldFrom === "scheduled" ? "scheduled" : "pending";
        delete p.heldFrom;
        reslot(q, p);
        stamp(p, p.status, { released: true });
        write(q);
        return p;
      });
      out(p, `${id} released — ${p.status === "scheduled" ? "back on schedule" : "back in review"}`);
      break;
    }
    case "skip": out(setStatus(id, ["scheduled", "held", "pending", "failed"], "skipped"), `${id} skipped`); break;
    case "restore": {
      // Restored posts go back to review, not straight onto the schedule.
      const p = setStatus(id, ["skipped", "failed"], "pending", { attempts: 0 }, reslot);
      out(p, `${id} back in review for ${fmt(p.slot)}`);
      break;
    }
    case "set-handle": {
      const h = String(id || "").replace(/^@/, "");
      if (!/^\w{1,15}$/.test(h)) die("handle: letters, digits, underscore, 15 max");
      const acct = locked(() => { const q = read(); q.account = { ...q.account, handle: h, setAt: new Date().toISOString() }; write(q); return q.account; });
      out(acct, `posting as @${h}`);
      break;
    }
    case "request-capture": {
      // x-studio can't run a browser in its sandbox; the x-capture Dagu job (6:15 daily) does.
      const r = {
        kind: flag("kind", "shot") === "rec" ? "rec" : "shot",
        url: flag("url"), name: flag("name"), why: flag("why", ""),
        ...(flag("crop") ? { crop: flag("crop") } : {}), ...(args.includes("--full") ? { full: true } : {}),
        ...(flag("seconds") ? { seconds: +flag("seconds") } : {}), ...(flag("scroll") ? { scroll: +flag("scroll") } : {}),
        ...(flag("click") ? { click: flag("click") } : {}), requestedAt: new Date().toISOString(),
      };
      if (!/^https?:\/\//.test(r.url || "")) die("--url http(s)://… required");
      if (!/^[\w][\w.-]*\.(jpg|jpeg|png|mp4)$/i.test(r.name || "") || r.name.includes("..")) die("--name like 20261025-slug.jpg");
      const f = join(DIR, "capture-requests.json");
      const list = locked(() => {
        let list = [];
        try { list = JSON.parse(readFileSync(f, "utf8")); } catch {}
        list.push(r);
        const tmp = `${f}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n");
        renameSync(tmp, f);
        return list;
      });
      out({ queued: r, pending: list.length }, `queued ${r.name} for the next x-capture run (${list.length} waiting)`);
      break;
    }
    default:
      die("usage: x.mjs list|due|get|slots|add|check|approve|mark|fail|hold|release|skip|restore|set-handle|request-capture");
  }
}
