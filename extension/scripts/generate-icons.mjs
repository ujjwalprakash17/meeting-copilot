// Generates simple PNG icons (rounded square with three "listening" bars) without dependencies.
//   icon*.png    brand icon (chrome://extensions, store)
//   idle*.png    toolbar icon while not listening (muted grey)
//   active*.png  toolbar icon while listening (soft blue; close in brightness to the grey on purpose)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public/icons');
mkdirSync(outDir, { recursive: true });

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

/** Background gradient per variant: t runs from 0 (top-left) to 1 (bottom-right). */
const VARIANTS = {
  icon: (t) => [79 - 30 * t, 70 - 20 * t, 229 - 40 * t],
  idle: (t) => [124 - 24 * t, 130 - 24 * t, 140 - 24 * t],
  active: (t) => [86 - 20 * t, 126 - 22 * t, 178 - 24 * t],
};

function png(size, background = VARIANTS.icon) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const r = size * 0.22;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const i = y * (size * 4 + 1) + 1 + x * 4;
      // Rounded-square mask.
      const cx = Math.min(Math.max(x + 0.5, r), size - r);
      const cy = Math.min(Math.max(y + 0.5, r), size - r);
      const inside = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r;
      if (!inside) continue;
      // Gradient background.
      const t = (x + y) / (2 * size);
      let [R, G, B] = background(t);
      // Three white "listening" bars.
      const bars = [0.32, 0.5, 0.68];
      const heights = [0.22, 0.4, 0.22];
      bars.forEach((bx, k) => {
        const halfW = size * 0.065;
        const halfH = size * heights[k];
        if (Math.abs(x + 0.5 - bx * size) <= halfW && Math.abs(y + 0.5 - size * 0.5) <= halfH) [R, G, B] = [255, 255, 255];
      });
      raw[i] = R;
      raw[i + 1] = G;
      raw[i + 2] = B;
      raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const [name, background] of Object.entries(VARIANTS)) {
  for (const size of [16, 32, 48, 128]) writeFileSync(resolve(outDir, `${name}${size}.png`), png(size, background));
}
console.log(`Icons written to ${outDir}`);
