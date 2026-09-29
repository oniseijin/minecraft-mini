# Changelog

All notable changes to minecraft-mini are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions follow the 0.x line while the game finds its shape.

## [Unreleased]

## [0.4.0] — 2026-09-29

### Added
- **In-game player guide** — "How to play" on the title/pause menu opens a panel covering every mode in player language: how mystery boxes work (walk in, slots 1–3, final-2s lock), color bombs, the zapper, bridging in BedWars, and "punch = left-click" for zombies (with the hit-and-back-off tip). Source copy: `docs/PLAYER-GUIDE.md` (update both together). Esc/✕/click-outside closes.
- `CONTRIBUTING.md` — the workflow guide: change process, Definition of Done, live-server safety rules, kid-first design principles, protocol discipline, AI-agent collaboration notes.
- **`tools/check-protocol.ts`** (refactoring 1c) — protocol differential test: feeds a 205-frame corpus (valid/malformed/absent-field variants across all 15 C→S, 10 S→C, and 22 gameEvent kinds) through the parsers at a pinned git ref and the working tree, failing on any behavioral difference — the safety net for the planned table-driven parser rewrite. Pins the documented tolerance quirks (absent-bomb→null, absent-dayT→omitted, killerId coercion) and surfaced 8 more — including the draw-path bug fixed below.
- **`tools/lib.mjs` smoke harness** (refactoring 1b, rounds 1+2) — the ~130 lines of server-spawn/browser-launch/assert boilerplate every spawn-built smoke suite carries now live in one lib (`startServer`/`stopServer` handles, `withServer`, `openPage`, `createChecks`, `teardown`, port precheck, boot-failure orphan fix, `resetEdits` for mid-suite-restart persistence). The flaky relay windows are named constants (`MOVE_RELAY_MS`/`RESPAWN_RELAY_MS`/`ATTACK_SPACING_MS`). All seven spawn-built suites adopted: **−672 lines net** with every check name, output line, port default, and exit-code behavior preserved (per-suite check-line diffs verified). `smoke.mjs`/`smoke-physics`/`smoke-solo` (dev-server topology) intentionally untouched.
- DESIGN.md §2.1 "Runtime topology & ports" — the built-client vs Vite-workbench distinction and the full port map (prod 6881 · dev 6891 · workbench 5173 · smokes 809x); AGENTS.md gained a documentation map; README links the contributing guide.

