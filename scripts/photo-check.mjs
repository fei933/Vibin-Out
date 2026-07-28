#!/usr/bin/env node
/**
 * Live verification for the photo input (design doc v2.1 §5).
 *
 *   npm run check:photo
 *
 * First run only:  node scripts/make-fixture-photo.mjs && npx playwright install chromium
 *
 * ONE REAL GENERATION per run — a live vision call and live Spotify lookups —
 * so it is deliberately not part of `npm test`. It exists because three of this
 * feature's claims cannot be proved by the unit suite:
 *
 *   1. the client-side compressor really does get a 3.7MB phone-shaped photo
 *      under the ~1MB cap, in a real browser, on a real canvas;
 *   2. a photo really does produce a score end to end through the real route;
 *   3. the stored document really contains no photo — checked by reading the
 *      document back out of Mongo, not by inspecting the call site.
 *
 * It also captures both themes at 1280 and 390 with a photo attached.
 */
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `--shots` skips the two real generations and only re-captures the screens. */
const shotsOnly = process.argv.includes('--shots');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'documentation', 'fixture-room.jpg');
const SHOTS = path.join(ROOT, '.photo-check');

/** See scripts/e2e.mjs — a stale exported ANTHROPIC_API_KEY must not win. */
function loadEnvFileWithOverride(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    console.error(`[photo] no .env at ${file} — this check needs real credentials.`);
    process.exit(1);
  }
  for (const line of raw.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim().replace(/\s+#.*$/, '');
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) process.env[match[1]] = value;
  }
}

loadEnvFileWithOverride(path.join(ROOT, '.env'));

if (!existsSync(FIXTURE)) {
  console.error(`[photo] no fixture at ${FIXTURE} — run: node scripts/make-fixture-photo.mjs`);
  process.exit(1);
}
mkdirSync(SHOTS, { recursive: true });

const { chromium } = await import('playwright');
const { default: app } = await import('../app.js');
const { scoresCollection } = await import('../db.js');

const failures = [];
let checks = 0;
function check(label, condition, detail = '') {
  checks += 1;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

const originalBytes = readFileSync(FIXTURE).length;
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`\n[photo] app on ${base}`);
console.log(`[photo] fixture: ${(originalBytes / 1048576).toFixed(2)} MB, 3024x4032`);

