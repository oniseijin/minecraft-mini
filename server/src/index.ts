import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(here, '../../client/dist');
const port = 8080;

const app = express();

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

if (existsSync(clientDist)) {
  // Serve the built client (LAN play, M3).
  app.use(express.static(clientDist));
} else {
  app.get('/', (_req, res) => {
    res
      .type('text')
      .send(
        'client/dist not built yet. Run `npm run build`, or `npm run dev` ' +
          'for the Vite dev server at http://localhost:5173',
      );
  });
}

app.listen(port, () => {
  console.log(`[server] listening on http://localhost:${port}`);
});
