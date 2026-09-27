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
| `Ctrl` or `W` ×2 | sprint |
| `1`–`9`, mouse wheel | select hotbar slot |
| Click a hotbar slot | select block (while on the title/pause screen) |
| `Enter` or `T` | open chat · `Enter` sends · `Esc` cancels |
| `Esc` | pause menu (name, fly toggle, sound, mouse speed) |
| `[` / `]` | mouse sensitivity − / + |
| `M` | mute / unmute |

The pause menu ("Esc") also shows the player **name** used in the roster and chat (stored in `localStorage`, random fun default).

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

Environment: `PORT` (default 8080), `MC_EDITS_FILE` (override the edits save file, used by tests).
