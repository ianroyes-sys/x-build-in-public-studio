import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { type PendingAnswer } from "@/lib/loops";
import { ENGINE, IS_SNAP, answersFile, runnable, startRun } from "@/lib/server/loops";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * THE FEED — the X queue, read live off data/x/queue.json.
 *
 * x-studio drafts posts as `pending`; the owner's one tap here (approve) makes them `scheduled`;
 * the posting lane publishes scheduled posts at their slot. Every mutation shells out to
 * scripts/x.mjs so the CLI, the loops and this room share one gate and one lock.
 */

const X = path.join(process.cwd(), "scripts", "x.mjs");
const QUEUE = path.join(process.cwd(), "data", "x", "queue.json");
const MEDIA = path.join(process.cwd(), "data", "x", "media");
const WRITER = "x-studio";
const POSTER = "x-post";

export type XTweet = { text: string; media: string[] };
export type XPost = {
  id: string;
  status: "pending" | "scheduled" | "held" | "posted" | "failed" | "skipped";
  slot: string;
  theme: string;
  format: string;
  tweets: XTweet[];
  proof: string;
  sources: string[];
  why: string[];
  flag: string;
  aiMedia: boolean;
  createdBy: string;
  createdAt: string;
  approvedAt?: string;
  postedAt?: string;
  url?: string;
  attempts?: number;
  lastError?: string;
};
export type XLane = {
  slug: string;
  installed: boolean;
  status: string | null;
  lastRunAt: string | null;
  summary: string | null;
  needs: string | null;
  paused: boolean;
};
export type XFeed = {
  account: { handle: string | null };
  posts: XPost[];
  lanes: { writer: XLane; poster: XLane };
  updatedAt: string | null;
};

function lane(slug: string): XLane {
  // A spec alone runs nothing: unknown lanes fail closed in runtime_policy.py, and only
  // loops/install.sh creates the schedule. Installed means scheduled.
  const installed =
    fs.existsSync(path.join(ENGINE, "specs", `${slug}.md`)) &&
    fs.existsSync(path.join(process.env.HOME || "", "Library", "LaunchAgents", `com.royz.loop.${slug}.plist`));
  let s: Record<string, unknown> = {};
  try {
    s = JSON.parse(fs.readFileSync(path.join(ENGINE, "state", `${slug}.json`), "utf8"));
  } catch {
    /* never ran */
  }
  const summary = typeof (s.lastOutcome as { summary?: string } | undefined)?.summary === "string"
    ? (s.lastOutcome as { summary: string }).summary
    : null;
  const needs = summary?.match(/^NEEDS IAN:\s*(.+)$/m)?.[1]?.trim() ?? null;
  return {
    slug,
    installed,
    status: typeof s.status === "string" ? s.status : null,
    lastRunAt: typeof s.lastRunAt === "string" ? s.lastRunAt : null,
    summary,
    needs: needs && needs.toLowerCase() !== "nothing" ? needs : null,
    paused: fs.existsSync(path.join(ENGINE, "paused", slug)) || fs.existsSync(path.join(ENGINE, "STOP")),
  };
}

function readFeed(): XFeed {
  let q: { account?: { handle?: string | null }; posts?: XPost[]; updatedAt?: string } = {};
  try {
    q = JSON.parse(fs.readFileSync(QUEUE, "utf8"));
  } catch {
    /* empty queue renders the empty state */
  }
  const posts = [...(q.posts || [])].sort((a, b) => +new Date(a.slot) - +new Date(b.slot));
  return {
    account: { handle: q.account?.handle ?? null },
    posts,
    lanes: { writer: lane(WRITER), poster: lane(POSTER) },
    updatedAt: q.updatedAt ?? null,
  };
}

function run(cmd: string, args: string[], timeout = 25_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    // RUN_ID is how x.mjs tells a loop from the owner; the server must never carry one.
    const env = { ...process.env };
    delete env.RUN_ID;
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024, cwd: process.cwd(), env }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: (stdout || stderr || String(err ?? "")).trim() }),
    );
  });
}

function copyPlain(text: string): Promise<void> {
  return new Promise((resolve) => {
    const p = execFile("pbcopy", () => resolve());
    p.stdin?.end(text);
  });
}

export async function GET() {
  return NextResponse.json(readFeed());
}

