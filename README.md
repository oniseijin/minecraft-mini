# Minecraft Mini

A tiny browser-based voxel sandbox for 2 players on LAN — Vite + TypeScript + three.js client, Node + Express server.

## Quickstart

```sh
npm install
npm run dev        # client (Vite dev server) at http://localhost:5173
```

In a second terminal, optionally:

```sh
npm run dev:server # API server at http://localhost:8080
```

Controls (click the page to grab the mouse): `WASD` move, `Space` up, `Shift` down, `Esc` release the mouse.

## Other scripts

| Command | What it does |
| --- | --- |
| `npm run build` | Build the client into `client/dist` |
| `npm start` | Serve the built client + API at http://localhost:8080 |
| `npm run typecheck` | Typecheck shared, server, and client |

## LAN play

LAN multiplayer (join from any device on the same network via a URL) lands in milestone M3.
