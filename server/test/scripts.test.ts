/**
 * The .mjs helper scripts (check-keys, smoke) are not type-checked. Make sure every name they import from
 * src/ still exists, so moving an export cannot silently break `npm run check:keys` / start-copilot.cmd.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts');
const imports = readdirSync(scriptsDir)
  .filter((f) => f.endsWith('.mjs'))
  .flatMap((file) =>
    [...readFileSync(path.join(scriptsDir, file), 'utf8').matchAll(/import\s*\{([^}]+)\}\s*from\s*'(\.\.\/src\/[^']+)'/g)].map((m) => ({
      file,
      names: (m[1] ?? '')
        .split(',')
        .map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim() ?? '')
        .filter(Boolean),
      source: m[2] ?? '',
    })),
  );

describe('helper scripts', () => {
  it('import from src/', () => {
    expect(imports.some((i) => i.file === 'check-keys.mjs')).toBe(true);
  });

  it.each(imports.map((i) => [`${i.file}: ${i.source}`, i] as const))('%s exports what the script imports', async (_name, i) => {
    const mod = (await import(path.resolve(scriptsDir, i.source.replace(/\.js$/, '.ts')))) as Record<string, unknown>;
    for (const name of i.names) expect(mod[name], `${i.file} imports ${name} from ${i.source}`).toBeDefined();
  });
});
