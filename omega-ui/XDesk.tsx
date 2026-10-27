"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { XFeed, XPost } from "@/app/api/x/route";

const COLOR = "#ffde3d";
const MINT = "#7ef0b2";
const ICE = "#9ad8ff";
const CORAL = "#ff5e5b";
const TZ = "America/Chicago";

/**
 * THE FEED — the owner's X account, built in public to get scouted.
 *
 * x-studio drafts posts with captured proof into data/x/queue.json as `pending`. Nothing
 * reaches X until the owner taps APPROVE here; approved posts
 * go out at their slot through the posting lane, or the owner posts them by hand with STAGE.
 * Reads /api/x live, so a draft the loop wrote a minute ago is already on this board.
 */

const STATUS: Record<XPost["status"], { label: string; color: string }> = {
  pending: { label: "NEEDS YOUR TAP", color: COLOR },
  scheduled: { label: "APPROVED", color: MINT },
  held: { label: "HELD", color: "#a49ead" },
  posted: { label: "POSTED", color: ICE },
  failed: { label: "FAILED", color: CORAL },
  skipped: { label: "SKIPPED", color: "#6f6a78" },
};

type View = "upcoming" | "posted" | "skipped";

const media = (name: string) => `/api/x/media/${encodeURIComponent(name)}`;
const isVideo = (name: string) => /\.(mp4|mov)$/i.test(name);
const dayKey = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
const dayLabel = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: TZ, weekday: "long", month: "short", day: "numeric" });
const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const chars = (s: string) => [...s.replace(/https?:\/\/\S+/g, "x".repeat(23))].length;

function useNow(ms = 30_000) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function until(iso: string, now: number) {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return "due now";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  return h >= 24 ? `in ${Math.floor(h / 24)}d ${h % 24}h` : `in ${h}h ${String(m).padStart(2, "0")}m`;
}

