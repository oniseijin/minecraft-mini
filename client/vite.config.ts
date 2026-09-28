import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs so the built index.html works when served
  // by the Express server (M3 LAN play).
  base: './',
  server: {
    port: 5173,
    proxy: {
      // Dev clients reach the game server's ws endpoint through Vite
      // (production hits it directly on :6881 — see client/src/net.ts). The
      // dev server defaults to :6891; MC_DEV_PORT overrides both together.
      '/ws': {
        target: process.env.MC_DEV_PORT ? `ws://localhost:${process.env.MC_DEV_PORT}` : 'ws://localhost:6891',
        ws: true,
      },
    },
  },
});
