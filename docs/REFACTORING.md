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

## Expected outcome

~2,000+ lines removed net; main.ts → ~600; every hot extension point (new mini-game, new mob/entity, new protocol message, new smoke test) touches one module instead of 3–5; the cross-file constant drift class (JUMP_SPEED already drifted) is eliminated at the source.
