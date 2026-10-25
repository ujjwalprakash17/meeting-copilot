import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Multi-entry MV3 build:
 *  - popup.html / assistant.html / offscreen.html: extension pages
 *  - background.js: module service worker (fixed name, referenced by manifest.json)
 *  - capture-worklet.js: AudioWorklet module (fixed name, loaded via chrome.runtime.getURL; has no imports)
 */
export default defineConfig({
  plugins: [react()],
  base: '',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome116',
    modulePreload: { polyfill: false },
    sourcemap: true,
    rollupOptions: {
      input: {
        popup: resolve(import.meta.dirname, 'popup.html'),
        assistant: resolve(import.meta.dirname, 'assistant.html'),
        offscreen: resolve(import.meta.dirname, 'offscreen.html'),
        background: resolve(import.meta.dirname, 'src/background/serviceWorker.ts'),
        'capture-worklet': resolve(import.meta.dirname, 'src/offscreen/capture-worklet.ts'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'background' || chunk.name === 'capture-worklet' ? '[name].js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