### Fixed
- **Melee swings follow the current aim**: `attackTarget` derived its ray from the camera quaternion, which lags `player.look()` by one rendered frame — a look-then-swing pair swung along the *pre-flick* aim. The ray now comes from the player's authoritative yaw/pitch (the same fix the Color Zapper path already had). This also de-flaked smoke-mobs' giraffe-punch check: root-caused via a frame-delayed control punch (same aim, one frame later → hit; synchronous → miss), then proven with 8 consecutive full-suite passes at a prior ~50% failure rate.
- **Block Party draw results reach clients again**: the parser rejected `roundResult.survivorId: null` — the exact value `party.ts` sends on every draw (`survivor?.id ?? null`, and the declared type has always allowed it) — so draw rounds silently vanished and players never saw the "Draw — replay!" banner. Explicit null now parses; absent/garbage values still reject (stricter than `death.killerId`'s coerce-to-null, deliberately — the win banner keys off `survivorId`). No wire-format change (no `PROTOCOL_VERSION` bump); the differential test's corpus pins updated together with the parser, and the interim run confirmed the change's blast radius is exactly the draw case.
- **Server tick crash guard** (refactoring 0a, `docs/REFACTORING.md`): every interval callback (roster snapshot, match/bot/mob ticks, heartbeat, world-save) is wrapped in a log-and-continue guard, so a single throw no longer kills the process — no more player drops + lost edits from one bad tick.

### Changed
- **Protocol string unions derived from const arrays** (refactoring 0c): `MobKind`, `PartyItemId`, `PartyPhase`, `ShopItemId`, and `SwordTier` are now `typeof TUPLE[number]` derivations sitting next to their parse-side `as const` tuples (GAME_MODES and PARTY_EFFECT_KINDS likewise) — the array/type re-declaration drift class is dead. The shop catalog's `id: ShopItemId` and `SWORD_DAMAGE: Record<SwordTier, …>` now enforce tuple↔catalog agreement at compile time. Parse behavior unchanged (proven by the new differential test).
- **`shared/src/simulation.ts`** (refactoring 1a) — the 13 cross-boundary simulation constants now have one home: gravity, jump speeds, eye height, void planes, party effect magnitudes/duration, and combat ranges/cooldowns. Identical values single-source (the effect-ms trio lived in three files, one commented "must match the server"); deliberate client/server differences became named pairs with the rationale in the name and comment (`ATTACK_REACH_CLIENT` 3.5 / `ATTACK_RANGE_SERVER` 4.5, `EDIT_REACH_CLIENT` 5 / `EDIT_REACH_SERVER` 8, `JUMP_SPEED_PLAYER` 9 / `JUMP_SPEED_ENTITY` 8.4). Zero value changes — smoke-physics (±0.01), smoke-bot, and smoke-party all green.
- **Client wiring split** (refactoring 2a, five commits): `main.ts` 1,936 → 1,425 lines across five focused modules — `devHooks.ts` (the `__mc` test surface, byte-identical), `hud/menu.ts` + `hud/playerList.ts` (menu/HUD/player-list DOM wiring; `refreshBwButtons` honestly renamed `refreshMatchControls`), `matchHud.ts` (the mode-shared banner/killfeed/results HUD; `setPartyFeed` → `setFeedOnly`; party no longer routes shared HUD through `bwUi`), `matchEvents/{bw,party,sandbox}.ts` (per-mode gameEvent handler tables; the zombie `shoved` event home in sandbox), and `modes.ts` (the shared match-enter world-swap/park-and-build skeleton + the `modeChanged` dispatch table). Every smoke suite green at each step.
- **Server split** (refactoring 2b, four commits): `bedwars.ts` holds the BedWars engine as stateless `(ctx, match, …)` functions (match.ts 861 → 347-line mode registry); `matchLifecycle.ts` single-sources the six cross-mode duplicate shapes (roster pick, ready gate, leave-with-win-by-default, everyone-left, modeChanged fan-out, edit-reject echo); one `ServerContext` replaces the three match deps shapes; index.ts's C→S switch became a typed handler table. Adding a third mini-game is now "new module + one registry arm + one handler row".
- **Table-driven protocol parsers** (refactoring 2c): `decode`/`arrayOf`/`oneOf`/`asVec3` replace the extract→null-check boilerplate (protocol.ts 1,220 → 1,012); the documented tolerance quirks stay hand-written with pinned assertions. **Proven behavior-identical by the differential test** (205 frames, 91 pins, old == new).
- **Shared server locomotion** (refactoring 2d): `locomotion.ts` owns the walker primitives the test bot and mobs each carried near-copies of (step/hop/snap/wall-refuse + ballistic vertical + turn-and-move), with per-caller policy as options — including `checkRiseWhileAirborne`, which preserves a genuine behavioral difference between the two callers bit-exactly. bot.ts −80 lines, mobs.ts −60.

### Removed
- **Dead-code sweep** (refactoring 0b, −34 lines net): unused `BED_BLUE`/`BED_RED` client imports, main.ts's duplicated `chatOpen` mirror (now reads the chat module's `isOpen`), orphaned `bw-team-0/1` DOM ids, six dead `shared/` exports (`isShopItemId`, `shopItem`, `partyCellOf`, `isPartyFloorCell`, `partyCellCenter`, `partyColorOf`), and the per-zombie `broadcastSnapshot` in `burnZombies` (now one broadcast per dawn purge).

## [0.3.4] — 2026-09-28

### Changed
- **Dev/prod port split**: the dev server default moved to **6891** (from the 6881 it briefly shared with prod) — the launchd production service pins 6881 in its plist, so the two never collide; `MC_DEV_PORT` overrides the dev server and the Vite ws proxy together. Docs, the dev-all comment, and the smoke default-port check updated to match.

## [0.3.3] — 2026-09-28

### Fixed
- Release-symlink flip: `mv` into a symlinked directory moved the temp link *inside* the old release on macOS — `ln -sfn` replaces the symlink itself (deploy + rollback). Upgrade path now stops the previous service *before* the port-conflict check, so self-upgrades don't trip it.

## [0.3.2] — 2026-09-28

### Fixed
- `scripts/deploy.mjs` first-run bugs: `realpathSync` imported from `fs` (not `path` — broke the post-deploy prune and `--status`), and the expected launchd "not loaded" bootout noise silenced.

## [0.3.1] — 2026-09-28 — "Always On"

### Added
- **Production deployment** (`scripts/deploy.mjs`): deploy any git tag as an always-on macOS launchd service — releases under `~/.local/opt/minecraft-mini/releases/<tag>` with an atomic `current` symlink (3 kept, instant `--rollback`), the world persisted at `~/.local/share/minecraft-mini/` with per-deploy backups and a save-format version gate (unknown future formats abort rather than corrupt — the migration hook), first-deploy adoption of the dev repo's world, crash-restart via KeepAlive, logs under `~/Library/Logs/minecraft-mini/`, plus `--status/--stop/--start/--restart/--uninstall`. The service owns port 6881; dev sessions take `PORT=` overrides while it runs.

## [0.3.0] — 2026-09-28 — "Nightfall"

Mobs phase 2 plus the world's tallest resident.

### Added
- **Night zombies** — after dark, up to two zombies stalk the island (spawning 16–32 blocks out, walking *toward* you): they chase, groan when close, and shove players with knockback — scary but harmless, the sandbox has no player damage. Punching one staggers it (it never flees); dawn burns them away. The server and every client now share one day-night clock, so the sky you see is the night they spawn by.
- **Giraffe** — hand-built (no asset pack ships one): long legs, swaying neck, ossicones, grazing idles. One or two wander the island; slow, stately, 14 HP, panics when punched.
- Server default port moved **8080 → 6881** (`PORT` still overrides). Update your bookmarks.

