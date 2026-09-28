# Refactoring plan — from the three-part code review (2026-09-28)

Reviews: client `main.ts` · server `shared/`+modules+tools. Verdicts agreed: the codebase is **healthy — the debt is concentration, not entanglement**. Everything below is behavior-neutral, smoke-guarded, and each step is independently revertible (one commit per step). One **operational fix** (Phase 0a) is bug-grade and should land regardless.

## Phase 0 — Safety & hygiene (do first, ~half a day, near-zero risk)

- **0a. Tick crash guard** (server): wrap `partyTick` / `mobs.tick` / `stepMob` interval callbacks in try/catch+log — today a single throw kills the process (launchd restarts, but players drop and ≤5 s of edits are lost). `index.ts:512,520,525,533`. Guard: smoke-net.
- **0b. Dead-code sweep**: unused imports (`BED_BLUE/BED_RED`), dead exports (`shop.isShopItemId`, `partyArena.partyCellOf` etc. — adopt-or-delete), duplicated `chatOpen` state, stale `flyControls` comment, orphaned `bw-team-0/1` DOM ids, per-zombie broadcast in `burnZombies` (hoist).
- **0c. Derive string unions** (`protocol.ts`): `MOB_KINDS`, `SHOP_ITEM_IDS`, `GAME_MODES`, `PARTY_*` as `const X = [...] as const; type X = typeof X[number]` (−40 lines, kills the re-declaration drift class). Guard: typecheck + check-worldgen.

## Phase 1 — Shared foundations (~a day, low risk)

- **1a. `shared/src/simulation.ts`** — single-source the 12 cross-boundary constants (effect ms ×3, speed ×1.4 ×2, jump-boost 13 ×2, **JUMP_SPEED drift 9 vs 8.4**, gravity ×2, attack range/cooldown ×3, edit reach 5/8, eye height, void planes…) as deliberately-named pairs (`ATTACK_REACH_CLIENT=3.5` / `ATTACK_RANGE_SERVER=4.5`). Guard: smoke-physics, smoke-bot, smoke-party.
- **1b. `tools/lib.mjs` test harness** — the 7 smoke scripts share ~700 lines of byte-identical server-spawn/browser-launch/check boilerplate. Lib: `launch()`, `withServer()`, `openPage()`, `check`; per-script ports/env/scenarios stay bespoke. Adopt one script at a time (smoke-bot first). Centralize the flaky edit-propagation window as a named constant. (−~500 lines.)
- **1c. Protocol differential test** (`tools/check-protocol.ts`): feed valid/malformed/absent-field frames through old and new parsers — the safety net for Phase 2c.

## Phase 2 — Structural extraction (the big wins, ~2–3 days total, sequenced by risk)

- **2a. Client wiring split** (from main.ts review, order matters):
  1. `devHooks.ts` — the `__mc` hook moves verbatim (pure move; every smoke asserts through it).
  2. `hud/menu.ts` + `hud/playerList.ts` — ~350 lines of DOM wiring; rename the lie `refreshBwButtons`.
  3. `matchHud.ts` — banner/killfeed/results out of `bedwarsUi` (party calls it `bwUi` 15× — the most confusing name in the client).
  4. `matchEvents/{bw,party,sandbox}.ts` — the ~480-line message/gameEvent switch behind a per-mode handler table (`shoved` moves to its sandbox home).
  5. `modes.ts` — one `MatchLifecycle` for enter/exit/world-swap (enterBedwars/enterParty are ~15 lines identical); collapses the modeChanged if/else.
  → **main.ts: 1,933 → ~600 lines.**
- **2b. Server split**: `bedwars.ts` extracted from `match.ts` (which is mode manager + bedwars engine + party glue — becomes a ~250-line mode registry); shared `matchLifecycle.ts` for the bedwars↔party duplicates (roster pick ×2, ready-gate ×2, win-by-default/all-left reset ×4, modeChanged fan-out ×3, reject-echo ×3); one `ServerContext` instead of three deps shapes; handler table for index.ts's 19-arm switch. Adding a third mini-game becomes "new module + one dispatch arm".
- **2c. Table-driven protocol parsers** (~690 lines of extract→null-check boilerplate → ~200): `field()`/`opt()`/`decode()` spec tables, behind the 1c differential test. Must reproduce the documented optional-field tolerance quirks (absent-bomb→null, absent-dayT→undefined, killerId coercion).
- **2d. `server/locomotion.ts`** — bot.ts/mobs.ts share near-identical `stepTowards`/`integrateVertical`/`groundY`/wander-picking; one options-driven module (`{allowDrops, refuseDeepWater, yawRate}`). Any future server entity reuses it.

