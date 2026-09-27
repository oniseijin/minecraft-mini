# minecraft-mini — Design

A browser-based mini-Minecraft for 2 players on LAN: a creative sandbox open world (iteration 1) and a Hive-style BedWars 1v1 mode (iteration 2). Built to run with zero install on a **low-spec Windows laptop (integrated GPU)** and an **Apple M2 MacBook** — both players just open a URL in a browser.

This document is the source of truth for implementation. Milestone briefs reference it.

## 1. Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Stack | TypeScript, Vite + three.js (WebGL2) client; Node ≥20 + `ws` + Express server | 100% text code (best AI-agent iterability), browser runs on weak iGPUs (classic.minecraft.net precedent), zero install for players |
| Voxel engine | Custom, no library | voxel.js dead, noa-engine ~3y inactive; hand-rolled chunk engine is the proven pattern for browser clones |
| World (v1) | Finite island, 256×64×256, deterministic from seed | Simple persistence/sync; chunk-map interface keeps infinite streaming possible later |
| Networking | Server authoritative for block edits + game state; movement trusted + relayed at 20 Hz; JSON text frames + one binary frame type | At LAN RTT (<5 ms) prediction/reconciliation is wasted complexity |
| Iteration 1 mode | Creative sandbox (2P LAN, world persists) | |
| Iteration 2 mode | BedWars Duels-style 1v1 | Respawn loop = forgiving 5–10 min matches; best 1v1 fit per Hive/Hypixel research |
| Art | Kenney CC0 texture pack → texture atlas | Looks like Minecraft, no licensing issues; fallback to procedural colored atlas if download unavailable |
| Perf budget | Render distance 4 chunks (64 blocks) + fog, no shadow maps, ≤ a few hundred draw calls | Low-spec Windows target; FPS shown in debug overlay |

## 2. Repo layout

```
minecraft-mini/
├─ package.json        # npm workspaces; scripts: dev / dev:server / build / start / lan / typecheck
├─ docs/DESIGN.md      # this file
├─ shared/src/         # @mc/shared — protocol types, block registry, deterministic worldgen, math helpers
├─ server/src/         # @mc/server — ws + Express, edit-authority, persistence, mode manager
└─ client/src/         # @mc/client — Vite + three.js: renderer, meshing, physics, input, UI
```

## 3. Architecture

### 3.1 World & engine

- **Chunks**: 16×64×16 (X×Y×Z), one `Uint8Array(16384)` per chunk, world = 16×16 chunk grid → `Map<"cx,cz", Chunk>` keyed by chunk coords. Block ids from `shared/blocks.ts`.
- **Worldgen** (in `shared/worldgen.ts`, deterministic given seed): value-noise heightmap (own hash-based 2D noise, 3–4 octaves) shaped by a radial island falloff; sea level 28; sand near water, dirt under grass, stone below, bedrock at y=0; scattered trees (log + leaf blob) on grass; water fills terrain < sea level (static, no flow).
- **Sync trick**: worldgen is deterministic and shared → the server never sends the world. It tracks only an **edit overlay** (`Map<"x,y,z", blockId>` of deviations from generated terrain) and sends that to joining clients. Clients generate locally and apply overlay. (Binary world dumps never needed.)
- **Rendering**: one opaque `BufferGeometry` + one transparent `BufferGeometry` (water/leaves/glass) per chunk; face-culled meshing (emit face only if neighbor is air/transparent; leaves render against each other, water only against air); single texture atlas (`client/assets/atlas.png`, 16×16 tiles, UVs per block face from `shared/blocks.ts`); simple per-vertex ambient occlusion (vertex colors) — optional, drop if it causes trouble; fog matched to sky color at render edge; time-sliced remesh queue (~6 ms/frame budget) with dirty-neighbor remesh on edits; initial world mesh happens behind a "Building world…" loading screen (chunks meshed over frames).
- **Picking**: Amanatides–Woo voxel DDA raycast, 5-block reach, returns block + face normal; used for block highlight and break/place. Placement is rejected if it intersects the player AABB.
- **Physics**: fixed-timestep (60 Hz) axis-separated swept-AABB vs voxel grid (move X, then Y, then Z, clamp per axis). Player AABB 0.6×1.8 (eye at 1.62). Gravity ~30 m/s², jump v ≈ 9 (1.25-block jump), walk 4.3 m/s, sprint 5.6 (double-tap W or Ctrl), creative fly (double-tap Space toggles; Space/Shift up/down, fly speed 10).
- **Day-night**: sun direction/color + sky/fog color lerp on a ~10 min cycle (cosmetic only; no mobs).

### 3.2 Server & networking

- `server/src/index.ts`: Express static-serves `client/dist` (LAN play) on port 8080; `ws` server on same port. `npm run lan` prints all LAN IPv4 URLs.
- **Protocol** (`shared/protocol.ts` — discriminated-union types; JSON text frames; binary frames start with 1 type byte):

```
C→S hello        { name }
S→C welcome      { playerId, seed, worldSize, edits: [[x,y,z,id],...], players: [...], mode }
C→S move         { x, y, z, yaw, pitch }          # client throttles to 20 Hz
S→C players      { players: [{id,name,x,y,z,yaw,pitch}] }   # 20 Hz snapshot (only when changed)
C→S blockEdit    { x, y, z, id }                  # server validates: in-bounds, id valid, reach (≤6) vs last known pos
S→C blockEdits   { edits: [[x,y,z,id],...] }      # broadcast to all (including editor, as ack)
C→S chat         { text }        S→C chat { from, text }
S→C modeChanged  { mode: 'sandbox' | 'bedwars', ...state }
```