### Engineering
- Protocol v8 (new mob kinds, `dayT` in mob snapshots, `shoved` event); smoke-mobs now covers day population, giraffe punch-panic, night chase/shove/kill, dawn burn, and the default-port boot.

## [0.2.0] — 2026-09-28 — "Party & Wildlife"

The Block Party expansion plus the first mobs, all research-backed against the real Hive mechanics.

### Added
- **Color bombs (Block Party)** — the real Hive mechanic: from round 2, a bomb spawns on a non-safe color about a second into the countdown, pulses with accelerating beeps for 2 seconds, then paints a 3×3 patch of the safe color that survives the floor drop. Racing to camp the patch is the intended strategy. (`PARTY_BOMB_RATE` tunable.)
- **Mystery Boxes & power-ups (Block Party)** — spinning boxes spawn each round; walk into one for a random item (hold up to 3): **Leap** (dash), **Speed** (5 s ×1.4), **Jump Boost** (5 s, 2.6-block jumps), **Swapper** (trade places with your opponent), **Color Teleporter** (warp onto the safe color — capped at one held, locked in the final 2 seconds, refused mid-fall). The trailing player's boxes spawn nearer them (catch-up bias).
- **Spectator Color Zapper (Block Party)** — falling now arms one revenge shot: aim and click to destroy a single surviving floor tile before the round scores. Turns "I lost this round" into "draw, replay" if it connects.
- **Sandbox animals** — three foxes and three boars wander the island (idle-heavy, hop ledges, avoid deep water); punching one triggers a 5-second panic flee. Foxes take 3 punches, boars 5; death poofs and respawns elsewhere. They pause during mini-game matches.

### Fixed
- **BedWars soft-lock** (the cause of the playtest "rematch doesn't work" report): breaking a player's bed while they were dead awaiting respawn left the match unable to end — no results screen, no rematch. The dead player is now eliminated the moment their bed breaks, ending the match cleanly.
- Freshly connected clients could miss the initial player roster; returning from a match could despawn nearby animals (stale position check — now a 3 s grace applies).
- Test infrastructure now builds to an isolated `client/dist-test` on separate ports, so automated testing can never interfere with a live session (RIP the phantom "MuddyWaffle34" incident).

## [0.1.0] — 2026-09-27 — "Dry Run"

First playable build, built in one day with AI subagents and playtested over LAN by the family (2 humans: "basically functional" ✅).

### The game
- **Sandbox open world** — a 256×64×256 voxel island (deterministic seed), face-culled chunk meshing with baked ambient occlusion, Kenney CC0 textures; walk / jump / sprint (Shift/Ctrl/double-W) / creative flight (double-Space or F); break & place 9 block types; day-night cycle; procedural WebAudio sound effects; the world persists on the host across server restarts.
- **LAN multiplayer** — one machine hosts (`npm run lan`), everyone else opens a URL; no install. Live avatars with animated limbs and colored nameplates, 20 Hz movement sync, shared block edits, chat (Enter/T, keeps input open, scrollable history), join/leave announcements, hold-Tab player list, AFK dimming.
- **BedWars 1v1** (Hive-style) — two floating islands + mid over the void, beds = respawns, iron/gold/emerald generators, shop (wool, swords, apples), melee with knockback, sudden death at 10:00, victory screen + rematch.
- **Block Party 1v1** (Hive-style) — 25×25 tinted-wool floor over the void, announced color with shrinking timer (4.5 s → 0.75 s), wrong color = fall, first-to-3 round wins, spectator fly while waiting.
- **Solo support** — solo practice for both mini-games, plus **Bot Steve** (menu-spawned test bot: wanders the sandbox, fights back in BedWars, stands on colors in Block Party) so one person can test all 2-player features.

### Feel & UX
- Click-to-play → Esc pause menu: name, flying toggle, sound, mouse-speed −/+, controls list; mode badge always shows where you are; menu explains solo vs duel state.
- Mouse sensitivity defaults tuned from playtest feedback (0.0045 rad/px), adjustable with `[` / `]` and remembered per browser.
- Offline fallback: no server → solo world with background reconnect.

### Engineering
- npm-workspaces monorepo (`shared/` `server/` `client/`), TypeScript strict end-to-end, custom voxel engine on three.js, authoritative Node + ws server (protocol v4), deterministic worldgen so only a block-edit overlay is ever synced.
- Headless test suite (Playwright + Chrome): boot, 23 physics checks, 2-client network sync, full BedWars match (15 checks), full Block Party match (17 checks), solo-menu flows, bot match (20 checks).

### Known issues at 0.1.0
- **Rematch**: both players pressing Rematch after a match does not reliably start the next match (fix + regression test in flight for 0.2.0).
- No bow in BedWars yet; damage feedback is hit-sounds/kill-feed only (no numbers).

### Next up (designed in docs/DESIGN.md)
- Night zombies (mobs phase 2), BedWars bow, damage numbers, further playtest polish.

[0.1.0]: local tag v0.1.0
