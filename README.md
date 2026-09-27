# Minecraft Mini

A tiny browser-based voxel sandbox for 2 players on LAN — Vite + TypeScript + three.js client, Node + Express + `ws` server. One player hosts; everyone else just opens a URL.

## 2-player LAN quickstart

On the **host machine** (the one whose screen everyone gathers around):

```sh
npm install
npm run build     # bundles the client into client/dist
npm run lan       # starts the game server and prints join URLs
```

The server prints something like:

```
[server] minecraft-mini LAN server
[server]   local  http://localhost:8080
[server]   LAN    http://192.168.1.23:8080
```

Everyone else on the same Wi-Fi opens the printed **LAN** URL in a browser — no install, no build. Type a name on the title screen, click to play, and you'll see each other walk, build and chat live. The world (terrain + every block edit) persists on the host across restarts (`server/data/world-edits.json`).

If the server isn't reachable, the game falls back to **offline mode**: solo play on a local world while it keeps retrying in the background every 15 s.

## Development

```sh
npm run dev:all   # game server (:8080) + Vite dev client (:5173) in one terminal
```

or separately:

```sh
npm run dev        # client (Vite dev server) at http://localhost:5173
npm run dev:server # game server at http://localhost:8080 (dev clients reach it through the /ws proxy)
```

Controls (click the page to grab the mouse):

| Input | Action |
| --- | --- |
| `W A S D` | move |
| Mouse | look around |
| Left click | break block |
| Right click | place block |
| `Space` | jump |
| `Space` ×2 or `F` | toggle creative fly |
| `Space` / `Shift` (flying) | ascend / descend |
| `Shift` or `Ctrl` or `W` ×2 | sprint |
| `1`–`9`, mouse wheel | select hotbar slot |
| Click a hotbar slot | select block (while on the title/pause screen) |
| `Enter` or `T` | open chat · `Enter` sends and keeps chat open · `Esc` closes |
| `Esc` | pause menu (name, fly toggle, sound, mouse speed) |
| `[` / `]` | mouse sensitivity − / + |
| `M` | mute / unmute |

The pause menu ("Esc") also shows the player **name** used in the roster and chat (stored in `localStorage`, random fun default).

## Games (need exactly 2 players online)

Both match modes are started from the pause/title menu ("Esc") and need **exactly 2 players online** — the buttons stay disabled otherwise. Match worlds are separate from the sandbox; saved sandbox builds are never touched, and either player can bring everyone back with **Back to sandbox**.

## BedWars 1v1 (M4)

With **exactly 2 players online**, the title/pause menu shows **Play BedWars 1v1**. Both players swap from the sandbox into a generated floating-islands arena (separate world — the sandbox and its saved edits are untouched):

- Two team islands (red west, blue east), each with a bed, a spawn and a **shop pad** (planks + glass marker). A mid island holds the emerald generator. Bridges stop short of mid — bridge the last gap yourself.
- **Generators** (server-side): your island earns 1 iron / 1.5 s and 1 gold / 4 s; standing within 3 blocks of the mid generator earns 1 emerald / 6 s.
- **Combat**: left-click swings at the player you're aiming at (server validates range/cooldown/damage: fist 2, wooden 4, stone 6, iron 8). 20 HP, regen 1 / 2.5 s after 5 s out of combat. Falling into the void (below y = 8) kills.
- **Beds** = respawns: break the ENEMY bed (hit it like a block) to stop their respawns; final kill wins. Your own bed is protected. At 10:00 both beds auto-break (sudden death).
- **Shop** (`B` while on your island's planks pad): wool ×16 / planks ×16 (4 iron), wooden sword (10 iron), stone sword (7 gold), iron sword (4 emerald), golden apple (3 gold — right-click to eat, heals 8). Hotbar slots 1–4 hold what you bought; 1–2 place bridge blocks.
- Match end → results screen → **Rematch** (both players ready up) or **Back to sandbox** (either player). Disconnecting mid-match means the other player wins.

| Extra input (in a match) | Action |
| --- | --- |
| `B` (near your shop pad) | open/close the shop |
| `1`–`4`, mouse wheel | select hotbar item |
| Left click | attack / break blocks (enemy bed included) |
| Right click | place wool/planks · eat golden apple when it's selected |

## Block Party 1v1 (M5)

**Play Block Party 1v1** (same menu, same 2-player gate): a Hive-style dance floor over the void — when the announced color's tiles vanish, standing on the wrong color means falling, and the survivor takes the round; **first to 3 round wins** takes the match.

- A fresh random 25×25 wool mosaic (8 colors) is dealt every round; both players re-center on the floor between rounds.
- Each round the server announces a color (big swatch + color name + a shrinking countdown bar, with a dedicated HUD slot showing the color block). The countdown shrinks every round — 4.5 s down to a 0.75 s floor.
- At 0 the floor drops except the announced color: ~1.5 s of standing (or falling) decides the round. Survivor scores; both or neither falling is a draw and the round replays.
- If you fall, you're not out: you free-fly (creative fly unlocks automatically) from the cobble platform beside the floor and watch the rest of the round.
- Draws replay; disconnecting mid-match means the other player wins. Rematch / Back to sandbox work exactly like BedWars.

| Extra input (in a match) | Action |
| --- | --- |
| mouse move + `W A S D` | run to the announced color |
| `Shift` (when eliminated) | fly while spectating |
| Building/breaking | disabled — the floor is server-owned |

## Other scripts

| Command | What it does |
| --- | --- |
| `npm run build` | Build the client into `client/dist` |
| `npm start` | Serve the built client + game server at http://localhost:8080 |
| `npm run lan` | Same as `npm start` — prints LAN join URLs |
| `npm run typecheck` | Typecheck shared, server, and client |
| `node tools/smoke.mjs` | Headless boot/interaction smoke (vs `:5173`, no server needed) |
| `node tools/smoke-physics.mjs` | Headless physics + menu smoke (vs `:5173`, no server needed) |
| `node tools/smoke-net.mjs` | Two-client LAN integration test (builds + boots its own server on `:8080`) |
| `node tools/smoke-bedwars.mjs` | Two-client full BedWars match test (builds + boots its own server on `:8080`) |
| `node tools/smoke-party.mjs` | Two-client full Block Party match test (builds + boots its own server on `:8080`) |

Environment: `PORT` (default 8080), `MC_EDITS_FILE` (override the edits save file, used by tests).
