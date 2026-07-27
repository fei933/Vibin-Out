import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeAcrossScore,
  DEFAULT_BUDGET_MS,
  generateScore,
  MAX_MODEL_CALLS,
  MODEL_CALL_TIMEOUT_MS,
  RESOLVE_RESERVE_MS,
} from '../lib/generateScore.js';
import { buildBackfillPrompt } from '../lib/prompt.js';
import { ERROR_CODES } from '../lib/errors.js';
import { quotaFor } from '../lib/schema.js';

function phase(name, count, weight, prefix = name) {
  return {
    name,
    scentNotes: `${name} notes`,
    weight,
    tracks: Array.from({ length: count }, (_, i) => ({
      title: `${prefix} ${i}`,
      artist: `${prefix} artist ${i}`,
      why: 'A sensory line.',
    })),
  };
}

/** A full 60-minute score: 3 / 5 / 4. */
function modelScore(overrides = {}) {
  return {
    refused: false,
    title: 'Rain Through Cedar',
    interpretation: 'Cool mineral air settling into dry wood.',
    phases: [phase('top', 3, 0.25), phase('heart', 5, 0.45), phase('base', 4, 0.3)],
    ...overrides,
  };
}

/** Resolver double: resolves everything unless the title is in `failing`. */
function fakeResolver({ failing = new Set(), partial = false } = {}) {
  const seen = [];
  return {
    calls: seen,
    async resolve(candidates) {
      seen.push(candidates);
      const tracks = [];
      const misses = [];
      candidates.forEach((candidate, i) => {
        if (failing.has(candidate.title)) {
          misses.push({ ...candidate, reason: 'miss' });
        } else {
          tracks.push({
            ...candidate,
            spotifyId: `sp-${candidate.title}-${i}`,
            popularity: 30,
            durationMs: 240_000,
            indie: true,
          });
        }
      });
      return { tracks, misses, partial };
    },
  };
}

const REQUEST = { input: 'bergamot, black tea, cedar', duration: 60, discovery: 'balanced' };

test('the happy path makes exactly one model call and fills every phase', async () => {
  let calls = 0;
  const resolver = fakeResolver();
  const result = await generateScore(REQUEST, {
    callModel: async () => {
      calls += 1;
      return modelScore();
    },
    resolver,
  });

  assert.equal(calls, 1);
  assert.equal(result.modelCalls, 1);
  assert.equal(result.trackCount, 12);
  assert.equal(result.short, false);
  assert.equal(result.title, 'Rain Through Cedar');
  assert.deepEqual(
    result.phases.map((p) => p.name),
    ['top', 'heart', 'base'],
  );
  assert.equal(result.runtimeMs, 12 * 240_000);
  assert.equal(result.phases[0].tracks[0].phaseIndex, undefined, 'internal fields are stripped');
});

test('a structural violation earns exactly one retry, then succeeds', async () => {
  const answers = [modelScore({ phases: [phase('top', 3, 1)] }), modelScore()];
  let calls = 0;
  const result = await generateScore(REQUEST, {
    callModel: async () => answers[calls++],
    resolver: fakeResolver(),
  });

  assert.equal(calls, 2);
  assert.equal(result.modelCalls, 2);
  assert.equal(result.trackCount, 12);
});

test('two structural violations in a row fail the generation, never a third try', async () => {
  let calls = 0;
  await assert.rejects(
    generateScore(REQUEST, {
      callModel: async () => {
        calls += 1;
        return modelScore({ phases: [] });
      },
      resolver: fakeResolver(),
    }),
    (error) => error.code === ERROR_CODES.GENERATION_FAILED,
  );
  assert.equal(calls, 2, 'the schema retry is spent once and only once');
});

test('a refusal surfaces as a refused error and never reaches the resolver', async () => {
  const resolver = fakeResolver();
  await assert.rejects(
    generateScore(REQUEST, {
      callModel: async () => ({
        refused: true,
        title: 'Not for us',
        interpretation: 'This one is not for us.',
        phases: [],
      }),
      resolver,
    }),
    (error) => error.code === ERROR_CODES.REFUSED,
  );
  assert.equal(resolver.calls.length, 0);
});

