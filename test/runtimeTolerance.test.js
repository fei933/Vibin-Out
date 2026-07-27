/**
 * Runtime honesty (design doc: "score targets the pill's minutes ±20%").
 *
 * Judging completeness by track count alone lets twelve three-minute records
 * pass as a 60-minute score at 36 real minutes. These tests hold the pipeline
 * to the clock, not the count.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateScore,
  MAX_RUNTIME_TOPUP_PER_PHASE,
  phaseTargets,
  runtimeBounds,
  RUNTIME_TOLERANCE,
} from '../lib/generateScore.js';
import { quotaFor } from '../lib/schema.js';

const MIN = 60_000;

function phasesWithDurations(durationMs, counts = { top: 3, heart: 5, base: 4 }) {
  const weights = { top: 0.25, heart: 0.45, base: 0.3 };
  return ['top', 'heart', 'base'].map((name) => ({
    name,
    scentNotes: `${name} notes`,
    weight: weights[name],
    tracks: Array.from({ length: counts[name] }, (_, i) => ({
      title: `${name} ${i}`,
      artist: `${name} artist ${i}`,
      why: 'w',
      durationMs,
    })),
  }));
}

test('runtimeBounds is the pill ±20%', () => {
  assert.equal(RUNTIME_TOLERANCE, 0.2);
  assert.deepEqual(runtimeBounds(60), { target: 60 * MIN, min: 48 * MIN, max: 72 * MIN });
  assert.deepEqual(runtimeBounds(30), { target: 30 * MIN, min: 24 * MIN, max: 36 * MIN });
});

test('a full-count score of short records is still short, and asks for more', () => {
  // 12 tracks x 3 min = 36 min against a 60-minute pill: inside quota, well
  // outside tolerance.
  const targets = phaseTargets(phasesWithDurations(3 * MIN), 60);
  const quota = quotaFor(60);

  const totalTarget = targets.top + targets.heart + targets.base;
  assert.ok(totalTarget > 12, `expected a top-up above the quota, got ${totalTarget}`);
  assert.ok(targets.heart > quota.heart, 'the heaviest phase absorbs the top-up first');
  assert.ok(
    targets.heart - quota.heart <= MAX_RUNTIME_TOPUP_PER_PHASE,
    'a top-up cannot stretch one phase without limit',
  );
});

test('a score already inside tolerance is left at its quota', () => {
  // 12 tracks x 4.5 min = 54 min: comfortably within 48-72.
  assert.deepEqual(phaseTargets(phasesWithDurations(4.5 * MIN), 60), quotaFor(60));
});

test('running long is accepted and never trimmed', () => {
  // 12 tracks x 7 min = 84 min, above the +20% bound.
  assert.deepEqual(
    phaseTargets(phasesWithDurations(7 * MIN), 60),
    quotaFor(60),
    'the upper bound is a note, not a trim',
  );
});

/** Resolver double that stamps a fixed duration on every resolved track. */
function resolverWithDuration(durationMs) {
  return {
    async resolve(candidates) {
      return {
        tracks: candidates.map((c, i) => ({
          ...c,
          spotifyId: `sp-${c.title}-${i}`,
          popularity: 30,
          durationMs,
          indie: true,
        })),
        misses: [],
        partial: false,
      };
    },
  };
}

function modelScore(counts = { top: 3, heart: 5, base: 4 }) {
  return {
    refused: false,
    title: 'Rain Through Cedar',
    interpretation: 'Cool mineral air settling into dry wood.',
    phases: phasesWithDurations(0, counts).map((p) => ({
      ...p,
      tracks: p.tracks.map(({ durationMs, ...t }) => t),
    })),
  };
}

test('a quota-complete but clock-short score still triggers a backfill', async () => {
  const prompts = [];
  let calls = 0;

  const result = await generateScore(
    { input: 'cedar', duration: 60, discovery: 'balanced' },
    {
      callModel: async ({ prompt }) => {
        calls += 1;
        prompts.push(prompt);
        if (calls === 1) return modelScore();
        return { phases: [{ name: 'heart', tracks: [] }] };
      },
      // Every proposal resolves — nothing is missing by count — but each
      // record is only 2.5 minutes, so the score is 30 min, not ~60.
      resolver: resolverWithDuration(2.5 * MIN),
    },
  );

  assert.equal(calls, 2, 'a full track count must not suppress the backfill');
  assert.match(prompts[1], /STILL NEEDED/);
  assert.equal(result.trackCount, 12);
  assert.equal(result.runtimeShort, true);
  assert.equal(result.short, true, 'the page must say this came out shorter than usual');
  assert.equal(result.runtimeMs, 12 * 2.5 * MIN);
  assert.equal(result.targetRuntimeMs, 60 * MIN);
});

test('a score inside tolerance is neither short nor backfilled', async () => {
  let calls = 0;
  const result = await generateScore(
    { input: 'cedar', duration: 60, discovery: 'balanced' },
    {
      callModel: async () => {
        calls += 1;
        return modelScore();
      },
      resolver: resolverWithDuration(4.5 * MIN),
    },
  );

  assert.equal(calls, 1);
  assert.equal(result.runtimeShort, false);
  assert.equal(result.short, false);
});

test('a score running long is complete, not short', async () => {
  const result = await generateScore(
    { input: 'cedar', duration: 30, discovery: 'balanced' },
    {
      callModel: async () => modelScore(quotaFor(30)),
      resolver: resolverWithDuration(8 * MIN), // 8 x 8 = 64 min against a 30-min pill
    },
  );
  assert.equal(result.runtimeShort, false);
  assert.equal(result.short, false);
  assert.ok(result.runtimeMs > runtimeBounds(30).max, 'deliberately over the upper bound');
});