/**
 * POST { action, id? , ids?, handle? }
 *   approve      — { id }   the owner's one tap: pending → scheduled
 *   approve-many — { ids }  the same tap over a visible list (each id still validated)
 *   hold | release | skip | restore — { id }
 *   push         — { id }   fire the posting lane at one scheduled post now
 *   stage        — { id, tweet? } that tweet's text → clipboard, X composer opens, media revealed in Finder
 *   draft-more   — run x-studio now
 *   set-handle   — { handle }
 */
export async function POST(req: NextRequest) {
  if (IS_SNAP) return NextResponse.json({ error: "read-only snapshot" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");
  const id = String(body.id || "");
  const okId = (s: string) => /^X\d{3,5}$/.test(s);

  const cli = async (...args: string[]) => {
    const r = await run("node", [X, ...args, "--json"]);
    if (!r.ok) return NextResponse.json({ error: r.out.split("\n").pop() || "failed" }, { status: 409 });
    return NextResponse.json({ ok: true, feed: readFeed() });
  };

  switch (action) {
    case "approve":
    case "hold":
    case "release":
    case "skip":
    case "restore":
      if (!okId(id)) return NextResponse.json({ error: "bad-id" }, { status: 400 });
      return cli(action, id);

    case "approve-many": {
      const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String) : [];
      if (!ids.length || !ids.every(okId)) return NextResponse.json({ error: "bad-ids" }, { status: 400 });
      const failed: string[] = [];
      for (const one of ids) {
        const r = await run("node", [X, "approve", one, "--json"]);
        if (!r.ok) failed.push(one);
      }
      return NextResponse.json({ ok: failed.length === 0, failed, feed: readFeed() });
    }

    case "push": {
      if (!okId(id)) return NextResponse.json({ error: "bad-id" }, { status: 400 });
      const post = readFeed().posts.find((p) => p.id === id);
      if (!post) return NextResponse.json({ error: "no-such-post" }, { status: 404 });
      if (post.status !== "scheduled") return NextResponse.json({ error: `post is ${post.status} — approve it first` }, { status: 409 });
      if (!lane(POSTER).installed) {
        return NextResponse.json({ error: "the posting lane isn't installed — use STAGE to post it yourself" }, { status: 409 });
      }
      const gate = runnable(POSTER);
      if (!gate.ok) return NextResponse.json({ error: "loop-gated", why: gate.why }, { status: 409 });
      const entry: PendingAnswer = {
        at: new Date().toISOString(),
        kind: "note",
        text:
          `TARGETED PUSH from Omega: post ${id} on this pass, ahead of its slot. Everything ` +
          `else in the spec is unchanged — right account, verbatim, confirm on the profile ` +
          `before marking, then \`mark ${id}\` with its status URL, and post nothing else.`,
      };
      fs.appendFileSync(answersFile(POSTER), JSON.stringify(entry) + "\n", "utf8");
      startRun(POSTER);
      return NextResponse.json({ ok: true, pushed: id, via: POSTER });
    }

    case "stage": {
      if (!okId(id)) return NextResponse.json({ error: "bad-id" }, { status: 400 });
      const post = readFeed().posts.find((p) => p.id === id);
      if (!post) return NextResponse.json({ error: "no-such-post" }, { status: 404 });
      const i = Math.max(0, Math.min(post.tweets.length - 1, Number(body.tweet) || 0));
      const t = post.tweets[i];
      await copyPlain(t.text);
      await run("open", ["https://x.com/compose/post"]);
      const media = t.media.map((m) => path.join(MEDIA, path.basename(m))).filter((m) => fs.existsSync(m));
      if (media.length) await run("open", ["-R", media[0]]);
      return NextResponse.json({ ok: true, staged: id, tweet: i, chars: [...t.text].length, media: media.length });
    }

    case "draft-more": {
      const gate = runnable(WRITER);
      if (!gate.ok) return NextResponse.json({ error: "loop-gated", why: gate.why }, { status: 409 });
      startRun(WRITER);
      return NextResponse.json({ ok: true, started: WRITER });
    }

    case "set-handle": {
      const handle = String(body.handle || "").replace(/^@/, "");
      if (!/^\w{1,15}$/.test(handle)) return NextResponse.json({ error: "bad-handle" }, { status: 400 });
      return cli("set-handle", handle);
    }

    default:
      return NextResponse.json({ error: "unknown-action" }, { status: 400 });
  }
}
