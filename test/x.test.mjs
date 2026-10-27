import { test, before } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const CLI = join(ROOT, "bin", "x.mjs");
let DATA;
let x;

/** Every test run works on a throwaway copy of the sample data. */
before(async () => {
  DATA = mkdtempSync(join(tmpdir(), "x-studio-test-"));
  cpSync(join(ROOT, "data", "example", "x"), DATA, { recursive: true });
  process.env.X_DATA_DIR = DATA;
  x = await import(CLI);
});

const run = (args, env = {}) => {
  const e = { ...process.env, X_DATA_DIR: DATA, ...env };
  if (!("RUN_ID" in env)) delete e.RUN_ID;
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, env: e, encoding: "utf8" });
};
const queue = () => JSON.parse(readFileSync(join(DATA, "queue.json"), "utf8"));
const draft = (over = {}) => ({
  theme: "t", format: "Single · image",
  tweets: [{ text: "shipped a thing today. 3 bugs fixed", media: ["sample-proof.png"] }],
  proof: "placeholder", sources: ["README.md"], ...over,
});
const writeDraft = (d) => { const f = join(DATA, `draft-${Math.random().toString(36).slice(2)}.json`); writeFileSync(f, JSON.stringify(d)); return f; };

test("centralIso handles both sides of the DST change", () => {
  assert.equal(x.centralIso("2026-07-01", "08:30"), "2026-07-01T08:30:00-05:00");
  assert.equal(x.centralIso("2026-12-01", "08:30"), "2026-12-01T08:30:00-06:00");
});

test("a clean draft passes the gate", () => {
  assert.deepEqual(x.validate(draft(), x.read()), []);
});

test("the gate rejects the AI tells and the policy breaks", () => {
  const cases = [
    [{ tweets: [{ text: "a".repeat(281), media: ["sample-proof.png"] }] }, /281\/280/],
    [{ tweets: [{ text: "see example.com for more", media: ["sample-proof.png"] }] }, /no links in the main post/],
    [{ tweets: [{ text: "it works — finally", media: ["sample-proof.png"] }] }, /em\/en dash/],
    [{ tweets: [{ text: "shipped #buildinpublic", media: ["sample-proof.png"] }] }, /no hashtags/],
    [{ tweets: [{ text: "time to delve into it", media: ["sample-proof.png"] }] }, /banned phrase "delve"/],
    [{ tweets: [{ text: "built for acme client co", media: ["sample-proof.png"] }] }, /denylisted term/],
    [{ tweets: [{ text: "mail me a@b.co", media: ["sample-proof.png"] }] }, /email address/],
    [{ tweets: [{ text: "no proof here", media: [] }] }, /every post carries proof/],
    [{ tweets: [{ text: "missing file", media: ["nope.png"] }] }, /media missing/],
    [{ sources: ["does/not/exist.md"] }, /sources: not found/],
    [{ proof: "" }, /proof:/],
  ];
  for (const [over, re] of cases) {
    const errs = x.validate(draft(over), x.read());
    assert.ok(errs.some((e) => re.test(e)), `${re} not in ${JSON.stringify(errs)}`);
  }
});

test("duplicate openings are refused", () => {
  const q = x.read();
  const errs = x.validate(draft({ tweets: [{ text: q.posts[0].tweets[0].text, media: ["sample-proof.png"] }] }), q);
  assert.ok(errs.some((e) => /duplicates the opening/.test(e)));
});

test("free slots respect the two-a-day cap and three-hour spacing", () => {
  const from = new Date("2026-11-02T06:00:00-06:00");
  const slots = x.freeSlots(x.read(), 4, from);
  // Nov 2 already holds two posts, so the first free slot is on Nov 3, after the pending 8:30.
  assert.equal(slots[0], "2026-11-03T12:30:00-06:00");
  const perDay = {};
  for (const s of slots) perDay[s.slice(0, 10)] = (perDay[s.slice(0, 10)] || 0) + 1;
  for (const n of Object.values(perDay)) assert.ok(n <= x.MAX_PER_DAY);
});

test("add queues a draft as pending; an agent run cannot approve it", () => {
  const add = run(["add", writeDraft(draft({ tweets: [{ text: "new post from the test suite", media: ["sample-proof.png"] }] })), "--json"]);
  assert.equal(add.status, 0, add.stderr);
  const { id } = JSON.parse(add.stdout);
  assert.equal(queue().posts.find((p) => p.id === id).status, "pending");

  const blocked = run(["approve", id], { RUN_ID: "agent-run-1" });
  assert.equal(blocked.status, 4);
  assert.equal(queue().posts.find((p) => p.id === id).status, "pending");

  const ok = run(["approve", id]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(queue().posts.find((p) => p.id === id).status, "scheduled");
});

test("check rejects without writing", () => {
  const before = readFileSync(join(DATA, "queue.json"), "utf8");
  const r = run(["check", writeDraft(draft({ tweets: [{ text: "x", media: [] }] }))]);
  assert.equal(r.status, 3);
  assert.equal(readFileSync(join(DATA, "queue.json"), "utf8"), before);
});

test("releasing a held draft sends it back to review, never onto the schedule", () => {
  assert.equal(run(["hold", "X003"]).status, 0);
  assert.equal(queue().posts.find((p) => p.id === "X003").status, "held");
  assert.equal(run(["release", "X003"], { RUN_ID: "agent-run-2" }).status, 4);
  assert.equal(run(["release", "X003"]).status, 0);
  assert.equal(queue().posts.find((p) => p.id === "X003").status, "pending");
});

test("mark needs a real status URL; two failures park a post", () => {
  assert.notEqual(run(["mark", "X002", "--url", "https://example.com/nope"]).status, 0);
  run(["fail", "X002", "--reason", "upload refused"]);
  assert.equal(queue().posts.find((p) => p.id === "X002").status, "scheduled");
  run(["fail", "X002", "--reason", "upload refused"]);
  assert.equal(queue().posts.find((p) => p.id === "X002").status, "failed");
});

test("request-capture validates names and URLs", () => {
  assert.notEqual(run(["request-capture", "--url", "http://127.0.0.1:3000/", "--name", "../escape.jpg"]).status, 0);
  assert.notEqual(run(["request-capture", "--url", "file:///etc/passwd", "--name", "a.jpg"]).status, 0);
  assert.equal(run(["request-capture", "--url", "http://127.0.0.1:3000/stats", "--name", "20261102-stats.jpg"]).status, 0);
  const reqs = JSON.parse(readFileSync(join(DATA, "capture-requests.json"), "utf8"));
  assert.equal(reqs.at(-1).name, "20261102-stats.jpg");
});
