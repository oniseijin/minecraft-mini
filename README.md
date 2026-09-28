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
[server]   local  http://localhost:6881
[server]   LAN    http://192.168.1.23:6881
```

Everyone else on the same Wi-Fi opens the printed **LAN** URL in a browser — no install, no build. Type a name on the title screen, click to play, and you'll see each other walk, build and chat live. The world (terrain + every block edit) persists on the host across restarts (`server/data/world-edits.json`).

If the server isn't reachable, the game falls back to **offline mode**: solo play on a local world while it keeps retrying in the background every 15 s.

## Production deployment (macOS, launchd)

The game server can run as an always-on user service, deployed from git tags:

```sh
node scripts/deploy.mjs v0.3.1     # deploy a tag → ~/.local/opt/minecraft-mini, (re)start service
node scripts/deploy.mjs --status   # live release, service state, health
node scripts/deploy.mjs --stop     # stop the service (world untouched)
node scripts/deploy.mjs --start
node scripts/deploy.mjs --restart
node scripts/deploy.mjs --rollback v0.3.0   # instant flip to a kept release
node scripts/deploy.mjs --uninstall         # remove the service; data + releases kept
```

Layout: releases live under `~/.local/opt/minecraft-mini/releases/<tag>` with a `current` symlink (newest 3 kept); the **world persists at `~/.local/share/minecraft-mini/world-edits.json`** — upgrades never touch it, every deploy snapshots it into `backups/` and validates its format (an unknown future save version aborts the deploy instead of corrupting data; that check is the migration hook). Logs: `~/Library/Logs/minecraft-mini/`. The launchd agent (`local.minecraft-mini`) starts at login, restarts on crash, and saves the world on SIGTERM. The first deploy adopts the dev repo's `server/data/world-edits.json` if you have one.

Note: the service owns port **6881**. While it runs, dev sessions need another port (`PORT=7000 npm run lan`). `npm run deploy` and `npm run deploy:status` are shortcuts.

## Development

```sh
npm run dev:all   # game server (:6881) + Vite dev client (:5173) in one terminal
```

or separately:

```sh
npm run dev        # client (Vite dev server) at http://localhost:5173
npm run dev:server # game server at http://localhost:6881 (dev clients reach it through the /ws proxy)
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
| `Tab` (hold) | player list (names, bot tag, mode info) |
| `Esc` | pause menu (name, fly toggle, sound, mouse speed) |
| `[` / `]` | mouse sensitivity − / + |
| `M` | mute / unmute |

The pause menu ("Esc") also shows the player **name** used in the roster and chat (stored in `localStorage`, random fun default).

## Testing solo

You can exercise every 2-player feature by yourself — three ways, all from the pause/title menu ("Esc"):

1. **Second tab** — open the game twice on the same machine (or another device): two humans online means a real 1v1 with real opponents.
2. **Solo practice** — start BedWars or Block Party with only yourself online: the match world loads and the round loop runs, but there is no opponent.
3. **Test bot** — click **Add test bot** (pause menu, next to the game buttons): the server spawns *Bot Steve*, a server-driven dummy player who counts as a real roster player — starting a match with 1 human + bot is a **real 1v1**, not practice. He wanders the sandbox (stays on the island, hops ledges, swims back if he lands in water), defends his BedWars island and fights back with fists (he can die; his bed is breakable, and the winner is decided the real way), and stands on a floor cell each Block Party round — wrong color at the drop and he falls like anyone else. **Remove bot** takes him out again; mid-match that counts as a normal disconnect, so the remaining human wins by default. Bots never chat, never build, and are never saved with the world.

## Games

## Sandbox wildlife

The open world is alive: **foxes, boars and giraffes** wander the island (giraffes are hand-built — no asset pack ships one). Punch an animal and it panics and flees; it poofs away when defeated and respawns elsewhere. After sunset **zombies** stalk the island (max 2): they chase, groan and *shove* you around — scary but harmless, the sandbox has no player damage. They burn away at dawn. Wildlife pauses during BedWars/Block Party matches.

Env knobs (host): `MC_MOB_CAP` (passive population, default 8), `MC_ZOMBIE_CAP` (2), `MC_MOB_RESPAWN_MS`, `MC_DAY_T` (pin time of day 0–1), `MC_MOB_FORCE_NIGHT` / `MC_MOB_FORCE_DAY` (tests/demos).

