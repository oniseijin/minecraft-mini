import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs so the built index.html works when served
  // by the Express server (M3 LAN play).
  base: './',
  server: {
    port: 5173,
    proxy: {
      // Dev clients reach the game server's ws endpoint through Vite
      // (production hits it directly on :8080 — see client/src/net.ts).
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true,
      },
    },
  },
});
