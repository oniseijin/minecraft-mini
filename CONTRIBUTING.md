# Contributing to minecraft-mini

A browser voxel sandbox + Hive-style mini-games, built at my daughter's request for two players on a LAN — written with AI tools. This file is **how work happens here** — for what the game *is*, read `docs/DESIGN.md` (the source of truth); for running it, `README.md`; agent quick-facts live in `AGENTS.md`.

## Setup & the dev loop

```sh
npm install
npm run dev:all      # game server on :6891 + Vite dev client on :5173
```

Open **:6891** to play the real built game (or `npm run lan` for LAN URLs). Open **:5173** while *editing code* — that's the workbench: the same client served from source with hot reload, websocket proxied back to :6891. Full port topology: DESIGN.md §2.1. Production runs as a launchd service on **:6881** — deploy it with `npm run deploy` (git tags only).

## How a change happens

1. **Design first** — new features get a section in `docs/DESIGN.md` *before* implementation (numbers, rules, guardrails). Research-backed features (Hive mechanics) start with a research pass against the real thing.
2. **Implement** — by hand or as a milestone brief to a code-helper subagent (one milestone per brief, self-contained, referencing DESIGN sections).
3. **Verify** — see Definition of Done below. Feel changes (movement, pacing, UX) additionally need a human playtest; playtest feedback is the highest-priority bug tracker.
4. **Record** — `CHANGELOG.md` entry under `[Unreleased]`, then fold into a version at release: bump `package.json`, commit, `git tag -a v0.x.y`.
5. **Ship** — `node scripts/deploy.mjs <tag>` deploys to the launchd service. Never during a live session (check `--status` first — if players are connected, wait). Push to the GitHub origin **only on tag events** (releases) — commits accumulate locally between releases.

## Definition of Done

- `npm run typecheck` and `npm run build` clean.
- Relevant smoke suite green: `tools/smoke-*.mjs` (each takes `PORT=`; they default to isolated 809x ports and build to `client/dist-test`, never the live `client/dist`).
  - `smoke` boot · `smoke-physics` movement · `smoke-net` 2-client sync · `smoke-bedwars` / `smoke-party` / `smoke-powerups` / `smoke-rematch` full matches · `smoke-solo` menu flows · `smoke-bot` the test bot · `smoke-mobs` wildlife + night/day.
- New behavior gets a test assertion — regressions here have all been "things no test covered" (the BedWars soft-lock shipped because no test played a full rematch).
- **Flake policy**: a suite that fails once, re-run before diagnosing — parallel headless-browser runs contend for CPU; a timing-window failure that never repeats is test noise, not a game bug.

## Live-server safety rules (learned the hard way)

- **:6881 is a production server.** Never restart, redeploy, or port-probe it while `--status` shows players connected.
- **Never rebuild `client/dist` from a test** — the live server serves that directory. Tests use `npm run build:test` → `client/dist-test` + `MC_CLIENT_DIST`.
- **Never point test browsers at live ports** — a forgotten headless Chrome once haunted a live session as a phantom player ("MuddyWaffle34").
- Deploy only from **git tags**, after hours.

## Design principles (kid-first)

- The sandbox is **deathless** — zombies shove, they never damage; scary-fun over punishing.
- Guardrails beat nerfs: the Color Teleporter keeps its thrill but caps at 1 held and locks in the final 2 s.
- Kid-legible labels beat accurate ones; discoverable controls (Shift sprint, F fly) over hidden gestures.
- Catch-up is a feature: trailing Block Party players get boxes spawned nearer them.
- Numbers come from research (Hive/Hypixel mechanics), not vibes — and deviations get written down.

## Engineering conventions

- TypeScript strict everywhere; no new deps without a strong case (three.js + ws is the whole stack).
- **Protocol discipline**: bump `PROTOCOL_VERSION` on any message change; parsers stay tolerant of absent fields so old clients survive mid-upgrade LANs; policy lives server-side, shape-validation in `shared/src/protocol.ts`.
- Deterministic worldgen means the world is never sent over the wire — only the edit overlay.
- One milestone per commit, story-style message ("M5.3: sandbox animals — …").

## AI-agent collaboration notes

- Long builds go to code-helper subagents **in the background** (`run_in_background`) — foreground agents get cancelled by incoming user messages.
- Mid-run user feedback on in-flight work goes to the owning agent via **SendMessage**, not by editing its files.
- Two agents can share the tree if the brief phases them: isolated modules first, contested shared files only after the other's commit lands (poll `git log`).
- When an agent dies mid-run (e.g. quota), **`git status` before re-dispatching** — partial work is often salvageable and hours cheaper than a restart.
- The Test Bot (`#bot-add` in the menu) exists so one human can exercise every 2-player feature solo.
