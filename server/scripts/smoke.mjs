// Smoke test of the *built* server bundle (catches bundling problems unit tests cannot, e.g. node: imports).
// Starts dist/index.js with a temporary history database, checks /health and /api/status, then stops it.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), 'mc-smoke-'));
const port = 18_000 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, [path.resolve(here, '../dist/index.js')], {
  env: { ...process.env, PORT: String(port), LLM_PROVIDER: 'mock', HISTORY_DB_PATH: path.join(dir, 'smoke.sqlite'), LOG_LEVEL: 'warn' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (d) => (output += d));
child.stderr.on('data', (d) => (output += d));

const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
let ok = false;
try {
  for (let i = 0; i < 50 && !ok; i++) {
    await new Promise((r) => setTimeout(r, 100));
    ok = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false);
  }
  if (!ok) throw new Error('server did not become healthy');
  const status = await (await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { Origin: origin } })).json();
  if (!status.history?.enabled) throw new Error(`history not enabled: ${JSON.stringify(status.history)}`);
  const list = await fetch(`http://127.0.0.1:${port}/api/history`, { headers: { Origin: origin } });
  if (list.status !== 200) throw new Error(`GET /api/history returned ${list.status}`);
  console.log(`Smoke OK: built server healthy on :${port}, history enabled (SQLite), API reachable.`);
} catch (err) {
  console.error(`Smoke FAILED: ${err.message}\n${output}`);
  process.exitCode = 1;
} finally {
  child.kill();
  await new Promise((r) => child.once('exit', r));
  rmSync(dir, { recursive: true, force: true });
}