export default function XDesk() {
  const [feed, setFeed] = useState<XFeed | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [view, setView] = useState<View>("upcoming");
  const now = useNow();

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/x", { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      setFeed(await r.json());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  async function act(key: string, body: Record<string, unknown>, done?: string) {
    setBusy(key);
    setNotice(null);
    try {
      const r = await fetch("/api/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) {
        setNotice({ tone: "err", text: j.error ? `${j.error}${j.why ? ` (${j.why})` : ""}` : `That didn't go through (${r.status}).` });
      } else if (done) {
        setNotice({ tone: "ok", text: done });
      }
      if (j.feed) setFeed(j.feed);
      else await load();
    } catch {
      setNotice({ tone: "err", text: "Omega didn't answer. Check that it's running, then try again." });
    } finally {
      setBusy(null);
    }
  }

  const posts = useMemo(() => feed?.posts ?? [], [feed]);
  const pending = posts.filter((p) => p.status === "pending");
  const approved = posts.filter((p) => p.status === "scheduled");
  const posted = posts.filter((p) => p.status === "posted").sort((a, b) => +new Date(b.postedAt || b.slot) - +new Date(a.postedAt || a.slot));
  const nextUp = approved[0];
  const shown =
    view === "posted" ? posted
      : view === "skipped" ? posts.filter((p) => p.status === "skipped")
        : posts.filter((p) => ["pending", "scheduled", "held", "failed"].includes(p.status));
  const days = useMemo(() => {
    const m = new Map<string, XPost[]>();
    for (const p of shown) m.set(dayKey(p.slot), [...(m.get(dayKey(p.slot)) || []), p]);
    return [...m.entries()];
  }, [shown]);

  if (!feed && !failed) {
    return (
      <section className="fade-up mt-8 card p-8">
        <p className="seclabel">THE FEED</p>
        <p className="mt-3 text-sm text-fog">Reading the X queue…</p>
      </section>
    );
  }
  if (!feed) {
    return (
      <section className="fade-up mt-8 card p-8">
        <p className="seclabel">THE FEED</p>
        <p className="mt-3 text-sm text-fog">Couldn&apos;t read <span className="font-mono">data/x/queue.json</span> through /api/x.</p>
        <button onClick={load} className="mt-4 rounded-lg border border-hairline px-3 py-2 font-mono text-[11px] tracking-widest text-mist hover:text-white">TRY AGAIN</button>
      </section>
    );
  }

  const { writer, poster } = feed.lanes;
  const handle = feed.account.handle;

  return (
    <div className="mt-8 space-y-6">
      {/* ---- The instrument: what needs the owner, what's next, who's posting ---- */}
      <section className="fade-up card p-6 md:p-8">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <p className="seclabel">THE FEED · X</p>
          <a href={handle ? `https://x.com/${handle}` : "https://x.com"} target="_blank" rel="noreferrer" className="font-mono text-[12px] text-ice hover:text-white">
            {handle ? `@${handle}` : "no account set"} ↗
          </a>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-6 md:grid-cols-4">
          <div>
            <p className="seclabel mb-1">NEEDS YOUR TAP</p>
            <p className="tabular font-mono text-3xl" style={{ color: pending.length ? COLOR : "#f5f2f8" }}>{pending.length}</p>
          </div>
          <div>
            <p className="seclabel mb-1">APPROVED</p>
            <p className="tabular font-mono text-3xl" style={{ color: MINT }}>{approved.length}</p>
          </div>
          <div>
            <p className="seclabel mb-1">POSTED</p>
            <p className="tabular font-mono text-3xl text-white">{posted.length}</p>
          </div>
          <div>
            <p className="seclabel mb-1">NEXT OUT</p>
            <p className="font-mono text-sm leading-snug text-mist">
              {nextUp ? (
                <>
                  {nextUp.id} · {new Date(nextUp.slot).toLocaleDateString("en-US", { timeZone: TZ, weekday: "short" })} {timeLabel(nextUp.slot)}
                  <br />
                  <span className="text-fog">{now ? until(nextUp.slot, now) : ""}</span>
                </>
              ) : (
                <span className="text-fog">nothing approved yet</span>
              )}
            </p>
          </div>
        </div>

        {pending.length > 0 && (
          <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-hairline pt-5">
            <button
              disabled={busy !== null}
              onClick={() => act("approve-many", { action: "approve-many", ids: pending.map((p) => p.id) }, `Approved ${pending.length}. They go out at their slots.`)}
              className="rounded-lg px-4 py-2.5 font-mono text-[11px] font-medium tracking-widest text-void disabled:opacity-50"
              style={{ background: COLOR }}
            >
              {busy === "approve-many" ? "APPROVING…" : `APPROVE ALL ${pending.length} BELOW`}
            </button>
            <p className="max-w-md text-[12px] leading-relaxed text-fog">
              Or tap each post on its own. Nothing goes out until it&apos;s approved, and you can hold anything up to its slot.
            </p>
          </div>
        )}

        {/* the two lanes */}
        <div className="mt-6 grid gap-3 border-t border-hairline pt-5 md:grid-cols-2">
          <div className="rounded-xl border border-hairline bg-void/40 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="font-mono text-[10px] tracking-widest text-fog">WRITER · x-studio</p>
              <span className="font-mono text-[10px] tracking-widest" style={{ color: writer.paused ? CORAL : writer.status === "running" ? COLOR : MINT }}>
                {writer.paused ? "PAUSED" : (writer.status || "never run").toUpperCase()}
              </span>
            </div>
            <p className="mt-2 text-[12.5px] leading-relaxed text-mist">
              Drafts new posts every morning at 6:47 from what you shipped, with screenshots and recordings it captures itself. Keeps about five days queued.
            </p>
            {writer.needs && <p className="mt-2 text-[12px] leading-relaxed" style={{ color: COLOR }}>{writer.needs}</p>}
            <button
              disabled={busy !== null || writer.status === "running" || !writer.installed}
              onClick={() => act("draft-more", { action: "draft-more" }, "x-studio started. New drafts show up here as it finishes them.")}
              className="mt-3 rounded-lg border border-hairline px-3 py-2 font-mono text-[10px] tracking-widest text-mist hover:text-white disabled:opacity-40"
            >
              {busy === "draft-more" ? "STARTING…" : "DRAFT MORE NOW"}
            </button>
          </div>
          <div className="rounded-xl border border-hairline bg-void/40 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="font-mono text-[10px] tracking-widest text-fog">POSTER · x-post</p>
              <span className="font-mono text-[10px] tracking-widest" style={{ color: !poster.installed ? COLOR : poster.paused ? CORAL : MINT }}>
                {!poster.installed ? "NOT INSTALLED" : poster.paused ? "PAUSED" : (poster.status || "waiting").toUpperCase()}
              </span>
            </div>
            <p className="mt-2 text-[12.5px] leading-relaxed text-mist">
              {poster.installed
                ? `Posts approved posts at 8:30, 12:30 and 5:30 Central, two a day max, only after confirming Chrome is on @${handle ?? "your account"}.`
                : "Automatic posting isn't switched on yet. Approved posts wait here; STAGE puts the text on your clipboard, opens X's composer and shows the video in Finder."}
            </p>
            {poster.needs && <p className="mt-2 text-[12px] leading-relaxed" style={{ color: COLOR }}>{poster.needs}</p>}
          </div>
        </div>

        {notice && (
          <p role="status" className="mt-4 text-[12.5px]" style={{ color: notice.tone === "err" ? CORAL : MINT }}>
            {notice.text}
          </p>
        )}
      </section>

      {/* ---- Filter ---- */}
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Which posts">
        {(
          [
            ["upcoming", "UPCOMING", posts.filter((p) => ["pending", "scheduled", "held", "failed"].includes(p.status)).length],
            ["posted", "POSTED", posted.length],
            ["skipped", "SKIPPED", posts.filter((p) => p.status === "skipped").length],
          ] as [View, string, number][]
        ).map(([key, label, n]) => (
          <button
            key={key}
            role="tab"
            aria-selected={view === key}
            onClick={() => setView(key)}
            className="rounded-lg border px-3 py-2 font-mono text-[10px] tracking-widest"
            style={view === key ? { color: COLOR, borderColor: `${COLOR}55`, background: `${COLOR}12` } : { color: "#a49ead", borderColor: "#ffffff14" }}
          >
            {label} <span className="opacity-60">{n}</span>
          </button>
        ))}
      </div>

      {days.length === 0 && (
        <section className="card p-8 text-center">
          <p className="text-sm text-fog">
            {view === "upcoming"
              ? "Nothing queued. Press DRAFT MORE NOW and x-studio writes the next few with proof."
              : view === "posted"
                ? "Nothing has gone out yet. Approved posts land here with their live link."
                : "No skipped posts."}
          </p>
        </section>
      )}

      {days.map(([key, list]) => (
        <section key={key} className="space-y-4">
          <div className="flex items-baseline gap-3 border-b border-hairline pb-2">
            <p className="font-mono text-[11px] tracking-widest" style={{ color: COLOR }}>{dayLabel(list[0].slot).toUpperCase()}</p>
            <p className="font-mono text-[10px] text-fog">{list.length} post{list.length === 1 ? "" : "s"}</p>
          </div>
          {list.map((p) => (
            <PostCard key={p.id} p={p} handle={handle} posterReady={poster.installed && !poster.paused} busy={busy} act={act} />
          ))}
        </section>
      ))}

      <section className="card p-6">
        <p className="seclabel mb-3">HOW THESE GET PUSHED</p>
        <ul className="grid gap-3 text-[12.5px] leading-relaxed text-mist md:grid-cols-2">
          <li><span className="text-white">Answer every reply in the first hour.</span> A reply you reply back to counts for far more than a like. That hour decides whether the post leaves your followers.</li>
          <li><span className="text-white">Video and images go in the post, links go in a reply.</span> Posts with outside links get shown to fewer people.</li>
          <li><span className="text-white">20 minutes of real replies a day</span> under builders with 10–60K followers, saying what you built, not &quot;great post&quot;.</li>
          <li><span className="text-white">Every post carries proof.</span> The gate in <span className="font-mono">scripts/x.mjs</span> rejects anything without media, sources, or over 280 characters.</li>
        </ul>
      </section>
    </div>
  );
}

