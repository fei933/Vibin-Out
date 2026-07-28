#!/usr/bin/env node
/**
 * Draw a fixture photograph for the photo-input path.
 *
 *   node scripts/make-fixture-photo.mjs [outfile]
 *
 * There is no image library in this project's dependency tree and no
 * ImageMagick on the machine, so the canvas we already depend on for the share
 * card does the work — inside the Playwright chromium that the E2E run already
 * requires. It renders a large (3024x4032, the shape a phone actually produces)
 * warm-lit room: low afternoon sun across a wall, a window's light spill, a
 * wooden surface, grain. Deliberately oversized so the client-side compressor
 * is genuinely exercised rather than handed something already small.
 *
 * Not a test fixture in the unit-suite sense — nothing in `npm test` reads it.
 * It exists so the live photo run has a real photograph-shaped JPEG to send.
 */
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || path.join(ROOT, 'documentation', 'fixture-room.jpg');

const { chromium } = await import('playwright');
const browser = await chromium.launch();
const page = await browser.newPage();

const dataUrl = await page.evaluate(async () => {
  const W = 3024;
  const H = 4032;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Wall: warm plaster, light falling off toward the floor.
  const wall = ctx.createLinearGradient(0, 0, W * 0.4, H);
  wall.addColorStop(0, '#e8d9c3');
  wall.addColorStop(0.45, '#cbb69a');
  wall.addColorStop(1, '#6d5a45');
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, W, H);

  // Late sun through a window: two bright quadrilaterals thrown across the wall.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const beam = ctx.createLinearGradient(W * 0.1, 0, W * 0.9, H * 0.7);
  beam.addColorStop(0, 'rgba(255, 214, 150, 0.55)');
  beam.addColorStop(1, 'rgba(255, 180, 110, 0)');
  ctx.fillStyle = beam;
  ctx.beginPath();
  ctx.moveTo(W * 0.05, H * 0.06);
  ctx.lineTo(W * 0.52, H * 0.02);
  ctx.lineTo(W * 0.78, H * 0.52);
  ctx.lineTo(W * 0.2, H * 0.62);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(W * 0.58, H * 0.04);
  ctx.lineTo(W * 0.92, H * 0.05);
  ctx.lineTo(W * 0.99, H * 0.46);
  ctx.lineTo(W * 0.84, H * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // A wooden surface across the lower third, with grain.
  const table = ctx.createLinearGradient(0, H * 0.66, 0, H);
  table.addColorStop(0, '#7a5233');
  table.addColorStop(0.5, '#5d3d26');
  table.addColorStop(1, '#3b2717');
  ctx.fillStyle = table;
  ctx.fillRect(0, H * 0.66, W, H * 0.34);
  ctx.strokeStyle = 'rgba(30, 18, 10, 0.28)';
  ctx.lineWidth = 3;
  for (let i = 0; i < 90; i++) {
    const y = H * 0.66 + Math.random() * H * 0.34;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(W * 0.3, y + 14, W * 0.7, y - 14, W, y + 6);
    ctx.stroke();
  }

  // A candle-ish cylinder and its glow — the object the score is "about".
  ctx.save();
  const glow = ctx.createRadialGradient(W * 0.36, H * 0.62, 10, W * 0.36, H * 0.62, W * 0.34);
  glow.addColorStop(0, 'rgba(255, 200, 130, 0.5)');
  glow.addColorStop(1, 'rgba(255, 200, 130, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, H * 0.3, W, H * 0.6);
  ctx.restore();
  ctx.fillStyle = '#efe6d6';
  ctx.fillRect(W * 0.3, H * 0.52, W * 0.12, H * 0.15);
  ctx.fillStyle = '#d8cbb5';
  ctx.fillRect(W * 0.3, H * 0.52, W * 0.03, H * 0.15);
  ctx.fillStyle = '#2b1c10';
  ctx.fillRect(W * 0.355, H * 0.505, 10, H * 0.017);

  // Shelf shadow along the top, so the frame is not just gradients.
  ctx.fillStyle = 'rgba(40, 28, 18, 0.45)';
  ctx.fillRect(0, H * 0.16, W, H * 0.012);

  // Sensor grain — real photos are never clean, and a flat image compresses
  // unrealistically well.
  const noise = ctx.getImageData(0, 0, W, H);
  const data = noise.data;
  for (let i = 0; i < data.length; i += 4) {
    const n = (Math.random() - 0.5) * 26;
    data[i] = Math.min(255, Math.max(0, data[i] + n));
    data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + n));
    data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + n));
  }
  ctx.putImageData(noise, 0, 0);

  return canvas.toDataURL('image/jpeg', 0.92);
});

await browser.close();

const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
writeFileSync(out, bytes);
console.log(`wrote ${out} — ${(bytes.length / 1048576).toFixed(2)} MB, 3024x4032`);
