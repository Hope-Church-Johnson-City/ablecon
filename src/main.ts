// Command-line entry: `npm start` (or `node src/main.ts`).
//   ABLCON_PORT      web UI port (default 8420)
//   ABLCON_LIVE_PORT Remote Script UDP port (default 11100)
//   ABLCON_SETLIST   setlist file (default ./ablcon-setlist.json next to the server)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const running = await startServer({
  port: Number(process.env.ABLCON_PORT ?? 8420),
  livePort: Number(process.env.ABLCON_LIVE_PORT ?? 11100),
  setlistPath: process.env.ABLCON_SETLIST ?? path.join(root, 'ablcon-setlist.json'),
  publicDir: path.join(root, 'public'),
});

console.log('Ablcon is running. Open one of these on any device on this network:');
for (const url of running.urls) console.log(`  ${url}`);

const shutdown = () => void running.close().then(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
