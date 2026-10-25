// Generates simple PNG icons (rounded square with a speech-bubble dot pattern) without dependencies.
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

function png(size) {
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
      // Gradient indigo background.
      const t = (x + y) / (2 * size);
      let [R, G, B] = [79 - 30 * t, 70 - 20 * t, 229 - 40 * t];
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

for (const size of [16, 32, 48, 128]) writeFileSync(resolve(outDir, `icon${size}.png`), png(size));
console.log(`Icons written to ${outDir}`);
