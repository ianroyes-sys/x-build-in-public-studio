# THE FEED room (Omega UI)

These three files are the room as it runs inside Omega, a private local dashboard (Next.js App
Router, Tailwind). They are published for reference and **do not build on their own**:

| File | In Omega it lives at | Needs from the Omega shell |
|---|---|---|
| `XDesk.tsx` | `components/rooms/XDesk.tsx` | Omega's Tailwind theme tokens (`card`, `seclabel`, `text-fog`, `bg-void`…) |
| `api/x/route.ts` | `app/api/x/route.ts` | `@/lib/loops` and `@/lib/server/loops` (agent runner: `ENGINE`, `runnable`, `startRun`, `answersFile`), and `scripts/x.mjs` (this repo's `bin/x.mjs`) |
| `api/x/media/[name]/route.ts` | `app/api/x/media/[name]/route.ts` | nothing beyond Next.js |

What the room does: reads `data/x/queue.json` every 60 s, shows counts (needs your tap,
approved, posted, next out), renders each post as it will read with its proof media, and
offers APPROVE / APPROVE ALL, HOLD, RELEASE, SKIP, RESTORE, STAGE (copies the text, opens X's
composer, reveals the media in Finder) and POST NOW (only when the posting agent is
installed). Every mutation shells out to `x.mjs`, so the UI, the CLI and the agents share one
gate and one lock. The API strips `RUN_ID` from its environment so the owner's tap is never
mistaken for an agent run.

To reuse it outside Omega, swap the two `@/lib` imports for your own job runner (or drop the
`push` and `draft-more` actions) and point `X` at `bin/x.mjs`.

**Status:** reference only; runs inside Omega, not standalone.