Both match modes are started from the pause/title menu ("Esc"). With **2 participants online** (two humans, or human + test bot) it is a real 1v1; with 1 it is solo practice. Match worlds are separate from the sandbox; saved sandbox builds are never touched, and **Leave match · back to Sandbox** brings everyone back at any time.

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
- **Auto color bombs**: in ~40% of rounds from round 2 on, a fused bomb appears on a wrong-color tile ~1 s into the countdown (pulsing dark sphere + colored sparks + accelerating beeps). After a 2 s fuse it detonates and paints its 3×3 patch into the announced color — a shared safe island for whoever gets there. The server owns the fuse; there is nothing to pick up or plant. (`PARTY_BOMB_RATE` env tunes the frequency; the test bot ignores bombs.)
- **Mystery boxes**: from round 2 on, most rounds spawn 1–2 spinning boxes on the floor ~0.5 s into the countdown — walk into one to open it. Inside is one of five items (Leap 25%, Speed 25%, Jump Boost 20%, Swapper 15%, Color Teleporter 15%), shown in **3 held-item slots** at the top-left of the party HUD; use them with `1`/`2`/`3`. The trailing player's boxes spawn nearer to them (rubber-banding). You can hold **3 items max** (and only 1 Teleporter); items persist between rounds and are cleared at match end. Items only work during the countdown — in the final 2 seconds they are locked.
  - **Leap** — a dash along your look direction (+8 m/s horizontal, +5 m/s up). **Speed** — ×1.4 movement for 5 s. **Jump Boost** — huge 2.6-block jumps for 5 s (hop back onto the floor after a slip!). **Swapper** — instantly trade places with your opponent (both of you get a toast). **Color Teleporter** — warp to the nearest tile of the announced color; refused while you are mid-fall.
- **Color Zapper (spectator revenge)**: when YOU fall, you get **one shot** before the round is scored — the HUD shows "Zapper ready — click a floor tile!"; aim at any surviving tile and click: a beam flashes, the tile crumbles, and everyone hears it (the telegraph is the counterplay). Turn "I lost" into "we both fell = draw". One zap per fall.
- At 0 the floor drops except the announced color: ~1.5 s of standing (or falling) decides the round. Survivor scores; both or neither falling is a draw and the round replays.
- If you fall, you're not out: you free-fly (creative fly unlocks automatically) from the cobble platform beside the floor and watch the rest of the round.
- Draws replay; disconnecting mid-match means the other player wins. Rematch / Back to sandbox work exactly like BedWars.

| Extra input (in a match) | Action |
| --- | --- |
| mouse move + `W A S D` | run to the announced color |
| `1` / `2` / `3` | use the held power-up in that slot (countdown only) |
| Left click (after you fell) | fire the Color Zapper at the aimed floor tile |
| `Shift` (when eliminated) | fly while spectating |
| Building/breaking | disabled — the floor is server-owned |

## Other scripts

| Command | What it does |
| --- | --- |
| `npm run build` | Build the client into `client/dist` (the live server's files — don't run while a LAN session is up) |
| `npm run build:test` | Build the client into `client/dist-test` (throwaway; what all tests use — never touches `client/dist`) |
| `npm start` | Serve the built client + game server at http://localhost:6881 |
| `npm run lan` | Same as `npm start` — prints LAN join URLs |
| `npm run typecheck` | Typecheck shared, server, and client |
| `node tools/smoke.mjs` | Headless boot/interaction smoke (vs `:5173`, no server needed) |
| `node tools/smoke-physics.mjs` | Headless physics + menu smoke (vs `:5173`, no server needed) |
| `node tools/smoke-net.mjs` | Two-client LAN integration test (builds + boots its own server on `:8091`) |
| `node tools/smoke-bedwars.mjs` | Two-client full BedWars match test (builds + boots its own server on `:8092`) |
| `node tools/smoke-party.mjs` | Two-client full Block Party match test + auto-bomb round (builds + boots its own server on `:8093`) |
| `node tools/smoke-powerups.mjs` | Two-client Block Party mystery boxes / all 5 power-ups / Color Zapper test (builds + boots its own server on `:8096`) |
| `node tools/smoke-rematch.mjs` | Two-client rematch regression: full party + BedWars matches, both players press Rematch (boots its own server on `:8094`) |
| `node tools/smoke-solo.mjs` | Solo practice menu-path test (builds + boots its own server on `:8099`) |
| `node tools/smoke-bot.mjs` | Solo test-bot run: add bot → party + BedWars 1v1 vs the bot → remove (boots its own server on `:8098`) |

Environment: `PORT` (default 6881), `MC_EDITS_FILE` (override the edits save file), `MC_CLIENT_DIST` (override the served client dir — tests point it at `client/dist-test` so the live `client/dist` is never rebuilt mid-session), `PARTY_BOMB_RATE` (Block Party auto-bomb frequency, 0–1, default 0.4; `1` forces a bomb every eligible round — used by tests), `PARTY_BOX_RATE` (mystery-box round frequency, 0–1, default 0.8 ≈ 60% of rounds with 1 box + 20% with 2), `PARTY_BOX_COUNT` (force exactly 1 or 2 boxes every eligible round — tests), `PARTY_ITEM` (force the item inside every box: `leap`, `speed`, `jump`, `swapper` or `teleporter` — tests).
