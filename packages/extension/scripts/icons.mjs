// Generates flat shield icons as PNGs with no dependencies.
import { deflateSync, crc32 } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
};

function png(size) {
  const rows = [];
  const cx = size / 2;
  for (let y = 0; y < size; y++) {
    const row = [0];
    for (let x = 0; x < size; x++) {
      // shield: rounded top, pointed bottom
      const nx = (x - cx) / (size * 0.42);
      const ny = (y - size * 0.45) / (size * 0.5);
      const inside = ny < 0 ? nx * nx + ny * ny * 0.9 <= 1 : Math.abs(nx) <= 1 - ny * 0.95 && ny <= 1;
      const tick = inside && Math.abs(y - (size * 0.55 + Math.abs(x - cx * 1.1) * 0.9)) < size * 0.08 && x > size * 0.3 && x < size * 0.75;
      if (tick) row.push(255, 255, 255, 255);
      else if (inside) row.push(43, 108, 255, 255);
      else row.push(0, 0, 0, 0);
    }
    rows.push(Buffer.from(row));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// node icons.mjs [--out dir] [size ...]: the extension build uses the defaults.
const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? args.splice(outAt, 2)[1] : 'dist/icons';
const sizes = args.length ? args.map(Number) : [16, 32, 48, 128];
await mkdir(out, { recursive: true });
for (const s of sizes) await writeFile(`${out}/icon${s}.png`, png(s));
