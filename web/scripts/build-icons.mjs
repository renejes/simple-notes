// Renders the public/icon.svg to PNGs at the sizes we need for PWA install.
// Run once after editing icon.svg: `node scripts/build-icons.mjs`.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, "..", "public");

const SIZES = [
  { out: "icon-180.png", size: 180 }, // iOS apple-touch-icon
  { out: "icon-192.png", size: 192 }, // Android home screen
  { out: "icon-512.png", size: 512 }, // Android splash / install
  { out: "icon-maskable-512.png", size: 512, padding: 0.1 }, // Android maskable
];

const svg = await readFile(resolve(publicDir, "icon.svg"));

for (const { out, size, padding = 0 } of SIZES) {
  const pad = Math.round(size * padding);
  const inner = size - pad * 2;
  let img = sharp(svg).resize(inner, inner);
  if (pad > 0) {
    img = img.extend({
      top: pad,
      bottom: pad,
      left: pad,
      right: pad,
      background: { r: 26, g: 26, b: 26, alpha: 1 },
    });
  }
  await img.png().toFile(resolve(publicDir, out));
  console.log(`wrote public/${out} (${size}x${size})`);
}
