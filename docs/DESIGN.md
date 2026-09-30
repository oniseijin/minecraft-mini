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
├─ docs/DESIGN.md      # this file — the source of truth for what the game IS
├─ CONTRIBUTING.md     # how work happens here (humans + AI agents)
├─ CHANGELOG.md        # per-release history
├─ shared/src/         # @mc/shared — protocol types, block registry, deterministic worldgen, math helpers
├─ server/src/         # @mc/server — ws + Express, edit-authority, persistence, mode manager
└─ client/src/         # @mc/client — Vite + three.js: renderer, meshing, physics, input, UI
```

### 2.1 Runtime topology & ports

One client, two serving modes — the client is a single codebase; how it reaches a browser depends on whether you are playing or developing:

- **Built client** (`client/dist`): `npm run build` compiles it and the **game server serves it itself**. This is what players use — production **:6881** (launchd) or a dev `npm run lan` on **:6891**. One URL = client + multiplayer.

| Port | Role |
|---|---|
| **6881** | Production — launchd service (`local.minecraft-mini`), PORT pinned in its plist; deployed from git tags via `scripts/deploy.mjs` |
| **6891** | Development game-server default (`npm run dev:server` / `npm run lan`); the Vite ws proxy targets it; `MC_DEV_PORT` moves both together |
| 5173 | **The workbench** — Vite dev client: the SAME client served from source with hot reload (edit → save → browser updates in milliseconds, no rebuild; `/ws` proxied to the dev server so it stays fully multiplayer). It exists for the code-editing feedback loop, not for playing |
| 8091–8099 | Automated smoke tests — isolated servers + `client/dist-test` (`npm run build:test`, `MC_CLIENT_DIST`); they never touch the live `client/dist` or the prod/dev ports |

Invariants: prod and dev defaults never collide (plist pin vs source default); automated tests never touch anything a live session is serving.

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

### 3.4.1 Auto Color Bombs (M5.1 — built; the faithful Hive feature)

The Hive's Block Party has color bombs: rare events that splash a patch of floor into the round's safe color at drop time, creating a shared survival platform (playhive forum: "it can be used by other players, making it more balanced… in 1v1 scenarios"). Built as a **server-driven auto bomb** — nobody carries or plants anything, players just react (camp the patch or sprint for it at the drop):

- **Spawn**: from round 2, ~40% of rounds (`PARTY_BOMB_RATE` env, default 0.4, seeded per (seed, round)) get ONE bomb ~1 s into the announce — but only if ≥ 3 s of announce remain at that moment (late fast rounds naturally have none). The cell is picked (seeded) among floor cells that are currently a NON-announced color, so reaching the blast is a real race. Position + fuse travel in `gameState.party.bomb` = `{cell:[x,z], colorId, detonatesAt}` (protocol v5).
- **Fuse**: 2.0 s, tracked authoritatively by the server. Clients show a pulsing dark sphere with colored fuse sparks at the cell (sphere + one THREE.Points cloud — ~3 draw calls, iGPU-cheap), accelerating tick beeps, and a kill-feed line "✦ A color bomb appeared!".
- **Detonation**: at `detonatesAt` the server paints the 3×3 patch around the cell into the ANNOUNCED safe color — emitted in the same batched `blockEdits` stream — plus a `bombDetonated` gameEvent (client: particle burst + procedural boom). No special drop logic: painted cells ARE the announced color, so they survive the drop like any other safe tile. Camping the painted patch before the drop is the intended (authentic) strategy; the next round's floor re-deal overwrites the paint as usual.
- **No player actions**: no carrying, no planting, no new C→S messages. Backward-tolerant: a v5 `gameState.party` carries `bomb: null` when idle; v4 clients ignore the extra field, and unknown gameEvent kinds only drop cosmetics.
- **Balance**: one bomb per round max; both players can use the patch — positioning decides.
- **Tests**: `PARTY_BOMB_RATE=1` forces a bomb every eligible round (smoke-party's bomb phase); the test bot ignores bombs entirely (v1).

### 3.4.2 Rematch bug (FIXED in M5.1)

Real-LAN playtest: after matchEnd, both players pressing Rematch did not correctly start the next match. Diagnosis (two-client smoke, tools/smoke-rematch.mjs): the party/bedwars `ready()`/rematch path itself is sound — the REAL defect was one step earlier, on the match-end path. In BedWars, a bed broken while its owner was dead awaiting respawn soft-locked the match forever: `kill()` had already made its elimination check, so nobody could respawn, no final kill could land, `matchEnd` never fired — no results screen, no rematch, "the next match never started". Fix: `cancelRespawn()` in match.ts — when a team's bed breaks (mid-match break or sudden death), any dead player of that team awaiting respawn is eliminated on the spot (death event with respawnIn 0) and the match ends if that decides it. The smoke asserts: rematch after a full Block Party match, rematch after a full BedWars match (results hidden, round/countdown resets, scores/hp reset, spawns re-centered, beds restored), the mid-respawn-window bed break now ending the match, and a second rematch.

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

**Spectator Color Zapper (playtest-approved, part of M5.2)** — the fallen player's revenge shot:
- When YOU fall in a round, from your fall until the round is scored (~1.5–3 s window), you get **one zap**: aim the spectate camera at any surviving floor cell and click → that ONE cell repents to a WRONG color and crumbles (block removed — physics does the rest if the survivor stands on or crosses it).
- Client: after falling, crosshair + hint "Zapper ready — click a floor tile!"; zap renders as a beam flash + cell break effect + sound (both players see/hear it — the telegraph is the counterplay).
- Server rules: sender must be this round's faller; once per fall; target must be a surviving floor cell; only during the fall→scored window. C→S `zapCell{x,z}` (protocol v6), S→C gameEvent `cellZapped{by, cell}`.
- Design intent: a successful zap typically converts "I lost this round" into "both fell = draw, replay" — catch-up drama without theft. If the survivor dodges it, they earned the point.

**Built (protocol v7 — the sketch said v6, but v6 went to sandbox mobs)** — implementation notes and deviations:

- **Wire format**: `gameState.party` gains `boxes: [{cell}]`, `items: {playerId: [itemId×≤3]}` and `effects: [{playerId, effect, until}]`; C→S `useItem {slot}` + `zapCell {x,z}`; gameEvents `boxSpawned`, `boxPickedUp`, `itemUsed`, `leap` (carries the full velocity delta: +8 h along look, +5 v — the knockback event's client math), `teleported`, `swapped` (`a`/`b` = the NEW position of `aId`/`bId`), `cellZapped`. All fields parse tolerantly (absent = pre-v7 → empty), so v6 clients keep working against a v7 server and drop only cosmetics.
- **Boxes**: spawn +0.5 s into the announce, `PARTY_BOX_RATE` of rounds (default 0.8 → 60% of all rounds get 1 box, 20% get 2 via a second seeded roll). `PARTY_BOX_COUNT` (1–2) and `PARTY_ITEM` (force the contents) exist for tests. Trailing player's boxes bias within ±6 cells of their position; pickup = walk within 0.8 (checked on every 20 Hz move + the 200 ms tick); unclaimed boxes vanish at the drop; boxes are markers only (no world block).
- **Caps**: at 3 held, a pickup is REFUSED (`Satchel full!` toast) and the box stays until the drop; a second teleporter is likewise refused (`Only one Color Teleporter!`) rather than rerolled — deterministic for players and tests alike.
- **Use rules**: announce phase only, living fighters only, final-2.0 s lockout (all rejections toast via `error` events; the item is consumed only when its effect applies). Swapper additionally needs a living opponent (no swapping onto the spectator platform). Speed/Jump are server-tracked 5 s buffs pushed via the snapshot `effects`; the owning client multiplies its own controller (×1.4 move / jump velocity 13) — physics stays client-side like movement. Items persist across rounds, cleared at match end.
- **Zapper window**: from the server's fall DETECTION (y < 8, ~1.2 s into the fall) through the `scored` phase — i.e. the designed ~2.3–3.5 s of real reaction time. Client raycasts the player's yaw/pitch (not the lagging camera quaternion) with reach 96; the server re-validates faller/once/cell-survived.
- **Bot**: ignores boxes entirely (the server skips bot pickups) and never uses items (v1, documented in bot.ts).
- **UI**: the Kenney item pack has no feather/potion/keypad sprites, so held-item slots use tinted cotton tiles + text labels (the swatch multiply-blend trick — colorblind-safe by construction), with key numbers and a shrinking buff-timer bar; boxes render as ≤2 pooled spinning cubes (~2 draw calls); the zap is a beam flash + the shared bombFx burst + a sawtooth zap sound.
- **Tests**: `tools/smoke-powerups.mjs` (:8096) — six server passes covering all five items' use paths, caps, toasts, the zapper (2-client), and the final-2 s lockout; `PARTY_ITEM`/`PARTY_BOX_COUNT` make each pass deterministic.

**Deferred ideas (future, from forums/Hypixel)**: decoy bombs, Undying Totem, Color Cow.

## 3.5 Sandbox Mobs (DESIGNED — backlog, not yet scheduled)

Daughter-requested. Feasibility-researched (code + web): **verdict feasible at 8–12 mobs on the integrated-GPU budget**, 15 is the risk ceiling (each mob = 4–7 box meshes ≈ 4–7 draw calls; ~56 baseline + ~60 at 12 mobs; documented escape hatch = InstancedMesh per (kind, part) collapsing to ~5 calls/kind). Effort ≈ 20–25% of a BedWars milestone; passive-only ≈ half.

- **Architecture**: server-simulated, `bot.ts`-style (`stepTowards`/`integrateVertical` are the mob locomotion); client renders dumb avatars cloned from `remotePlayer.ts` (same interpolation, Kenney Fox/Boar/Zombie part PNGs already in repo; NO nameplates — damage flash instead). Server mob tick 5–10 Hz on the authoritative world; new dirty-only `mobs` snapshot message `{id, kind, x, y, z, yaw, hp}` + a `dayT` field piggybacked every few seconds (day-night becomes server-known for hostile spawns).
- **Phase 1 — passive (the MVP)**: 2–4 foxes + 2–4 boars; idle-heavy wander (10–20 s), "panic" flee for 5 s when punched, respawn on a timer. Punch: extend sandbox `attackTarget` ray-vs-AABB to mobs, C→S `attackMob{id}` with the usual range/cooldown validation, HP flash + knock, despawn-death (no drops, no breeding).
- **Phase 2 — hostile**: zombies spawn only at night (dayT > 0.5), despawn/burn at dawn, detection 16 blocks (Bedrock number), chase via `stepTowards`, melee through the existing attack pattern.
- **Rules**: spawn on dry land within 80 blocks of a player (highestBlock+1); cap 8 initially (raise to 12 only after the Windows-laptop FPS check); despawn >64 blocks from both players; mobs never edit blocks.
- **Gate when built**: 60 fps on the Windows laptop with cap reached; punching feels right; zombies stay scary-but-fair.

**Phase 1 built (M5.3, protocol v6)** — 3 foxes + 3 boars, all of the above rules, plus the concrete decisions below. Deviations from the sketch: the `dayT` piggyback is deferred to Phase 2 (nothing hostiles needs it yet); idle re-decisions run every 6–15 s (vs the sketched 10–20) so mobs feel busier for kids; mob parts render as 3 meshes / **5 draw calls per mob** (one merged torso with per-texture groups + two merged diagonal leg pairs — the InstancedMesh escape hatch was not needed), with per-mob materials over shared textures so the 200 ms damage flash doesn't light the herd; knockback is a fast-decaying impulse with a small hurt-pop. Mob brains pause (no sim, no broadcasts) whenever mode ≠ 'sandbox' and force one fresh snapshot on return; despawn >64 from *all* players schedules a respawn near players like a death does. Punch damage is a flat 2 (fist — the sandbox has no weapons); server validation: range ≤4.5 from the roster position, 0.5 s cooldown per player. Client `attackTarget` now tests mob AABBs in the sandbox too (a nearer mob hit beats block breaking); `MC_MOB_CAP` (default 8) and `MC_MOB_RESPAWN_MS` (tests) tune the population. Smoke: `tools/smoke-mobs.mjs` (population, land/spacing rules, punch→hp, death→poof→respawn, mode-pause round-trip).

## 3.6 Murder Mystery co-op (M7 — DESIGNED, implementation next)

The Hive's deduction game, adapted for 2 players. Research: playhive.fandom.com/wiki/Murder_Mystery (the live wiki — hivebedrock.fandom is dead), Hive forum threads, speedrun.com verification.

**The 2-player problem and the fork.** Hive MM is 16 players: 14 Innocents + 1 Sheriff vs 1 Murderer, roles secret. With 2 humans, secret roles collapse — each human instantly knows the other's role, and the game degenerates into tag. Adaptations considered:

- **A (chosen): co-op whodunit vs a hidden bot murderer.** Both humans are Detectives among ~6 wandering NPC "guests"; one guest is secretly the murderer. The mystery survives because nobody knows which NPC it is. No human plays the killer (kid-first: nobody spends the match hunting the players they're with), and the mode works with 1 or 2 humans.
- **B (rejected for now, documented): human murderer + bot innocents.** Closest to Hive, but needs witness AI (bots reacting to seen murders, fleeing, reporting) — roughly double the AI work for the least-shared code — and the murderer player spends the match alone in a stealth game. Revisit later: once A ships, assigning the murderer role to a human instead of a bot is a small delta (swap the murderer brain for knife messages + controls).
- **C (rejected): 1v1 duel** — sheriff vs murderer, both human. Zero deduction (roles known); wastes the fantasy.

**Roles & cast** (Hive numbers, deviations marked):

- **Detectives (the humans)**: each starts with 1 zapper charge; earn +1 charge per 10 coins collected (Hive: innocents earn a 1-shot zapper per 10 gold). Deviation: Hive has one Sheriff among 15; we give both humans the bow — co-op, and each zapper is precious.
- **Guests (6 NPC "innocents")**: server-simulated like mobs (M5.3 pipeline: low-rate snapshot + interpolation), rendered as person avatars with tinted shirts + nameplates ("Red Guest", "Blue Guest"… — nameplates are for people; animals don't get them). They wander, linger, and collect coins.
- **The Murderer**: one random guest, identical in look and idle behavior until it strikes. Melee is an instant kill on guests (Hive sword). Vs humans it takes 2 hits (deviation, kid-first: first hit = red flash + knockback chase drama, not instant loss). The Hive's throwable (10 s cooldown) is deferred — a melee bot doesn't need it.

**Deduction tells** (the game's heart; all readable by a kid watching behavior):

1. **The murderer never collects coins** (the Hive meta tip: "watch for the player not collecting gold").
2. **Innocent guests panic-flee fresh gravestones** (reuse the mob panic behavior); the murderer doesn't react to bodies.
3. **The murderer watches you** — in the middle phase it periodically stops and faces a nearby human.
4. **Proximity**: gravestones appear where the murderer has been (position history is circumstantial evidence).
5. **Final-minute Detector** (Hive: the murderer's Eye of Ender, flipped): in the last 60 s the Detectives' HUD pulses when the murderer is within ~12 blocks — the guaranteed climax.

**Rounds & escalation** (server-authoritative, 5:00 timer — the Hive clock):

- 0–90 s **mingle**: murderer kills only fully-isolated guests (no witnesses: no human line-of-sight, no guest within 8 blocks).
- 90–150 s **bold**: faster kills, the watch-you tell starts.
- Last 60 s **hunt**: murderer chases humans (zombie-chase AI precedent, speed slightly under player sprint so outrunning works) + Detector pulses.
- Win: a human zaps the murderer → both humans win. Both humans dead → murderer wins. Timer expiry → humans win (the murderer "ran out of time" — Hive framing: kill everyone before the clock).

**Kid-first guardrails (deviations from Hive, written down)**:

- **Wrong zap**: Hive eliminates the shooter. Ours: the zapper shatters, jams 10 s, and the shooter is stunned 5 s (the murderer may punish you) — spam-zapping guests to find the killer is punished but not fatal. Zapped guests are confirmed innocent (a deliberate deduction tool).
- **Human death** → ghost: free-fly spectate in the manor (Block Party spectator reuse; deviation: Hive teleports ghosts to a graveyard — we keep them in the scene watching).
- No blood/gore language in UI: gravestones, "fell", "was got". Scary-fun over punishing.

**Coins & zapper** (faithful): Regular gold coin = 1, Epic blue = 3, Super purple = 6 (spawns in secluded rooms/corners). Pickup by walking within 0.8 blocks (party-box rule). Zapper: aim + click, ~20-block range, instant kill on hit, beam FX reused from the party zap. Gravestone investigation: walk up + press E, 30 s cooldown, shows victim + age ("Red Guest — 20s ago") (Hive: Sheriff investigates with 30 s cooldown).

**Map — the Manor**: deterministic code-generated like the party arena, ~48×48 enclosed stone/wood manor: 6–8 rooms + courtyard, door gaps, no void (falling isn't the threat here). Super coins in the far corners. In-memory match world (not persisted), like BedWars/Party.

**Protocol (v-bump at implementation)**: `GameMode` gains `'murder'` (+ `GAME_MODES`); `gameState.murder` = `{phase, endsAt, coins: {playerId: n}, charges: {playerId: n}, jamUntil, guests: [{id, name, color, alive}]}`; guest positions ride the existing mob snapshot stream with `kind: 'guest'` + a color/name id; gameEvents `guestKilled{x,y,z,victimId}`, `murdererRevealed{id}` (win/lose moment), `zapped{id, by, correct}`, `detectorPulse{near}`; C→S `zapGuest{id}`, `investigateGravestone{x,z}`. Coin pickup stays server-side proximity (no message). All new fields parse tolerantly (absent = pre-bump).

**Bot**: the Test Bot can join as a fellow Detective — wanders and collects coins but never zaps (v1, documented in bot.ts); it's a red herring with a name, not a suspect.

**Deferred (documented, from Hive)**: throwable knife, murderer's Innocent Detector as an ITEM (ours is automatic in the final minute), Speed/Invisibility/Jump interactables (party effect plumbing exists if we want them later), gravestone-hides-role for human murderer variant B.

**Tests** (`tools/smoke-murder.mjs`, isolated 809x port): deterministic forcing envs (`MM_MURDERER_GUEST`, `MM_ESCALATE_AT_MS`, `MM_COIN_SPAWN`) — role card + HUD render; coin pickup → charge at 10; zap the murderer → humans win; zap an innocent guest → shatter/jam/stun; murderer kills both humans → murderer wins; detector pulse in the final minute; gravestone investigate; full rematch round-trip.

## 3.7 First-person held item (M7.5 — designed)

Minecraft renders what you hold in your hand; we showed only HUD icons. A v1 viewmodel, iGPU-cheap:

- A camera-anchored group (`camera.add`) draws the held thing in the bottom-right of the view, **over the world** (high `renderOrder`, depth test off — the hand is never occluded, the Minecraft behavior). ≤3 draw calls.
- **Per mode**: sandbox = the selected hotbar block as a small textured cube (atlas UVs, the mesher's tiles); BedWars = bridge blocks as cubes, sword/golden apple as angled sprite quads (Kenney item PNGs approximate Minecraft's extruded items); Murder Mystery = a small zapper wand while charges > 0 (empty hand jammed/dry); Block Party = deliberately empty hands (the floor game holds nothing).
- **Feel**: a gentle walk bob synced to the footstep cadence + a ~250 ms swing arc on every click that acts (attack / place / break / zap). No idle sway in v1.
- Hides with the pause overlay and in spectate/ghost states; swaps instantly on hotbar-slot changes.
- Tests: a smoke-solo assertion that the viewmodel swaps with hotbar selection and swings on a click (via the `__mc` surface).

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
- **M6 — Playtest polish**: chosen after a playtest (candidates: BedWars bow, Block Party power-ups, settings/render distance, particles, more blocks, skins).
- **M7 — Murder Mystery co-op** (§3.6): M7.1 protocol (`'murder'` mode + gameState + messages, PROTOCOL_VERSION bump, parser corpus); M7.2 server engine (`server/src/murder.ts`, manor worldgen, guests + murderer brains, coins/zapper/gravestones/timer, match.ts registry); M7.3 client (modeEnters, matchEvents table, HUD, guest avatars, ghost, detector pulse); M7.4 bot arm + `smoke-murder.mjs` + CHANGELOG. *Gate: a full 5-minute match over LAN, murderer found by tells, wrong zaps survivable.*

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