test('a short score triggers exactly one combined backfill, and it is the last call', async () => {
  const failing = new Set(['top 0', 'heart 0', 'heart 1']);
  const prompts = [];
  let calls = 0;

  const result = await generateScore(REQUEST, {
    callModel: async ({ prompt }) => {
      calls += 1;
      prompts.push(prompt);
      if (calls === 1) return modelScore();
      return {
        phases: [
          { name: 'top', tracks: [{ title: 'fill a', artist: 'Fresh A', why: 'w' }] },
          {
            name: 'heart',
            tracks: [
              { title: 'fill b', artist: 'Fresh B', why: 'w' },
              { title: 'fill c', artist: 'Fresh C', why: 'w' },
            ],
          },
        ],
      };
    },
    resolver: fakeResolver({ failing }),
  });

  assert.equal(calls, 2);
  assert.ok(calls <= MAX_MODEL_CALLS);
  assert.equal(result.trackCount, 12, 'backfill restored the score to quota');

  const backfillPrompt = prompts[1];
  assert.match(backfillPrompt, /top phase[^\n]*1 more track/);
  assert.match(backfillPrompt, /top artist 1/, 'surviving artists are excluded');
  assert.match(backfillPrompt, /heart 0 — heart artist 0/, 'failed tracks are excluded');
  // The heart asks for more than its two missing records: nine 4-minute tracks
  // is 36 minutes against a 60-minute pill, so the runtime top-up widens it.
  assert.match(backfillPrompt, /heart phase[^\n]*4 more tracks/);
});

test('a still-short score after backfill renders short rather than failing', async () => {
  const failing = new Set(['top 0', 'heart 0', 'fill a']);
  let calls = 0;
  const result = await generateScore(REQUEST, {
    callModel: async () => {
      calls += 1;
      if (calls === 1) return modelScore();
      return { phases: [{ name: 'top', tracks: [{ title: 'fill a', artist: 'X', why: 'w' }] }] };
    },
    resolver: fakeResolver({ failing }),
  });

  assert.equal(calls, 2);
  assert.equal(result.short, true);
  assert.equal(result.trackCount, 10);
  assert.equal(result.expectedTrackCount, 12);
});

test('a failed backfill call degrades to a short score instead of throwing', async () => {
  let calls = 0;
  const result = await generateScore(REQUEST, {
    callModel: async () => {
      calls += 1;
      if (calls === 1) return modelScore();
      throw new Error('gateway exploded');
    },
    resolver: fakeResolver({ failing: new Set(['base 0']) }),
  });
  assert.equal(result.short, true);
  assert.equal(result.trackCount, 11);
});

test('provider rate limiting yields a partial score, not an error', async () => {
  const result = await generateScore(REQUEST, {
    callModel: async () => modelScore(),
    resolver: fakeResolver({ partial: true }),
    backfillReserveMs: Infinity, // never enough budget left to backfill
  });
  assert.equal(result.partial, true);
});

test('backfill is skipped when the time budget is already spent', async () => {
  let calls = 0;
  const result = await generateScore(REQUEST, {
    callModel: async () => {
      calls += 1;
      return modelScore();
    },
    resolver: fakeResolver({ failing: new Set(['base 0']) }),
    backfillReserveMs: Infinity,
  });
  assert.equal(calls, 1, 'no backfill once the budget is gone');
  assert.equal(result.short, true);
});

/**
 * Regression from the ten-fixture eval: the per-call timeout was derived
 * purely as `remaining budget - reserve`, so a primary call that consumed the
 * budget left the retry a few seconds — guaranteed to time out as well. A
 * single slow call therefore burned both attempts and failed the generation.
 * Eight of the ten fixtures died exactly this way.
 */
test('a slow primary call does not starve its own retry of time', async () => {
  const timeouts = [];
  let clock = 0;
  let calls = 0;

  const result = await generateScore(REQUEST, {
    now: () => clock,
    callModel: async ({ timeoutMs }) => {
      timeouts.push(timeoutMs);
      calls += 1;
      clock += 85_000; // a long, near-ceiling generation
      if (calls === 1) throw new Error('The operation was aborted due to timeout');
      return modelScore();
    },
    resolver: fakeResolver(),
  });

  assert.equal(calls, 2);
  assert.ok(
    timeouts[1] >= 60_000,
    `the retry must get a usable timeout, got ${timeouts[1]}ms`,
  );
  assert.equal(result.trackCount, 12, 'and the retry actually succeeds');
});

