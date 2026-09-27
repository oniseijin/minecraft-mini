import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs so the built index.html works when served
  // by the Express server (M3 LAN play).
  base: './',
  server: {
    port: 5173,
  },
});
