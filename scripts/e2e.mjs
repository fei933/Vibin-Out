#!/usr/bin/env node
/**
 * End-to-end test — design-doc build step 5.
 *
 *   npm run test:e2e
 *
 * First run only:  npx playwright install chromium
 *
 * Boots the real Express app on an ephemeral port with the real .env, drives a
 * real browser through the real pipeline, and checks the page a stranger would
 * actually land on. That means ONE REAL GENERATION per run — a live LLM call
 * and live Spotify lookups. It is deliberately NOT part of `npm test`: the
 * unit suite stays env-free, offline and instant.
 *
 * The fixture is the cheapest one available (30 min / familiar, ~8 tracks) to
 * keep a run near 20-35s rather than the ~2 minutes a 90-minute score costs.
 *
 * Exits non-zero with a readable summary if any assertion fails.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Load .env with OVERRIDE.
 *
 * This is not paranoia. A stale ANTHROPIC_API_KEY is exported into the shell
 * (from ~/.claude/settings.json), and neither dotenv nor `node --env-file`
 * overrides a variable that already exists — so the dead key silently wins and
 * every generation fails authentication. Reading the file ourselves and
 * assigning unconditionally makes this harness immune to that, so
 * `npm run test:e2e` works from any shell.
 */
function loadEnvFileWithOverride(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    console.error(`[e2e] no .env at ${file} — this test needs real credentials.`);
    process.exit(1);
  }
  for (const line of raw.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key] = match;
    let value = match[2].trim().replace(/\s+#.*$/, '');
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) process.env[key] = value; // override, deliberately
  }
}

loadEnvFileWithOverride(path.join(ROOT, '.env'));

const { chromium } = await import('playwright');
const { default: app } = await import('../app.js');

// ----------------------------------------------------------------- assertions

const failures = [];
const warnings = [];
let checks = 0;

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function warn(label, detail) {
  console.log(`  WARN  ${label} — ${detail}`);
  warnings.push(`${label} — ${detail}`);
}

// ----------------------------------------------------------------------- main

const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;
console.log(`\n[e2e] app listening on ${base}`);

const browser = await chromium.launch();
let slug = null;
let generationMs = null;

