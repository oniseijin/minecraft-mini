# minecraft-mini — Design & Build Plan

## Locked decisions (research + your picks)
- **Stack**: TypeScript everywhere. Client: Vite + three.js (WebGL2). Server: Node.js 20+ with `ws` + Express. npm-workspaces monorepo. Browser-only clients = zero install on the low-spec Windows laptop and the M2 Mac; classic.minecraft.net proves browser Minecraft runs on integrated GPUs.
- **Custom voxel engine, no library**: voxel.js is dead, noa-engine is ~3 years inactive — every successful recent browser clone hand-rolls this, and it's a pattern AI agents reproduce reliably.
- **Iteration 1**: open-world **creative sandbox**, 2 players over LAN, world persists.
- **Iteration 2**: **BedWars Duels-style 1v1** (Hive-style mini-game; the research's clear pick for 2 players — respawn loop keeps matches forgiving, 5–10 min).
- **Art**: Kenney CC0 voxel texture pack, committed to the repo, packed into a texture atlas at build time.
- **Built with code-helper subagents**: each milestone below is one self-contained implementation brief handed to a code-helper agent; I orchestrate, review the diff, run it, fix integration issues, and gate on playtests.

## Repo layout
```
minecraft-mini/
├─ package.json        # npm workspaces + root scripts: dev / build / start / lan / typecheck
├─ docs/DESIGN.md      # this design doc, kept current as we iterate
├─ shared/             # ws protocol message types, block registry, seeded worldgen
├─ server/             # ws + static hosting, authoritative state, persistence, game modes
└─ client/             # Vite + three.js: rendering, meshing, physics, input, UI
```

## Architecture
**World & engine (client + shared worldgen)**
- Finite island world for v1: 256×64×256 blocks = 16×16 chunks (16×64×16 each), flat `Uint8Array` per chunk, deterministic from a seed. Chunk-map interface leaves room for infinite streaming later.
- Rendering: one opaque + one transparent `BufferGeometry` per chunk; face-culled meshing driven by a **time-sliced dirty-remesh queue** (upgrade to a worker pool only if we measure frame stalls — less AI-written surface area); single texture atlas; fog at render edge; **no shadow maps**; default render distance 4 chunks; FPS shown in a debug overlay (F3-style).
- Interaction: Amanatides–Woo voxel DDA raycast (5-block reach), block highlight, break/place with mouse, 9-slot hotbar (scroll / 1–9).
- Physics: fixed-timestep, axis-separated AABB voxel collision; walk / jump / sprint; creative fly on double-tap space.

**Server & networking**
- Server is the single authority for **block edits** (validates id + reach) and **game-mode state**; player movement is trusted-client and relayed at **20 Hz** — no prediction/reconciliation needed at LAN RTT (<5 ms).
- JSON messages over `ws` (fine at 2 players; typed in `shared/protocol.ts`).
- Server also serves the built client on `:8080` → the Windows laptop just opens `http://<mac-lan-ip>:8080`. `npm run lan` prints all LAN URLs. World diffs persisted to disk (throttled) and reloaded on restart.

**BedWars 1v1 rules (minimal Duels set)**
- Server-side mode manager swaps worlds: two code-generated floating islands (bed + iron/gold generator each) + mid island (emerald generator), void below.
- Respawn in 5 s while your bed stands; breaking the enemy bed stops their respawns; **win by final kill**; all beds auto-break at 10 min to force an end; shop NPC per island (blocks, sword tiers, bow + arrows, armor).
- Combat: melee raycast (3.5-block range) with knockback, charged bow, 20 HP with slow regen.

## Milestones — each is a code-helper brief with acceptance criteria + playtest gate
- **M0 — Scaffold** (git init, workspaces, Vite + three.js scene, click-to-play pointer-lock overlay, dev scripts). Gate: `npm run dev` → sky + ground, WASD fly camera.
- **M1 — Voxel core**: block registry, chunk store, seeded island worldgen (+ trees), meshing, DDA pick, break/place with neighbor remesh, hotbar UI, Kenney atlas. Gate: walk the island, build and break.
- **M2 — Player physics & feel**: AABB collision, gravity/jump/sprint, fly toggle, crosshair + block outline, day-night cycle, basic sounds (WebAudio, resumed on the click gesture). Gate: no falling through the world, movement feels Minecraft-y.
- **M3 — LAN multiplayer**: ws server, join/leave + nameplates, 20 Hz relay, block-edit sync, blocky avatar for the remote player, static hosting of the built client, `npm run lan` URL print, world persistence. **Gate: real 2-player test — Mac hosts, Windows laptop joins; both place blocks and see each other. Also the first perf check on the Windows machine.**
- **M4 — BedWars 1v1**: arena generator, mode manager, beds, generators, shop, health/combat/knockback, respawn, win/lose UI + rematch. Gate: a full dad-vs-daughter match over LAN.
- **M5 — Playtest-driven polish** (menu UX, chat, settings incl. render distance, break particles, more blocks/sounds, skins) — scope picked from what you two actually want after M4.

M0–M2 ≈ first half of the "week"; M3 is the first genuinely 2-player moment; M4 delivers the Hive-style game.

## Verification
- Every milestone: `npm run typecheck && npm run build` clean + a short manual checklist in the README.
- Two-browser-tab test on the Mac for netcode changes; real LAN test at the M3/M4 gates.
- FPS overlay tracked on the Windows laptop (target 60 fps at render distance 4).

## Risks & mitigations
- Main-thread meshing hitches → time-sliced queue now, worker-pool upgrade path documented.
- Pointer-lock / audio autoplay browser rules → click-to-play overlay handles both in one gesture.
- Low-spec GPU → small render distance + fog + no shadows by design.
- Kenney pack layout surprises → one-off atlas build script with committed output.

**First implementation step**: `git init`, write `docs/DESIGN.md`, then M0.