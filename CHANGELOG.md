# Changelog

All notable changes to minecraft-mini are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions follow the 0.x line while the game finds its shape.

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

### In flight for 0.2.0 (designed in docs/DESIGN.md)
- Color bombs (authentic Hive auto-bomb), rematch fix, isolated test builds.
- Mystery Boxes & power-ups (Leap / Speed / Jump Boost / Swapper / Color Teleporter + spectator Color Zapper).
- Sandbox animals: foxes and boars (phase 1 of mobs).

[0.1.0]: local tag v0.1.0