try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => warn('browser console', `page error: ${error.message}`));

  // ---- 1. the home page -------------------------------------------------
  console.log('\n[e2e] home page');
  const homeResponse = await page.goto(base, { waitUntil: 'domcontentloaded' });
  check('GET / returns 200', homeResponse.status() === 200, `got ${homeResponse.status()}`);

  const textarea = page.locator('textarea[name="input"]');
  check('the scent textarea is present', (await textarea.count()) === 1);
  check(
    'duration pills offer 30/60/90',
    (await page.locator('input[name="duration"]').count()) === 3,
  );
  check(
    'discovery pills offer three modes',
    (await page.locator('input[name="discovery"]').count()) === 3,
  );
  check('a submit button is present', (await page.locator('button[type="submit"]').count()) >= 1);

  // ---- 2. submit the cheapest possible score ----------------------------
  console.log('\n[e2e] generating a score (this is a real LLM + Spotify round trip)');
  await textarea.fill('bright citrus cologne — bergamot, lemon peel, a clean shave');
  await page.locator('input[name="duration"][value="30"]').check();
  await page.locator('input[name="discovery"][value="familiar"]').check();

  const startedAt = Date.now();
  await page.locator('button[type="submit"]').click();

  // ---- 3. the loading state ---------------------------------------------
  const loading = page.locator('#loading');
  await loading.waitFor({ state: 'visible', timeout: 15_000 });
  check('the loading state appears on submit', await loading.isVisible());
  check(
    'the loading state says it is distilling',
    /distilling/i.test((await loading.innerText()) || ''),
  );

  const waitLine = page.locator('#loading .loading-wait');
  if ((await waitLine.count()) === 0) {
    warn('duration-aware second line', 'no .loading-wait element in the loading state yet');
  } else {
    const waitText = (await waitLine.innerText()).trim();
    if (!waitText) {
      warn('duration-aware second line', '.loading-wait is present but empty');
    } else {
      check(
        'the loading state sets expectations about the wait',
        waitText.length > 0,
        `text: "${waitText}"`,
      );
      console.log(`        second line: "${waitText}"`);
    }
  }

  // ---- 4. navigation to the score ---------------------------------------
  await page.waitForURL(/\/score\/[a-z0-9-]+$/, { timeout: 240_000 });
  generationMs = Date.now() - startedAt;
  slug = new URL(page.url()).pathname.replace('/score/', '');
  console.log(`\n[e2e] generated /score/${slug} in ${(generationMs / 1000).toFixed(1)}s`);
  check('the browser lands on a /score/<slug> URL', Boolean(slug));

  // ---- 5. the score page -------------------------------------------------
  console.log('\n[e2e] score page');
  const title = (await page.locator('#score h1').innerText()).trim();
  check('the score has a title', title.length > 0, `title: "${title}"`);
  check(
    'the score has an interpretation',
    (await page.locator('#score .interpretation').innerText()).trim().length > 0,
  );

  const phaseNames = await page.locator('section.phase').evaluateAll((sections) =>
    sections.map((section) =>
      (section.className.match(/phase-(top|heart|base)/) || [])[1] ?? '?',
    ),
  );
  check(
    'three phases render in top -> heart -> base order',
    phaseNames.join(',') === 'top,heart,base',
    `got [${phaseNames.join(', ')}]`,
  );

  const embeds = await page.locator('#score iframe[src*="open.spotify.com/embed/track/"]').count();
  check('at least one Spotify embed is on the page', embeds >= 1, `found ${embeds}`);

  const trackCount = await page.locator('#score li.track').count();
  const whyCount = await page.locator('#score li.track .why').count();
  const emptyWhy = await page
    .locator('#score li.track .why')
    .evaluateAll((nodes) => nodes.filter((n) => !n.textContent.trim()).length);
  check('the score has tracks', trackCount > 0, `found ${trackCount}`);
  check(
    'every track carries a sensory "why" line',
    whyCount === trackCount && emptyWhy === 0,
    `${whyCount} why lines for ${trackCount} tracks, ${emptyWhy} empty`,
  );
  check(
    'every track has an embed',
    embeds === trackCount,
    `${embeds} embeds for ${trackCount} tracks`,
  );

  check('a copy-link button is present', (await page.locator('#copy-link').count()) === 1);
  check('a remix button is present', (await page.locator('#remix').count()) === 1);

  // The page must not echo the visitor's raw words (moderation amendment).
  const bodyText = await page.locator('body').innerText();
  check(
    'the page does not echo the raw input verbatim',
    !bodyText.includes('bright citrus cologne — bergamot, lemon peel, a clean shave'),
  );

  // ---- 6. caching + 404, checked off the wire ----------------------------
  console.log('\n[e2e] headers and the 404 path');
  const scoreResponse = await fetch(`${base}/score/${slug}`);
  const cacheControl = scoreResponse.headers.get('cache-control') || '';
  check('GET /score/<slug> returns 200', scoreResponse.status === 200, `got ${scoreResponse.status}`);
  check(
    'scores are cached immutably at the edge',
    cacheControl.includes('immutable') && cacheControl.includes('s-maxage=31536000'),
    `cache-control: "${cacheControl}"`,
  );

  const missing = await fetch(`${base}/score/nonexistent-slug-aaa111`);
  const missingBody = await missing.text();
  check('an unknown slug returns 404', missing.status === 404, `got ${missing.status}`);
  check(
    'the 404 is a friendly page, not a stack trace',
    /no such score|has no scent/i.test(missingBody) && !/at\s+\w+\s+\(/.test(missingBody),
  );
} catch (error) {
  console.log(`\n  FAIL  unhandled error — ${error?.message}`);
  failures.push(`unhandled error: ${error?.message}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  const { disconnect } = await import('../db.js');
  await disconnect().catch(() => {});
}

// --------------------------------------------------------------------- report

console.log(`\n${'-'.repeat(60)}`);
console.log(`checks: ${checks}   failures: ${failures.length}   warnings: ${warnings.length}`);
if (slug) console.log(`score:  /score/${slug} (${(generationMs / 1000).toFixed(1)}s)`);
if (warnings.length) {
  console.log('\nwarnings (not failures):');
  for (const w of warnings) console.log(`  - ${w}`);
}
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  console.log('\nE2E FAILED');
  process.exit(1);
}
console.log('\nE2E PASSED');
process.exit(0);
