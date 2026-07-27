#!/usr/bin/env node
/**
 * The ten-fixture eval — design-doc build step 3.5, the product go/no-go gate.
 *
 * Runs the fixture scents through `generateScore` DIRECTLY, bypassing the HTTP
 * route: ten generations would blow the 5-per-IP-per-hour rate limit, and the
 * limiter is not what this is testing. Scores are persisted through the real
 * store, so every fixture is viewable at /score/<slug> afterwards.
 *
 * What this harness can and cannot judge:
 *   MECHANICAL (automated here) — duplicate artists, dead embeds, runtime
 *     against the pill, track count against quota, indie counts, phase order
 *     and weights, model-call budget, wall time.
 *   HUMAN (deliberately NOT verdicted here) — incoherent sequencing and
 *     generic explanations. The markdown report prints every tracklist and
 *     every `why` line precisely so a person can judge those two.
 *
 * Usage — note the env dance. A stale ANTHROPIC_API_KEY is exported into the
 * shell and dotenv will not override an existing variable, so it must be
 * unset for the one in .env to win:
 *
 *   env -u ANTHROPIC_API_KEY node --env-file=.env scripts/eval.mjs
 *   env -u ANTHROPIC_API_KEY node --env-file=.env scripts/eval.mjs 3 7
 *
 * Passing fixture numbers re-runs only those and merges them into the existing
 * report, which keeps prompt-tuning iterations cheap.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { generateScore, runtimeBounds } from '../lib/generateScore.js';
import { normalizeName, splitArtists } from '../lib/matchVerification.js';
import { saveScore } from '../lib/scoreStore.js';
import { PHASE_ORDER, quotaFor, totalQuota } from '../lib/schema.js';
import { mapWithConcurrency, MAX_TRACK_DURATION_MS } from '../lib/trackResolver.js';
import { disconnect } from '../db.js';

const OUT_DIR =
  process.env.EVAL_OUT_DIR ||
  '/private/tmp/claude-501/-Users-feief-Vibin-Out/7ea9e78a-4d84-4877-b6ea-7e3f04185da8/scratchpad/eval';

const OEMBED = 'https://open.spotify.com/oembed?url=https://open.spotify.com/track/';
const OEMBED_CONCURRENCY = 4;

/**
 * The ten scents from the design doc. Pills are spread deliberately:
 * 30/60/90 x familiar/balanced/deepcuts, so the quota table, the runtime
 * tolerance and the discovery dial all get exercised.
 */
const FIXTURES = [
  { name: 'citrus cologne', input: 'bright citrus cologne — bergamot, lemon peel, a clean shave', duration: 30, discovery: 'familiar' },
  { name: 'vanilla candle', input: 'vanilla candle, warm sugar, a little butter and tonka bean', duration: 60, discovery: 'balanced' },
  { name: 'smoky oud', input: 'smoky oud, charred cedar, incense smoke and a little leather', duration: 90, discovery: 'deepcuts' },
  { name: 'oceanic soap', input: 'ocean soap — cold salt air, wet stone, clean cotton drying outside', duration: 30, discovery: 'balanced' },
  { name: 'espresso beans', input: 'freshly ground espresso beans, dark chocolate, steamed milk', duration: 60, discovery: 'familiar' },
  { name: 'floral perfume', input: 'a classic floral perfume — jasmine, rose absolute, powdery iris', duration: 90, discovery: 'balanced' },
  { name: 'petrichor', input: 'petrichor — hot pavement after the first rain, wet earth, green leaves', duration: 60, discovery: 'deepcuts' },
  { name: 'incense', input: 'temple incense, frankincense and myrrh, cold stone, old wood smoke', duration: 30, discovery: 'deepcuts' },
  { name: 'vintage leather', input: 'vintage leather jacket — worn hide, tobacco, a trace of someone else’s cologne', duration: 90, discovery: 'familiar' },
  { name: 'weird combo', input: 'gasoline, strawberries, and old library books', duration: 60, discovery: 'balanced' },
];

const artistKey = (artist) => normalizeName(splitArtists(artist)[0] ?? artist);
const minutes = (ms) => Math.round((ms / 60000) * 10) / 10;

