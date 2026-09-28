# Changelog

All notable changes to minecraft-mini are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions follow the 0.x line while the game finds its shape.

## [0.3.2] — 2026-09-28

### Fixed
- `scripts/deploy.mjs` first-run bugs: `realpathSync` imported from `fs` (not `path` — broke the post-deploy prune and `--status`), and the expected launchd "not loaded" bootout noise silenced.

## [0.3.1] — 2026-09-28 — "Always On"

### Added
- **Production deployment** (`scripts/deploy.mjs`): deploy any git tag as an always-on macOS launchd service — releases under `~/.local/opt/minecraft-mini/releases/<tag>` with an atomic `current` symlink (3 kept, instant `--rollback`), the family world persisted at `~/.local/share/minecraft-mini/` with per-deploy backups and a save-format version gate (unknown future formats abort rather than corrupt — the migration hook), first-deploy adoption of the dev repo's world, crash-restart via KeepAlive, logs under `~/Library/Logs/minecraft-mini/`, plus `--status/--stop/--start/--restart/--uninstall`. The service owns port 6881; dev sessions take `PORT=` overrides while it runs.

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
- Test infrastructure now builds to an isolated `client/dist-test` on separate ports, so automated testing can never interfere with a live family session (RIP the phantom "MuddyWaffle34" incident).

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
- Mouse sensitivity defaults tuned from family feedback (0.0045 rad/px), adjustable with `[` / `]` and remembered per browser.
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
