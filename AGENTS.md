# AGENTS.md

This repository contains the source code for `minecraft-mini`, a tiny browser-based voxel sandbox simulation.

## 🚀 Key Commands

Use the root `package.json` scripts for primary operations:

*   **`npm run dev:all`**: Runs the game server and Vite dev client simultaneously (recommended for development).
*   **`npm run dev`**: Starts the client development server (Vite).
*   **`npm run dev:server`**: Starts the game server.
*   **`npm run build`**: Builds the client bundle (`client/dist`).
*   **`npm run lan`**: Starts the server and outputs LAN join URLs.
*   **`npm run typecheck`**: Runs TypeScript checks across `shared`, `server`, and `client`.
*   **`npm run deploy`**: Deploys a git tag to the launchd production install (`~/.local/opt/minecraft-mini`, world at `~/.local/share/minecraft-mini`). See `scripts/deploy.mjs` header. Prod runs on 6881 (launchd); the dev default is 6891 (server default + Vite ws proxy) so they never collide. `MC_DEV_PORT` overrides the dev pair.

## 📂 Repository Layout

The project uses a monorepo structure managed by root `package.json` workspaces:

*   `client/`: Frontend code (Vite/TypeScript/three.js).
*   `server/`: Backend game logic (Node/TypeScript).
*   `shared/`: Shared logic between client and server.
*   `scripts/`: Startup scripts.
*   `tools/`: Profiling and smoke testing scripts.

## 📚 Documentation Map

*   **`docs/DESIGN.md`** — the source of truth for what the game is (architecture §3, ports §2.1, mode specs). Read before designing anything; update it with every feature.
*   **`CONTRIBUTING.md`** — how work happens: the change workflow, Definition of Done, **live-family safety rules** (never touch :6881 mid-session; never rebuild `client/dist` from tests), design principles, protocol discipline, and AI-agent collaboration notes. Required reading.
*   **`CHANGELOG.md`** — per-release history; new work lands under `[Unreleased]`.

## 🛠️ Conventions & Notes

*   **Monorepo:** Dependencies and builds are managed via workspaces (`shared`, `server`, `client`).
*   **Client Dev:** The client uses Vite (`client/vite.config.ts`).
*   **Server Dev:** The server uses Node/TypeScript (`server/tsconfig.json`).
*   **Persistence:** World edits persist in `server/data/world-edits.json` on the host machine.
*   **Caution:** For LAN play, the host must run `npm run lan` to generate reachable URLs.

---