async function checkEmbeds(tracks) {
  const results = await mapWithConcurrency(tracks, OEMBED_CONCURRENCY, async (track) => {
    try {
      const response = await fetch(`${OEMBED}${track.spotifyId}`, {
        signal: AbortSignal.timeout(15_000),
      });
      return { spotifyId: track.spotifyId, title: track.title, status: response.status, alive: response.status === 200 };
    } catch (error) {
      return { spotifyId: track.spotifyId, title: track.title, status: null, alive: false, error: String(error?.message || error) };
    }
  });
  return results;
}

/** Every mechanical criterion, evaluated against one finished score. */
async function runChecks(fixture, result) {
  const allTracks = result.phases.flatMap((p) => p.tracks);
  const quota = quotaFor(fixture.duration);
  const bounds = runtimeBounds(fixture.duration);

  // (1) duplicate artists anywhere in the score
  const seen = new Map();
  const duplicateArtists = [];
  for (const track of allTracks) {
    const key = artistKey(track.artist);
    if (seen.has(key)) duplicateArtists.push({ artist: track.artist, alsoAs: seen.get(key) });
    else seen.set(key, track.artist);
  }

  // (2) dead embeds
  const embeds = await checkEmbeds(allTracks);
  const deadEmbeds = embeds.filter((e) => !e.alive);

  // (3) runtime against the pill
  const runtimeOk = result.runtimeMs >= bounds.min;

  // (4) counts against quota
  const perPhaseCounts = result.phases.map((p) => ({
    name: p.name,
    got: p.tracks.length,
    quota: quota[p.name],
  }));

  // (5) indie finds — listed with artist popularity so a mislabelled famous
  // artist is visible rather than buried in a count.
  const indieTracks = allTracks.filter((t) => t.indie);
  const indieCount = indieTracks.length;

  // (7) duplicate song titles, including covers by a different artist
  const seenTitles = new Map();
  const duplicateTitles = [];
  for (const track of allTracks) {
    const key = normalizeName(track.title);
    if (seenTitles.has(key)) duplicateTitles.push({ title: track.title, artists: [seenTitles.get(key), track.artist] });
    else seenTitles.set(key, track.artist);
  }

  // (8) single-track length cap
  const overLong = allTracks
    .filter((t) => t.durationMs > MAX_TRACK_DURATION_MS)
    .map((t) => ({ title: t.title, artist: t.artist, minutes: minutes(t.durationMs) }));

  // (6) structure
  const order = result.phases.map((p) => p.name);
  const orderOk = order.join(',') === PHASE_ORDER.join(',');
  const weightSum = result.phases.reduce((sum, p) => sum + p.weight, 0);
  const weightsOk = Math.abs(weightSum - 1) < 0.02;

  return {
    duplicateArtists: { pass: duplicateArtists.length === 0, offenders: duplicateArtists },
    deadEmbeds: { pass: deadEmbeds.length === 0, checked: embeds.length, dead: deadEmbeds },
    runtime: {
      pass: runtimeOk,
      actualMinutes: minutes(result.runtimeMs),
      targetMinutes: fixture.duration,
      minMinutes: minutes(bounds.min),
      maxMinutes: minutes(bounds.max),
      overUpperBound: result.runtimeMs > bounds.max,
      shortNoteFired: Boolean(result.short),
      runtimeShort: Boolean(result.runtimeShort),
      partial: Boolean(result.partial),
    },
    trackCount: {
      pass: result.trackCount >= totalQuota(fixture.duration),
      got: result.trackCount,
      quota: totalQuota(fixture.duration),
      perPhase: perPhaseCounts,
    },
    duplicateTitles: { pass: duplicateTitles.length === 0, offenders: duplicateTitles },
    overLongTracks: { pass: overLong.length === 0, offenders: overLong, capMinutes: minutes(MAX_TRACK_DURATION_MS) },
    indie: {
      count: indieCount,
      of: allTracks.length,
      discovery: fixture.discovery,
      grounded: Boolean(result.indieGrounded),
      badged: indieTracks.map((t) => ({
        artist: t.artist,
        title: t.title,
        trackPopularity: t.popularity,
        artistPopularity: t.artistPopularity ?? null,
      })),
    },
    structure: { pass: orderOk && weightsOk, order, weightSum: Math.round(weightSum * 1000) / 1000 },
    budget: {
      pass: result.modelCalls <= 3,
      modelCalls: result.modelCalls,
      backfilled: Boolean(result.backfilled),
    },
  };
}