## Phase 3 — Client dedup (opportunistic, each tiny)

- `interp.ts` — remotePlayer/mobs share shortestArc + sample buffer + walk swing (~80 lines).
- Merge `bwState`/`partyState` mirrors (ring buffer, accessors, reset shape; −90).
- Shared `el()` DOM helper; hotbar/bwHotbar slot rendering; table-driven audio jingles.
- Input consolidation (scattered keydown×2/mouse/wheel listeners → one `input.ts`) + `uiLock.ts` pointer-lock helper (the pattern repeats 9× in main.ts).

## Explicitly NOT refactoring (load-bearing)

player.ts collision core (smoke-physics asserts ±0.01) · mesher AO/quad-flip + worldgen integer-hash determinism (bit-identical requirement) · net.ts reconnect/backoff · combat.ts slab vs raycast DDA (different algorithms, not duplication) · partyRand determinism scheme · fightersSettled fair-start · persistence layer (already solid: tmp+rename, validated load, dirty-retry) · `__mc` surface shape · deploy.mjs.

## Progress log (2026-09-28/29 session)

- **Phase 0 done** — 0a `d1d11c5` (safeTick guards, all six intervals) · 0b `99aeb1a` (dead-code sweep, six dead shared exports) · 0c `a921e84` (all string unions derived from `as const` tuples, incl. ShopItemId/SwordTier homed in shop.ts — the drift class is dead).
- **Phase 1 done** — 1a `61c133a` (shared/src/simulation.ts, 13 constants, pairs named; zero value changes) · 1b `1484fdb`+`45386f7` (tools/lib.mjs harness; all 7 spawn-built suites adopted, −672 lines; resetEdits/combined-wait/describeFailure added) · 1c `7bfd2d7` (tools/check-protocol.ts, 205-frame differential — also surfaced the roundResult-draw parser bug, flagged for a maintainer call).
- **Phase 2a done** — 2a.1 `62b00f9` (devHooks.ts, `__mc` verbatim behind installDevHooks) · 2a.2 `c586826` (hud/menu.ts + hud/playerList.ts, refreshBwButtons → refreshMatchControls) · 2a.3 `f0ff8e5` (matchHud.ts; setPartyFeed → setFeedOnly; party no longer reads shared HUD through bwUi) · 2a.4 `c0e9fae` (matchEvents/{bw,party,sandbox,table}.ts — per-mode handler tables, shoved at home in sandbox) · 2a.5 `4dc01fb` (modes.ts swapToMatchWorld/parkForBuild + modeEnters dispatch). main.ts 1,936 → 1,425 — short of the ~600 estimate: the remainder is boot/frame-loop/input/interaction, none of which the sub-steps targeted. Honest number, not a regression.
- **Phase 2b done** — 2b.1 `1953a9a` (bedwars.ts: the BedWars engine as stateless (ctx, match, …) functions in party.ts's style; match.ts 861→~350, the mode registry) · 2b.2 `8929151` (matchLifecycle.ts: pickRoster/recordReady/leaveMidMatch/everyoneLeft/announceMode/rejectEdit — the six cross-mode duplicate shapes, partyReady+bedwarsReady deleted) · 2b.3 `8bbec16` (ServerContext replaces the three match deps shapes; MobDeps/BotDeps stay behavioral) · 2b.4 `3eb233f` (index.ts C→S switch → typed per-connection handler table).
- 2a.3–2b.4 were implemented directly (subagent provider outage: repeated captcha timeouts); 0a–2a.2 ran as code-helper subagents with the same verify+commit gate.
- smoke-mobs [4b] (giraffe punch) is flaky-marginal — fails ~50% depending on giraffe wander; stash-tested at committed HEAD during 2b.4 (identical failure without any working-tree change). Worth a dedicated look sometime; not a refactor regression.

## Expected outcome

~2,000+ lines removed net; main.ts → ~600; every hot extension point (new mini-game, new mob/entity, new protocol message, new smoke test) touches one module instead of 3–5; the cross-file constant drift class (JUMP_SPEED already drifted) is eliminated at the source.
