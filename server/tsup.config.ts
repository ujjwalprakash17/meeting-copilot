import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  // node:sqlite (conversation history) requires Node 22.13+.
  target: 'node22',
  // Keep the node: prefix: 'node:sqlite' has no unprefixed alias and must not be rewritten to 'sqlite'.
  removeNodeProtocol: false,
  external: ['node:sqlite'],
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Bundle the TypeScript-source shared package; keep real npm dependencies external.
  noExternal: ['@meeting-copilot/shared'],
});