- **Persistence**: edit overlay saved to `server/data/world-edits.json` (throttled, e.g. every 5 s if dirty + on SIGINT); loaded on boot.
- No prediction/reconciliation. Remote player interpolated between snapshots (~100 ms buffer).

### 3.3 BedWars 1v1 (M4)

- **Mode manager** on server: lobby world = sandbox; `modeChanged('bedwars')` swaps all clients to a match world (separate edit overlay, not persisted).
- **Arena** (code-generated, deterministic): two floating islands 48 blocks apart over void (y=0 plane is void — falling below arena level = death), each with a bed + iron/gold generator; mid island with emerald generator; bridging blocks come from the shop. Void kill plane at y < arenaY − 16.
- **Rules**: respawn after 5 s while your bed stands; breaking the enemy bed stops their respawns (announce it); win by **final kill**; at 10 min all beds auto-break (sudden death); match ends → results screen → rematch / back to sandbox.
- **Shop** (villager-style NPC or simple panel UI at each island): wool/planks (bridge blocks), wood→stone→iron sword tiers, bow + arrows, armor tiers. Costs in iron/gold/emeralds from generators (spawn near your island every few seconds as pickup items).
- **Combat**: melee = DDA raycast ≤3.5 blocks + range check, damage wood 4 / stone 6 / iron 8, knockback impulse along look direction; bow: hold-to-charge (0.2–1 s → 8–24 dmg projectile, simple ballistic ray per tick); 20 HP hearts UI, slow regen (1 HP / 4 s out of combat); death → drop nothing in v1 (keep inventory — kids).
- Server owns health/damage/kill validation (it knows positions).

## 3.4 Block Party 1v1 (M5)

Party mode: the Hive's dance-floor elimination game, adapted for 2 players. Research: playhive.com/game/party + fandom wikis + Hypixel Pixel Party ramp numbers.

- **Arena**: floating 25×25 wool floor at y=30 over void (no walls), both players spawn center. Server owns the floor layout; a round's floor is a fresh random mosaic of 6–8 colors (each cell ~1/ncolors chance, seeded per round). Floor lives in the match world like BedWars (in-memory, not persisted).
- **Wool colors**: new block ids (20–27) all mapped to the white cotton tile with a per-block `tint` in the block registry; the mesher multiplies vertex color = AO × tint (one small mesher change, gives crisp unlimited colors).
- **Round loop (server-authoritative)**: intermission 2.5 s → server re-randomizes floor (broadcast as one blockEdits batch; ≤625 cells, remeshes ~4 chunks) + teleports players to center → **announce color** (gameState: color id + name + round + timer) → countdown: `timer = max(0.75 s, 4.5 s − 0.3 s × roundIndex)` → **drop**: all blocks not the announced color vanish (batched edits) → 1.5 s fall window (void kill y < 8) → score the round: faller loses the round, survivor +1, both fall = draw; neither falls = draw.
- **Match format**: first to **3 round wins** (best-of-5+, draws replay). Timer ramp continues across rounds within a match.
- **Eliminated (fell) player**: spectator — free-fly ghost camera from arena edge, no block interaction, sees the rest of the round.
- **Announcement UI**: large top-center color swatch + color NAME text (colorblind-friendly by default) + shrinking countdown bar; the color block also shown in a dedicated HUD slot.
- **Audio**: countdown ticks accelerating, drop whoosh, round-win jingle, match-win fanfare (procedural, quiet).
- **Reuse from M4**: mode manager, modeChanged/world swap, results screen, rematch flow, chat/kill-feed separation. Power-ups (leap/speed/color-teleporter) are explicitly deferred to M6 polish.

## 4. Milestones

Each milestone = one code-helper brief + orchestrator review + gate. `npm run typecheck && npm run build` must pass every time.

- **M0 — Scaffold**: workspaces, Vite + three.js scene, custom fly camera + pointer lock, click-to-play overlay, FPS debug overlay. *Gate: dev server → fly around.*
- **M1 — Voxel core**: block registry, chunk store, worldgen island (+trees), face-culled meshing + atlas, DDA pick, break/place, 9-slot hotbar, loading screen. *Gate: walk/build/break on the island.*
- **M2 — Physics & feel**: AABB collision, gravity/jump/sprint/fly, crosshair + block outline, day-night, WebAudio SFX (break/place/step). *Gate: movement feels Minecraft-y, no fall-through.*
- **M3 — LAN multiplayer**: ws server + protocol, join/leave + nameplates, 20 Hz relay, block-edit sync via overlay, remote avatar (blocky character), Express hosting of built client, `npm run lan`, persistence. *Gate: Mac + Windows laptop, both see each other build; FPS check on Windows.*
- **M4 — BedWars 1v1**: everything in §3.3. *Gate: full match over LAN.*
- **M5 — Block Party 1v1**: everything in §3.4. *Gate: first-to-3 match over LAN.*
- **M6 — Playtest polish**: chosen after family playtest (candidates: BedWars bow, Block Party power-ups, settings/render distance, particles, more blocks, skins).

## 5. Testing & verification

- Typecheck + build after every milestone; no `any`-leaks in protocol/shared code.
- Manual checklist per gate (README). Netcode changes: two browser tabs on the Mac first, then real LAN.
- Debug overlay (F3): FPS, position, chunk count, draw calls, block targeted.
- Perf target on the Windows laptop: 60 fps at render distance 4.

## 6. Risks → mitigations

- Mesh jank → time-sliced queue; worker pool is the documented upgrade path, only if measured stalls.
- Pointer-lock/audio autoplay rules → click-to-play overlay does `requestPointerLock` + `audioCtx.resume()` in the same gesture.
- iGPU fill-rate → small render distance, fog culling, no shadows/postFX.
- Kenney pack layout → `tools/build-atlas.mjs` script with committed output; colored procedural atlas as fallback.