const browser = await chromium.launch();
let slug = null;
let generationMs = null;
let compressedBytes = null;

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const logs = [];
  page.on('console', (message) => logs.push(message.text()));
  page.on('pageerror', (error) => check('no page errors', false, error.message));

  // ---- 1. compression, in a real browser --------------------------------
  console.log('\n[photo] compression');
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.setInputFiles('#photo', FIXTURE);
  await page.waitForSelector('#photo-preview[data-bytes]', { timeout: 20_000 });

  compressedBytes = Number(await page.getAttribute('#photo-preview', 'data-bytes'));
  const meta = (await page.innerText('#photo-meta')).trim();
  console.log(`        ${meta}`);
  console.log(`        ${logs.filter((l) => l.startsWith('[photo]')).join(' | ')}`);
  check(
    'the compressed photo is under the ~1MB cap',
    compressedBytes > 0 && compressedBytes <= 1000000,
    `${compressedBytes} bytes (from ${originalBytes})`,
  );
  check(
    'compression actually shrank it',
    compressedBytes < originalBytes / 3,
    `${(originalBytes / compressedBytes).toFixed(1)}x smaller`,
  );
  check('the long edge is capped at 1568px', /1176×1568|×1568|1568×/.test(meta), meta);
  check('a preview thumbnail is shown', await page.isVisible('#photo-thumb'));
  check('the drop zone yields to the preview', !(await page.isVisible('#photo-drop')));

  // ---- 2. remove puts it back -------------------------------------------
  await page.click('#photo-remove');
  check('remove clears the photo', !(await page.isVisible('#photo-preview')));
  check('remove restores the drop zone', await page.isVisible('#photo-drop'));

  // ---- 3. one real photo-only generation --------------------------------
  if (shotsOnly) console.log('\n[photo] --shots: skipping the live generations');
  if (!shotsOnly) {
  console.log('\n[photo] generating from the photo alone (real vision + Spotify round trip)');
  await page.setInputFiles('#photo', FIXTURE);
  await page.waitForSelector('#photo-preview[data-bytes]', { timeout: 20_000 });
  await page.locator('input[name="duration"][value="30"]').check();
  await page.locator('input[name="discovery"][value="familiar"]').check();

  const startedAt = Date.now();
  await page.locator('button[type="submit"]').click();
  try {
    await page.waitForSelector('#loading:not([hidden])', { timeout: 15_000 });
  } catch (error) {
    // A submit that refuses is far easier to read from the message the visitor
    // would have seen than from a bare selector timeout.
    const shown = (await page.innerText('#error').catch(() => '')).trim();
    throw new Error(`submit never started${shown ? ` — page said: "${shown}"` : ''}`);
  }
  const waitLine = (await page.innerText('#loading .loading-wait')).trim();
  console.log(`        wait copy: "${waitLine}"`);
  check('the wait copy is set for a photo run', waitLine.length > 0);

  await page.waitForURL(/\/score\/[a-z0-9-]+$/, { timeout: 240_000 });
  generationMs = Date.now() - startedAt;
  slug = new URL(page.url()).pathname.replace('/score/', '');
  console.log(`\n[photo] /score/${slug} in ${(generationMs / 1000).toFixed(1)}s`);

  const title = (await page.innerText('#score h1')).trim();
  const interpretation = (await page.innerText('#score .interpretation')).trim();
  console.log(`        title:          ${title}`);
  console.log(`        interpretation: ${interpretation}`);
  check('the score has a title', title.length > 0);
  check('the score has an interpretation of the room', interpretation.length > 0);
  check(
    'the interpretation reads the space, not the file',
    !/photo|image|picture|jpeg/i.test(interpretation),
    interpretation,
  );

  const tracks = await page.locator('#score li.track').count();
  const embeds = await page.locator('#score iframe[src*="open.spotify.com/embed/track/"]').count();
  check('tracks resolved and rendered', tracks > 0, `${tracks} tracks`);
  check('every track has an embed', embeds === tracks, `${embeds} embeds`);
  check(
    'three phases render',
    (await page.locator('section.phase').count()) === 3,
  );

  // ---- 4. nothing photographic was persisted ----------------------------
  console.log('\n[photo] the stored document');
  const scores = await scoresCollection();
  const doc = await scores.findOne({ slug });
  const serialized = JSON.stringify(doc);
  check('the score was stored', Boolean(doc));
  check('the document has no data URL', !serialized.includes('base64'), '');
  check('the document has no photo field', doc && !('photo' in doc));
  check('the document is marked as a photo run', doc?.fromPhoto === true);
  check('the stored input is the marker', doc?.input === '(from a photo)', String(doc?.input));
  console.log(
    `        keys: ${Object.keys(doc ?? {}).join(', ')} · ${serialized.length} bytes on disk`,
  );

  // ---- 5. remix of a photo score still works ----------------------------
  console.log('\n[photo] remix of a photo score (a second real generation)');
  const remix = await fetch(`${base}/api/score`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ remix: slug }),
  });
  const remixBody = await remix.json();
  check(
    'a photo score can be remixed without its photo',
    remix.status === 200 && Boolean(remixBody.slug),
    JSON.stringify(remixBody),
  );
  if (remixBody.slug) {
    const remixed = await scores.findOne({ slug: remixBody.slug });
    check('the remix is a text run', remixed?.fromPhoto === false);
    console.log(`        remix input: ${String(remixed?.input).slice(0, 120)}…`);
  }
  }

  // ---- 6. both themes, both widths ---------------------------------------
  console.log('\n[photo] screenshots');
  for (const theme of ['light', 'dark']) {
    for (const [name, width, height] of [
      ['desktop', 1280, 900],
      ['mobile', 390, 844],
    ]) {
      const shot = await browser.newPage({ viewport: { width, height } });
      await shot.goto(base, { waitUntil: 'domcontentloaded' });
      await shot.evaluate((t) => localStorage.setItem('vibin-theme', t), theme);
      await shot.reload({ waitUntil: 'networkidle' });
      await shot.screenshot({ path: path.join(SHOTS, `${theme}-${name}-empty.png`) });
      await shot.setInputFiles('#photo', FIXTURE);
      await shot.waitForSelector('#photo-preview[data-bytes]', { timeout: 20_000 });
      await shot.screenshot({ path: path.join(SHOTS, `${theme}-${name}-loaded.png`) });
      await shot.close();
    }
  }
  console.log(`        wrote 8 screenshots to ${SHOTS}`);
} catch (error) {
  console.log(`\n  FAIL  unhandled — ${error?.message}`);
  failures.push(`unhandled: ${error?.message}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  const { disconnect } = await import('../db.js');
  await disconnect().catch(() => {});
}

console.log(`\n${'-'.repeat(60)}`);
console.log(`checks: ${checks}   failures: ${failures.length}`);
if (slug) console.log(`score:  /score/${slug} (${(generationMs / 1000).toFixed(1)}s)`);
if (compressedBytes) {
  console.log(
    `photo:  ${originalBytes} -> ${compressedBytes} bytes ` +
      `(${(compressedBytes / 1024).toFixed(0)} KB, ${(originalBytes / compressedBytes).toFixed(1)}x)`,
  );
}
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  console.log('\nPHOTO CHECK FAILED');
  process.exit(1);
}
console.log('\nPHOTO CHECK PASSED');
process.exit(0);
