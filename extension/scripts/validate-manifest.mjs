// Validates dist/manifest.json: required MV3 fields, minimal permissions, and that every referenced file exists.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const errors = [];
const fail = (msg) => errors.push(msg);

if (!existsSync(resolve(dist, 'manifest.json'))) {
  console.error('dist/manifest.json not found; run `npm run build` first.');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8'));

if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
for (const key of ['name', 'version', 'description']) if (!manifest[key]) fail(`missing ${key}`);
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version ?? '')) fail('version must be 1-4 dot-separated integers');

const allowed = new Set(['tabCapture', 'offscreen', 'storage', 'activeTab']);
for (const p of manifest.permissions ?? []) if (!allowed.has(p)) fail(`unexpected permission "${p}" (keep permissions minimal)`);
// Optional permissions are only granted when the user enables the feature that needs them.
const allowedOptional = new Set(['system.display']);
for (const p of manifest.optional_permissions ?? []) if (!allowedOptional.has(p)) fail(`unexpected optional permission "${p}"`);
if (manifest.host_permissions?.length) fail('host_permissions are not needed (server uses CORS for the extension origin)');
if (manifest.content_scripts?.length) fail('content_scripts must not be used: the assistant never injects into meeting pages');

const files = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  'assistant.html',
  'offscreen.html',
  'capture-worklet.js',
].filter(Boolean);
for (const f of files) if (!existsSync(resolve(dist, f))) fail(`referenced file missing: ${f}`);
if (manifest.background?.type !== 'module') fail('background.type must be "module"');

const commands = Object.values(manifest.commands ?? {});
const suggested = commands.filter((c) => c.suggested_key).length;
if (suggested > 4) fail('Chrome allows at most 4 suggested keyboard shortcuts');

// The built bundle must not contain provider secrets or provider endpoints.
for (const f of ['background.js']) {
  const src = readFileSync(resolve(dist, f), 'utf8');
  if (/gsk_[A-Za-z0-9]{20,}|api\.groq\.com|api\.deepgram\.com/.test(src)) fail(`${f} references a provider API directly`);
}

if (errors.length) {
  console.error(`Manifest validation failed:\n - ${errors.join('\n - ')}`);
  process.exit(1);
}
console.log(`Manifest OK: ${manifest.name} ${manifest.version}; permissions: ${manifest.permissions.join(', ')}; ${files.length} referenced files present.`);
