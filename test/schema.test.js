import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWeights,
  quotaFor,
  scoreSchema,
  totalQuota,
  TRACK_QUOTAS,
} from '../lib/schema.js';

function phase(name, trackCount, weight) {
  return {
    name,
    scentNotes: `${name} notes`,
    weight,
    tracks: Array.from({ length: trackCount }, (_, i) => ({
      title: `${name} track ${i}`,
      artist: `${name} artist ${i}`,
      why: 'A sensory line.',
    })),
  };
}

function validScore(overrides = {}) {
  return {
    refused: false,
    title: 'Rain Through Cedar',
    interpretation: 'Cool mineral air settling into dry wood.',
    phases: [phase('top', 3, 0.25), phase('heart', 5, 0.45), phase('base', 4, 0.3)],
    ...overrides,
  };
}

test('quota table matches the duration pills', () => {
  assert.deepEqual(quotaFor(30), TRACK_QUOTAS[30]);
  assert.equal(totalQuota(30), 8);
  assert.equal(totalQuota(60), 12);
  assert.equal(totalQuota(90), 18);
  assert.throws(() => quotaFor(45));
});

test('scoreSchema accepts a well-formed score', () => {
  assert.equal(scoreSchema.safeParse(validScore()).success, true);
});

test('scoreSchema rejects the wrong number of phases and the wrong order', () => {
  const twoPhases = validScore({ phases: [phase('top', 2, 0.5), phase('base', 2, 0.5)] });
  assert.equal(scoreSchema.safeParse(twoPhases).success, false);

  const outOfOrder = validScore({
    phases: [phase('heart', 3, 0.3), phase('top', 3, 0.3), phase('base', 3, 0.4)],
  });
  assert.equal(scoreSchema.safeParse(outOfOrder).success, false);
});

test('scoreSchema rejects an empty phase and a missing refused flag', () => {
  const emptyPhase = validScore({
    phases: [phase('top', 0, 0.25), phase('heart', 5, 0.45), phase('base', 4, 0.3)],
  });
  assert.equal(scoreSchema.safeParse(emptyPhase).success, false);

  const noFlag = validScore();
  delete noFlag.refused;
  assert.equal(scoreSchema.safeParse(noFlag).success, false);
});

test('scoreSchema accepts a refusal, which carries no phases', () => {
  const refusal = {
    refused: true,
    title: 'Not for us',
    interpretation: 'This one is not for us.',
    phases: [],
  };
  const parsed = scoreSchema.safeParse(refusal);
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.refused, true);
});

test('normalizeWeights rescales to sum 1 and survives an all-zero score', () => {
  const rescaled = normalizeWeights([
    { name: 'top', weight: 1 },
    { name: 'heart', weight: 2 },
    { name: 'base', weight: 1 },
  ]);
  assert.deepEqual(
    rescaled.map((p) => p.weight),
    [0.25, 0.5, 0.25],
  );

  const zeroed = normalizeWeights([{ weight: 0 }, { weight: 0 }]);
  assert.deepEqual(
    zeroed.map((p) => p.weight),
    [0.5, 0.5],
  );
});