function mechanicalVerdict(checks) {
  // Runtime is reported, not gated: the design doc says aim for +/-20% and
  // accept-and-note otherwise, so a short-but-honest score is not a failure.
  const gates = [
    checks.duplicateArtists.pass,
    checks.duplicateTitles.pass,
    checks.overLongTracks.pass,
    checks.deadEmbeds.pass,
    checks.structure.pass,
    checks.budget.pass,
  ];
  return gates.every(Boolean) ? 'PASS' : 'FAIL';
}

async function runFixture(index, fixture) {
  const label = `${index}. ${fixture.name} (${fixture.duration}min / ${fixture.discovery})`;
  process.stdout.write(`\n[${new Date().toISOString()}] ${label}\n`);

  const events = [];
  const startedAt = Date.now();
  let result;
  try {
    result = await generateScore(
      { input: fixture.input, duration: fixture.duration, discovery: fixture.discovery },
      { onEvent: (event) => events.push(event) },
    );
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    process.stdout.write(`   FAILED after ${(elapsedMs / 1000).toFixed(1)}s: ${error?.message}\n`);
    return {
      index,
      fixture,
      ok: false,
      error: { code: error?.code ?? null, message: String(error?.message || error) },
      events,
      timing: { generateMs: elapsedMs },
      ranAt: new Date().toISOString(),
    };
  }
  const generateMs = Date.now() - startedAt;

  const persistStart = Date.now();
  let slug = null;
  let persistError = null;
  try {
    ({ slug } = await saveScore({ ...fixture, result }));
  } catch (error) {
    persistError = String(error?.message || error);
  }
  const persistMs = Date.now() - persistStart;

  const checks = await runChecks(fixture, result);
  const verdict = mechanicalVerdict(checks);

  process.stdout.write(
    `   ${verdict} — ${result.trackCount} tracks, ${checks.runtime.actualMinutes}min, ` +
      `${result.modelCalls} model call(s)${result.backfilled ? ' (backfilled)' : ''}, ` +
      `${checks.indie.count} indie, ${(generateMs / 1000).toFixed(1)}s → /score/${slug}\n`,
  );

  return {
    index,
    fixture,
    ok: true,
    slug,
    persistError,
    verdict,
    result,
    checks,
    events,
    timing: { generateMs, persistMs },
    ranAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- reporting

function trackLine(track) {
  const badges = [];
  if (track.indie) badges.push('**indie find**');
  if (typeof track.popularity === 'number') badges.push(`pop ${track.popularity}`);
  if (track.durationMs) badges.push(`${minutes(track.durationMs)}min`);
  return (
    `- **${track.title}** — ${track.artist}` +
    (badges.length ? ` _(${badges.join(', ')})_` : '') +
    `\n  - _"${track.why}"_`
  );
}

function fixtureMarkdown(entry) {
  const { fixture } = entry;
  const head = `## ${entry.index}. ${fixture.name}\n\n` +
    `- **Input:** \`${fixture.input}\`\n` +
    `- **Pills:** ${fixture.duration} min / ${fixture.discovery}\n`;

  if (!entry.ok) {
    return `${head}- **Result:** GENERATION FAILED — \`${entry.error.code || 'error'}\`: ${entry.error.message}\n` +
      `- **Wall time:** ${(entry.timing.generateMs / 1000).toFixed(1)}s\n`;
  }

  // Entries merged from an earlier run predate later checks; render them as
  // "not measured" rather than crashing the whole report.
  const missing = { pass: null, offenders: [], badged: [] };
  const c = { duplicateTitles: missing, overLongTracks: missing, ...entry.checks };
  const mark = (pass) => (pass === null ? 'n/a' : pass ? 'PASS' : 'FAIL');

  const lines = [
    head,
    `- **Slug:** [\`/score/${entry.slug}\`](/score/${entry.slug})\n` +
      `- **Title:** ${entry.result.title}\n` +
      `- **Interpretation:** _${entry.result.interpretation}_\n` +
      `- **Wall time:** ${(entry.timing.generateMs / 1000).toFixed(1)}s generate + ` +
      `${(entry.timing.persistMs / 1000).toFixed(1)}s persist\n`,
    `\n### Mechanical checks — **${entry.verdict}**\n`,
    `| Check | Result | Detail |`,
    `|---|---|---|`,
    `| Duplicate artists | ${mark(c.duplicateArtists.pass)} | ${
      c.duplicateArtists.offenders.length
        ? c.duplicateArtists.offenders.map((o) => `${o.artist} / ${o.alsoAs}`).join('; ')
        : 'none'
    } |`,
    `| Dead embeds | ${mark(c.deadEmbeds.pass)} | ${c.deadEmbeds.dead.length}/${c.deadEmbeds.checked} dead${
      c.deadEmbeds.dead.length ? `: ${c.deadEmbeds.dead.map((d) => `${d.title} (${d.status})`).join('; ')}` : ''
    } |`,
    `| Runtime vs pill | ${c.runtime.pass ? 'within' : 'SHORT'} | ${c.runtime.actualMinutes} min vs ${
      c.runtime.targetMinutes
    } min target (floor ${c.runtime.minMinutes}) · short note fired: ${c.runtime.shortNoteFired} · runtimeShort: ${
      c.runtime.runtimeShort
    } |`,
    `| Track count vs quota | ${c.trackCount.pass ? 'met' : 'under'} | ${c.trackCount.got}/${
      c.trackCount.quota
    } (${c.trackCount.perPhase.map((p) => `${p.name} ${p.got}/${p.quota}`).join(', ')}) |`,
    `| Duplicate titles | ${mark(c.duplicateTitles.pass)} | ${
      c.duplicateTitles.offenders.length
        ? c.duplicateTitles.offenders.map((o) => `"${o.title}" (${o.artists.join(' / ')})`).join('; ')
        : 'none'
    } |`,
    `| Over-long tracks | ${mark(c.overLongTracks.pass)} | ${
      c.overLongTracks.offenders.length
        ? c.overLongTracks.offenders.map((o) => `${o.title} — ${o.artist} (${o.minutes}min)`).join('; ')
        : `none over ${c.overLongTracks.capMinutes ?? '?'}min`
    } |`,
    `| Indie finds | — | ${c.indie.count}/${c.indie.of} tracks (discovery: ${c.indie.discovery}, artist-grounded: ${
      c.indie.grounded ?? false
    })${
      (c.indie.badged ?? []).length
        ? `<br>${c.indie.badged
            .map((b) => `${b.artist} — track ${b.trackPopularity}, artist ${b.artistPopularity ?? '?'}`)
            .join('<br>')}`
        : ''
    } |`,
    `| Phase order + weights | ${mark(c.structure.pass)} | ${c.structure.order.join(' → ')}, weights sum ${
      c.structure.weightSum
    } |`,
    `| Model-call budget | ${mark(c.budget.pass)} | ${c.budget.modelCalls}/3${
      c.budget.backfilled ? ' (backfill used)' : ''
    } |`,
    `\n### Tracklist\n`,
  ];

  for (const phase of entry.result.phases) {
    lines.push(
      `\n**${phase.name}** — ${phase.scentNotes} _(weight ${Math.round(phase.weight * 100)}%)_\n`,
    );
    lines.push(phase.tracks.map(trackLine).join('\n') || '_(no tracks)_');
  }

  return `${lines.join('\n')}\n`;
}

function buildMarkdown(entries) {
  const ran = entries.filter((e) => e.ok);
  const failed = entries.filter((e) => !e.ok);
  const passes = ran.filter((e) => e.verdict === 'PASS');

  const summaryRows = entries.map((e) => {
    if (!e.ok) {
      return `| ${e.index} | ${e.fixture.name} | ${e.fixture.duration}/${e.fixture.discovery} | ERROR | — | — | — | — | — |`;
    }
    return (
      `| ${e.index} | ${e.fixture.name} | ${e.fixture.duration}/${e.fixture.discovery} | ${e.verdict} | ` +
      `${e.checks.trackCount.got}/${e.checks.trackCount.quota} | ${e.checks.runtime.actualMinutes}min | ` +
      `${e.checks.deadEmbeds.dead.length} | ${e.checks.indie.count} | ${e.checks.budget.modelCalls}${
        e.checks.budget.backfilled ? '+bf' : ''
      } |`
    );
  });

  const byDiscovery = {};
  for (const e of ran) {
    const key = e.fixture.discovery;
    byDiscovery[key] ??= { indie: 0, tracks: 0, scores: 0 };
    byDiscovery[key].indie += e.checks.indie.count;
    byDiscovery[key].tracks += e.checks.indie.of;
    byDiscovery[key].scores += 1;
  }

  const times = ran.map((e) => e.timing.generateMs);
  const timing = times.length
    ? {
        min: Math.min(...times),
        max: Math.max(...times),
        mean: times.reduce((a, b) => a + b, 0) / times.length,
      }
    : null;

  return [
    `# Ten-fixture eval — Vibin' Out, the Drydown Score`,
    ``,
    `Design-doc build step 3.5. Generated ${new Date().toISOString()}.`,
    ``,
    `**Mechanical result: ${passes.length}/${entries.length} PASS** (${failed.length} generation failure(s)).`,
    ``,
    `The two human-judged criteria — incoherent sequencing and generic explanations —`,
    `are deliberately **not** verdicted here. Every tracklist and every \`why\` line is`,
    `printed below as the material for that judgement.`,
    ``,
    `## Summary`,
    ``,
    `| # | Fixture | Pills | Mech. | Tracks | Runtime | Dead | Indie | Calls |`,
    `|---|---|---|---|---|---|---|---|---|`,
    ...summaryRows,
    ``,
    `### Discovery dial sanity`,
    ``,
    `| Mode | Scores | Indie finds | Share |`,
    `|---|---|---|---|`,
    ...Object.entries(byDiscovery).map(
      ([mode, s]) =>
        `| ${mode} | ${s.scores} | ${s.indie}/${s.tracks} | ${
          s.tracks ? Math.round((s.indie / s.tracks) * 100) : 0
        }% |`,
    ),
    ``,
    timing
      ? `### Timing\n\nGenerate wall time — min ${(timing.min / 1000).toFixed(1)}s, mean ${(
          timing.mean / 1000
        ).toFixed(1)}s, max ${(timing.max / 1000).toFixed(1)}s (design-doc target: <20s).`
      : '',
    ``,
    `---`,
    ``,
    ...entries.map(fixtureMarkdown),
  ].join('\n');
}

// --------------------------------------------------------------------- main

async function main() {
  const requested = process.argv
    .slice(2)
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= FIXTURES.length);
  const indexes = requested.length ? requested : FIXTURES.map((_, i) => i + 1);

  await fs.mkdir(OUT_DIR, { recursive: true });
  const jsonPath = path.join(OUT_DIR, 'report.json');
  const mdPath = path.join(OUT_DIR, 'report.md');

  // Merge with any previous run so a partial re-run keeps the rest of the report.
  let previous = {};
  try {
    previous = JSON.parse(await fs.readFile(jsonPath, 'utf8')).fixtures ?? {};
  } catch {
    previous = {};
  }

  process.stdout.write(`Running fixtures: ${indexes.join(', ')}\n`);
  for (const index of indexes) {
    // Sequential on purpose: ten parallel scores would hammer Spotify's token
    // and search limits and produce a rate-limit artefact, not an eval.
    previous[index] = await runFixture(index, FIXTURES[index - 1]);
  }

  const entries = Object.keys(previous)
    .map(Number)
    .sort((a, b) => a - b)
    .map((i) => previous[i]);

  await fs.writeFile(
    jsonPath,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), fixtures: previous }, null, 2)}\n`,
  );
  await fs.writeFile(mdPath, buildMarkdown(entries));

  process.stdout.write(`\nReports:\n  ${jsonPath}\n  ${mdPath}\n`);
  await disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await disconnect().catch(() => {});
  process.exit(1);
});