function PostCard({
  p, handle, posterReady, busy, act,
}: {
  p: XPost;
  handle: string | null;
  posterReady: boolean;
  busy: string | null;
  act: (key: string, body: Record<string, unknown>, done?: string) => Promise<void>;
}) {
  const st = STATUS[p.status];
  const k = (a: string) => `${a}:${p.id}`;
  const btn = "rounded-lg border border-hairline px-3 py-2 font-mono text-[10px] tracking-widest text-mist hover:text-white disabled:opacity-40";
  const slotPassed = new Date(p.slot).getTime() < Date.now();

  return (
    <article className="card grid gap-5 p-5 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] md:p-6" style={p.status === "pending" ? { borderColor: `${COLOR}40` } : undefined}>
      {/* the post, as it will read */}
      <div className="min-w-0">
        {p.tweets.map((t, i) => (
          <div key={i} className={i ? "mt-4 border-t border-hairline pt-4" : ""}>
            <div className="mb-2 flex items-center gap-2">
              <span className="font-mono text-[10px] tracking-widest text-fog">{i === 0 ? "POST" : `REPLY ${i}`}</span>
              <span className="font-mono text-[10px]" style={{ color: chars(t.text) > 280 ? CORAL : "#6f6a78" }}>{chars(t.text)}/280</span>
              {p.status !== "posted" && (
                <button
                  disabled={busy !== null}
                  onClick={() => act(k(`stage${i}`), { action: "stage", id: p.id, tweet: i }, `Copied ${i === 0 ? "the post" : `reply ${i}`}. X's composer is open${t.media.length ? " and the media is selected in Finder" : ""}.`)}
                  className="ml-auto font-mono text-[10px] tracking-widest text-fog hover:text-white disabled:opacity-40"
                >
                  {busy === k(`stage${i}`) ? "…" : "STAGE"}
                </button>
              )}
            </div>
            <p className="whitespace-pre-wrap break-words text-[14.5px] leading-relaxed text-[#f1eef6]">{t.text}</p>
            {t.media.length > 0 && (
              <div className={`mt-3 overflow-hidden rounded-xl border border-hairline bg-black ${t.media.length > 1 ? "grid grid-cols-2 gap-0.5" : ""}`}>
                {t.media.map((m) =>
                  isVideo(m) ? (
                    <video key={m} src={media(m)} controls muted playsInline preload="metadata" className="block max-h-[520px] w-full object-contain" />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={m} src={media(m)} alt="" loading="lazy" className={`block w-full object-contain ${t.media.length > 1 ? "aspect-[16/10] object-cover" : "max-h-[520px]"}`} />
                  ),
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* why, proof, and the controls */}
      <div className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border px-2 py-0.5 font-mono text-[9px] tracking-widest" style={{ color: st.color, borderColor: `${st.color}55`, background: `${st.color}10` }}>
            {st.label}
          </span>
          <span className="font-mono text-[11px] text-mist">{p.id} · {timeLabel(p.slot)} CT</span>
          {p.format && <span className="font-mono text-[10px] text-fog">· {p.format}</span>}
        </div>
        {p.theme && <p className="text-[15px] font-medium text-white">{p.theme}</p>}

        <div className="flex flex-wrap gap-2">
          {p.status === "pending" && (
            <>
              <button
                disabled={busy !== null}
                onClick={() => act(k("approve"), { action: "approve" , id: p.id }, `${p.id} approved${slotPassed ? " and moved to the next open slot" : ""}.`)}
                className="rounded-lg px-4 py-2 font-mono text-[11px] font-medium tracking-widest text-void disabled:opacity-50"
                style={{ background: COLOR }}
              >
                {busy === k("approve") ? "APPROVING…" : "APPROVE"}
              </button>
              <button disabled={busy !== null} onClick={() => act(k("skip"), { action: "skip", id: p.id }, `${p.id} skipped.`)} className={btn}>SKIP</button>
            </>
          )}
          {p.status === "scheduled" && (
            <>
              {posterReady && (
                <button disabled={busy !== null} onClick={() => act(k("push"), { action: "push", id: p.id }, `Posting ${p.id} now on @${handle}.`)} className={btn} style={{ color: MINT }}>
                  {busy === k("push") ? "…" : "POST NOW"}
                </button>
              )}
              <button disabled={busy !== null} onClick={() => act(k("hold"), { action: "hold", id: p.id }, `${p.id} held. It won't go out until you release it.`)} className={btn}>HOLD</button>
            </>
          )}
          {p.status === "held" && (
            <>
              <button disabled={busy !== null} onClick={() => act(k("release"), { action: "release", id: p.id }, `${p.id} released. Drafts go back to review; approved posts go back on schedule.`)} className={btn} style={{ color: MINT }}>RELEASE</button>
              <button disabled={busy !== null} onClick={() => act(k("skip"), { action: "skip", id: p.id }, `${p.id} skipped.`)} className={btn}>SKIP</button>
            </>
          )}
          {(p.status === "failed" || p.status === "skipped") && (
            <button disabled={busy !== null} onClick={() => act(k("restore"), { action: "restore", id: p.id }, `${p.id} is back in review.`)} className={btn}>RESTORE TO REVIEW</button>
          )}
          {p.status === "posted" && p.url && (
            <a href={p.url} target="_blank" rel="noreferrer" className={btn} style={{ color: ICE }}>VIEW ON X ↗</a>
          )}
        </div>
        {p.status === "pending" && slotPassed && (
          <p className="text-[12px]" style={{ color: COLOR }}>Its slot passed while it waited. Approving moves it to the next open slot.</p>
        )}
        {p.lastError && p.status !== "posted" && (
          <p className="text-[12px] leading-relaxed" style={{ color: CORAL }}>Last attempt: {p.lastError}</p>
        )}

        {p.flag && (
          <div className="rounded-xl p-3.5" style={{ background: `${COLOR}0d`, border: `1px solid ${COLOR}30` }}>
            <p className="mb-1 font-mono text-[10px] tracking-widest" style={{ color: COLOR }}>BEFORE YOU APPROVE</p>
            <p className="text-[12.5px] leading-relaxed text-mist">{p.flag}</p>
          </div>
        )}
        <div className="rounded-xl p-3.5" style={{ background: `${MINT}0a`, border: `1px solid ${MINT}26` }}>
          <p className="mb-1 font-mono text-[10px] tracking-widest" style={{ color: MINT }}>PROOF</p>
          <p className="break-words text-[12.5px] leading-relaxed text-mist">{p.proof}</p>
        </div>
        {p.why?.length > 0 && (
          <div>
            <p className="mb-1 font-mono text-[10px] tracking-widest text-fog">WHY IT SHOULD TRAVEL</p>
            <ul className="list-disc space-y-1 pl-4 text-[12.5px] leading-relaxed text-fog">
              {p.why.map((w) => <li key={w}>{w}</li>)}
            </ul>
          </div>
        )}
        <p className="font-mono text-[10px] text-fog/70">
          {p.aiMedia ? "AI-generated media · disclosed in the text · " : ""}
          from {p.createdBy}
        </p>
      </div>
    </article>
  );
}
