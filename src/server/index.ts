import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { api } from './api.ts';
import { proxy } from './proxy.ts';
import { DATA_DIR, setting } from './db.ts';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));

app.use('/api', api);
app.use(proxy);

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'comb' });
});

const clientDir = join(process.cwd(), 'dist', 'client');
if (existsSync(clientDir)) {
  app.use(express.static(clientDir));
  app.get(/^\/(?!api|v1|healthz).*/, (_req, res) => {
    res.sendFile(join(clientDir, 'index.html'));
  });
}

const port = Number(process.env.PORT ?? 3000);
// Local-first tool: the dashboard has no login, so it binds to loopback unless
// HOST is set explicitly (a container or a tunnel).
const host = process.env.HOST ?? '127.0.0.1';

app.listen(port, host, () => {
  const key = setting('bootstrap_api_key', '');
  console.log(`comb listening on http://${host}:${port}`);
  console.log(`data dir: ${DATA_DIR}`);
  console.log(`bootstrap key: ${key}  (also in data/bootstrap-key.txt)`);
  console.log(`openai base url: http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/v1`);
});
