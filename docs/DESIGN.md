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

### 3.4.1 Color Bombs (M5.1 — real Hive feature)

The Hive's Block Party has color bombs: rare special events that splash a patch of floor into the round's safe color at drop time, creating a shared survival platform (playhive forum: "it can be used by other players, making it more balanced… in 1v1 scenarios"). Our version adds pickup-and-plant agency — the community-favorite twist:

- **Spawn**: from round 2, ~50% of rounds (seeded) spawn ONE bomb pickup on a random floor cell — a pulsing dark sphere with a colored fuse (client-side mesh + soft audio cue on spawn; position in `gameState.party`).
- **Pickup**: walk within 0.8 blocks → you carry it (max 1, doesn't persist across rounds, dropped player keeps carrying while spectating? no — cleared on round end). HUD shows "Carrying color bomb · G to plant".
- **Plant**: press **G** during announce phase (before drop) → server validates (party mode, carrying, announce phase), plants at your floor cell, broadcasts a gameEvent (`bombPlanted` by name + position) + chat line "✦ Ryan planted a color bomb!" — the opponent can SEE it and run to the platform too (that's the point).
- **Detonation**: at the drop moment, planted bombs explode — after the non-safe-color floor vanishes, each bomb re-paints a radius-2 (5×5) disc around itself into the announced safe color. Those cells SURVIVE the drop (a late safe island for anyone standing there or quick enough to land/jump to it). Explosion = client particle burst + boom sound. Unplanted/unclaimed bombs fizzle silently at drop.
- **Server-authoritative**: bomb state in the party match (spawned/carriedBy/plantedAt cells in `gameState.party.bombs`), plant via new C→S message `plantBomb{}` (protocol v5). Detonation cells emitted in the same batched blockEdits stream. A detonated platform cell acts like normal floor (next round's re-deal overwrites it).
- **Balance**: one bomb per round max; if both players want the platform, positioning race decides — planting telegraphs your safe spot.

### 3.4.2 Known bug (fix in M5.1): rematch

Real-LAN playtest: after matchEnd, both players pressing Rematch did not correctly start the next match. Likely in the ready-tracking / restart path (server match.ts `ready()` / party.ts `partyReady`). Fix + add a both-players-rematch smoke assertion (play a short match to matchEnd, both send ready, assert fresh countdown + both players teleported to spawns + HUD reset).

### 3.4.3 Mystery Boxes & Power-Ups (M5.2 — build after M5.1 lands)

The Hive's Mario-Party-style item system, kid-balanced. Research-backed numbers (playhive wiki/support, forums, Hypixel Pixel Party, Mario Party item-shop principles).

**Mystery Box loop**
- From round 2, each round spawns 1 box (60%) or 2 boxes (20%): spinning cube at a random free floor cell, ~0.5 s after the color announcement; collect by walking within 0.8 blocks (same rule as bombs — no punching).
- Random item, weighted: Leap 25%, Speed 25%, Jump Boost 20%, Swapper 15%, Color Teleporter 15% (spawn odds already low-ish; teleports are round-winners).
- **Catch-up (Mario Party rubber-band)**: the player TRAILING on round scores gets their boxes spawn-biased nearer their position (±6 cells) — flavor of "shop discounts for last place".
- Unclaimed boxes vanish at the drop.
- **Hold cap 3 items** (anti-hoard — the Hive's "someone with 6 teleporters" problem), teleporter cap 1. Items persist across rounds within a match; cleared at match end.

**The 5 items** (activate with keys **1/2/3** matching 3 held-item slots shown above the party HUD; announce phase only)
1. **Leap (feather)** — dash impulse along look direction: +8 m/s horizontal, +5 m/s vertical. Escape/reposition tool; doesn't guarantee survival.
2. **Speed (blue potion)** — 5 s at ×1.4 movement speed (our 4.3 walk → ~6 m/s ≈ Hive's Speed III over baseline).
3. **Jump Boost (green potion)** — 5 s of jump velocity 13 (≈2.6-block jumps — enough to hop back onto the floor edge after a slip).
4. **Swapper** — instantly swap positions (and velocities) with the opponent. Both get a big toast. Duel spice; not usable in the final 2 s.
5. **Color Teleporter (keypad)** — the "second life": teleport to the nearest cell of the round's announced color. Guardrails (from the Hive's own bug reports + removal threads): usable ONLY during announce, **locked in the final 2.0 s** of the timer, and refused while falling below floor level. Hold limit 1.

**Guardrails (all items)**: announce phase only; final-2.0 s lockout with a countdown tick change + toast explaining a rejected use; no use while spectating/eliminated; box + item icons drawn from Kenney item PNGs; pickup toast "✦ Got Speed!" + name shown in colorblind-safe text.

**Server-authoritative mechanics** (protocol v6): C→S `useItem{slot}`; `gameState.party` gains `boxes: [{cell}]` and `items: {playerId: [itemId×3]}`; gameEvents `boxSpawned`, `itemPickedUp{playerId, item}`, `itemUsed{playerId, item}`, `teleported`, `swapped`. Speed/Jump effects: server tracks expiry, pushes `{effect, until}` to the owning client (client applies multipliers to its player controller — physics stays client-side like movement). Teleport/Swap: server moves players through the existing teleport path. Bot: uses items only if trivial (skip in v1 — document).

**Spectator Color Zapper (family-approved, part of M5.2)** — the fallen player's revenge shot:
- When YOU fall in a round, from your fall until the round is scored (~1.5–3 s window), you get **one zap**: aim the spectate camera at any surviving floor cell and click → that ONE cell repents to a WRONG color and crumbles (block removed — physics does the rest if the survivor stands on or crosses it).
- Client: after falling, crosshair + hint "Zapper ready — click a floor tile!"; zap renders as a beam flash + cell break effect + sound (both players see/hear it — the telegraph is the counterplay).
- Server rules: sender must be this round's faller; once per fall; target must be a surviving floor cell; only during the fall→scored window. C→S `zapCell{x,z}` (protocol v6), S→C gameEvent `cellZapped{by, cell}`.
- Design intent: a successful zap typically converts "I lost this round" into "both fell = draw, replay" — catch-up drama without theft. If the survivor dodges it, they earned the point.

**Deferred ideas (future, from forums/Hypixel)**: decoy bombs, Undying Totem, Color Cow.

## 3.5 Sandbox Mobs (DESIGNED — backlog, not yet scheduled)

Daughter-requested. Feasibility-researched (code + web): **verdict feasible at 8–12 mobs on the integrated-GPU budget**, 15 is the risk ceiling (each mob = 4–7 box meshes ≈ 4–7 draw calls; ~56 baseline + ~60 at 12 mobs; documented escape hatch = InstancedMesh per (kind, part) collapsing to ~5 calls/kind). Effort ≈ 20–25% of a BedWars milestone; passive-only ≈ half.

- **Architecture**: server-simulated, `bot.ts`-style (`stepTowards`/`integrateVertical` are the mob locomotion); client renders dumb avatars cloned from `remotePlayer.ts` (same interpolation, Kenney Fox/Boar/Zombie part PNGs already in repo; NO nameplates — damage flash instead). Server mob tick 5–10 Hz on the authoritative world; new dirty-only `mobs` snapshot message `{id, kind, x, y, z, yaw, hp}` + a `dayT` field piggybacked every few seconds (day-night becomes server-known for hostile spawns).
- **Phase 1 — passive (the MVP)**: 2–4 foxes + 2–4 boars; idle-heavy wander (10–20 s), "panic" flee for 5 s when punched, respawn on a timer. Punch: extend sandbox `attackTarget` ray-vs-AABB to mobs, C→S `attackMob{id}` with the usual range/cooldown validation, HP flash + knock, despawn-death (no drops, no breeding).
- **Phase 2 — hostile**: zombies spawn only at night (dayT > 0.5), despawn/burn at dawn, detection 16 blocks (Bedrock number), chase via `stepTowards`, melee through the existing attack pattern.
- **Rules**: spawn on dry land within 80 blocks of a player (highestBlock+1); cap 8 initially (raise to 12 only after the Windows-laptop FPS check); despawn >64 blocks from both players; mobs never edit blocks.
- **Gate when built**: 60 fps on the Windows laptop with cap reached; punching feels right; zombies stay scary-but-fair.

## 4. Milestones

Each milestone = one code-helper brief + orchestrator review + gate. `npm run typecheck && npm run build` must pass every time.

- **M0 — Scaffold**: workspaces, Vite + three.js scene, custom fly camera + pointer lock, click-to-play overlay, FPS debug overlay. *Gate: dev server → fly around.*
- **M1 — Voxel core**: block registry, chunk store, worldgen island (+trees), face-culled meshing + atlas, DDA pick, break/place, 9-slot hotbar, loading screen. *Gate: walk/build/break on the island.*
- **M2 — Physics & feel**: AABB collision, gravity/jump/sprint/fly, crosshair + block outline, day-night, WebAudio SFX (break/place/step). *Gate: movement feels Minecraft-y, no fall-through.*
- **M3 — LAN multiplayer**: ws server + protocol, join/leave + nameplates, 20 Hz relay, block-edit sync via overlay, remote avatar (blocky character), Express hosting of built client, `npm run lan`, persistence. *Gate: Mac + Windows laptop, both see each other build; FPS check on Windows.*
- **M4 — BedWars 1v1**: everything in §3.3. *Gate: full match over LAN.*
- **M5 — Block Party 1v1**: everything in §3.4. *Gate: first-to-3 match over LAN.*
- **M5.1 — Color bombs (auto) + rematch fix + test-build isolation** (§3.4.1–3.4.2). *Gate: bomb match over LAN + rematch works twice in a row.*
- **M5.2 — Mystery Boxes & power-ups** (§3.4.3). *Gate: a full match using every item at least once.*
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