test('no model call is ever given an unbounded or near-zero timeout', async () => {
  const timeouts = [];
  let clock = 0;
  await generateScore(REQUEST, {
    now: () => clock,
    callModel: async ({ timeoutMs }) => {
      timeouts.push(timeoutMs);
      clock += 200_000; // blow through nearly the whole budget
      return modelScore();
    },
    resolver: fakeResolver({ failing: new Set(['base 0']) }),
  });

  for (const timeout of timeouts) {
    assert.ok(timeout >= 10_000, `timeout floor violated: ${timeout}ms`);
    assert.ok(timeout <= MODEL_CALL_TIMEOUT_MS, `timeout ceiling violated: ${timeout}ms`);
  }
});

test('the budget fits inside the deployed function ceiling', () => {
  // vercel.json pins maxDuration to 300s (Hobby maximum); the pipeline budget
  // plus its own reserves must leave the platform room to respond.
  assert.ok(DEFAULT_BUDGET_MS <= 240_000, 'budget must stay well inside maxDuration');
  assert.ok(MODEL_CALL_TIMEOUT_MS * 2 + RESOLVE_RESERVE_MS <= DEFAULT_BUDGET_MS);
});

test('dedupeAcrossScore drops repeated artists and ids, earliest phase wins', () => {
  const deduped = dedupeAcrossScore([
    {
      name: 'top',
      tracks: [
        { title: 'a', artist: 'Ana Roxanne', spotifyId: '1' },
        { title: 'b', artist: 'Burial', spotifyId: '2' },
      ],
    },
    {
      name: 'heart',
      tracks: [
        { title: 'c', artist: 'Ana Roxanne & Friends', spotifyId: '3' },
        { title: 'd', artist: 'Four Tet', spotifyId: '2' },
        { title: 'e', artist: 'Four Tet', spotifyId: '4' },
      ],
    },
  ]);

  assert.deepEqual(
    deduped.map((p) => p.tracks.map((t) => t.title)),
    [
      ['a', 'b'],
      ['e'],
    ],
  );
});

test('buildBackfillPrompt lists every exclusion and the exact shortfall', () => {
  const prompt = buildBackfillPrompt({
    input: 'smoky oud',
    duration: 30,
    discovery: 'deepcuts',
    interpretation: 'Charred wood in a cold room.',
    shortfalls: [{ name: 'base', scentNotes: 'oud, ash', needed: 2 }],
    excludedArtists: ['Ana Roxanne', 'Burial'],
    excludedTracks: [{ title: 'Ghost Track', artist: 'Nobody' }],
  });

  assert.match(prompt, /base phase \(oud, ash\): 2 more tracks/);
  assert.match(prompt, /Ana Roxanne; Burial/);
  assert.match(prompt, /Ghost Track — Nobody/);
  assert.match(prompt, /DEEP CUTS/);
  assert.ok(!prompt.includes('smoky oud\nRUNTIME'), 'the raw input stays inside its fence');
});

test('a score where nothing resolves is a failed generation, not an empty page', async () => {
  const everythingFails = {
    async resolve(candidates) {
      return { tracks: [], misses: candidates.map((c) => ({ ...c, reason: 'miss' })), partial: false };
    },
  };
  await assert.rejects(
    generateScore(REQUEST, {
      callModel: async () => modelScore(),
      resolver: everythingFails,
      backfillReserveMs: Infinity,
    }),
    (error) => error.code === ERROR_CODES.GENERATION_FAILED,
  );
});

test('the 90-minute quota is what a 90-minute score is measured against', async () => {
  const request = { ...REQUEST, duration: 90 };
  const quota = quotaFor(90);
  const result = await generateScore(request, {
    callModel: async () => ({
      refused: false,
      title: 'Long Drydown',
      interpretation: 'A slow evaporation.',
      phases: [
        phase('top', quota.top, 0.2),
        phase('heart', quota.heart, 0.5),
        phase('base', quota.base, 0.3),
      ],
    }),
    resolver: fakeResolver(),
  });
  assert.equal(result.expectedTrackCount, 18);
  assert.equal(result.trackCount, 18);
  assert.equal(result.short, false);
});
