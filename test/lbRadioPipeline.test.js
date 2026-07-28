/**
 * The discovery provider inside the generation pipeline.
 *
 * Two properties are load-bearing here and everything else is detail:
 *
 *   1. OFF unless both variables are set — and when it is off, the pipeline is
 *      byte-for-byte the one the ten-fixture eval judged.
 *   2. EVERY failure is silent. There is no LB Radio outcome that a visitor
 *      can see, because the primary call named records as well as tags, so a
 *      fallback always has a complete score in hand.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateCap,
  generateScore,
  MAX_MODEL_CALLS,
  pickSelected,
  poolTargets,
} from '../lib/generateScore.js';
import { LbRadioError } from '../lib/lbRadio.js';
import { buildScorePrompt, buildSystemPrompt } from '../lib/prompt.js';
import { llmScoreSchema, llmScoreWithTagsSchema, quotaFor } from '../lib/schema.js';

// ------------------------------------------------------------------ doubles

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
    discoveryTags: [
      { tag: `${name}-tag`, weight: 3 },
      { tag: 'ambient', weight: 1 },
    ],
  };
}

/** A full 60-minute score: 3 / 5 / 4, each phase carrying tags. */
function modelScore(overrides = {}) {
  return {
    refused: false,
    title: 'Rain Through Cedar',
    interpretation: 'Cool mineral air settling into dry wood.',
    phases: [phase('top', 3, 0.25), phase('heart', 5, 0.45), phase('base', 4, 0.3)],
    ...overrides,
  };
}

/** Resolves anything, with the durations a 60-minute score needs. */
function fakeResolver({ failing = new Set(), partial = false, durationMs = 240_000 } = {}) {
  const calls = [];
  return {
    calls,
    async resolve(candidates) {
      calls.push(candidates);
      const tracks = [];
      const misses = [];
      candidates.forEach((candidate, i) => {
        if (failing.has(candidate.title)) misses.push({ ...candidate, reason: 'miss' });
        else
          tracks.push({
            ...candidate,
            spotifyId: `sp-${candidate.title}-${i}`,
            popularity: 12,
            durationMs,
            indie: true,
          });
      });
      return { tracks, misses, partial };
    },
  };
}

/** LB Radio double: 15 candidates per phase unless told otherwise. */
function fakeLbRadio({ perPhase = 15, fail = null, empty = false } = {}) {
  const asked = [];
  return {
    asked,
    enabled: true,
    async tracksForTags(tags) {
      asked.push(tags);
      if (fail) throw fail;
      if (empty) return [];
      const seed = tags[0]?.tag ?? 'x';
      return Array.from({ length: perPhase }, (_, i) => ({
        title: `${seed} record ${i}`,
        artist: `${seed} band ${i}`,
        recordingMbid: null,
      }));
    },
  };
}

/** Selects the first N candidates each phase was offered. */
function selectFirst(prompt) {
  const phases = [];
  for (const block of prompt.split('\n\n')) {
    const head = block.match(/^(TOP|HEART|BASE) — /);
    if (!head) continue;
    const needed = Number(block.match(/Choose exactly (\d+) of these:/)[1]);
    const ids = [...block.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]));
    phases.push({
      name: head[1].toLowerCase(),
      picks: ids.slice(0, needed).map((id) => ({ id, why: `Why ${id}.` })),
    });
  }
  return { phases };
}

const REQUEST = { input: 'smoky oud', duration: 60, discovery: 'deepcuts' };

/** callModel double: primary score first, then the selection call. */
function scriptedModel({ score = modelScore, select = selectFirst } = {}) {
  const calls = [];
  return {
    calls,
    async callModel(options) {
      calls.push(options);
      if (calls.length === 1) return score();
      return select(options.prompt);
    },
  };
}

// ------------------------------------------------------------------- the gate

test('with no LB_RADIO configured the pipeline is exactly what it always was', async () => {
  const model = scriptedModel();
  const resolver = fakeResolver();
  const result = await generateScore(REQUEST, { callModel: model.callModel, resolver });

  assert.equal(result.discoverySource, 'llm');
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0].system, buildSystemPrompt());
  assert.equal(model.calls[0].prompt, buildScorePrompt(REQUEST), 'byte-identical prompt');
  assert.equal(model.calls[0].schema, llmScoreSchema, 'and the schema the eval judged');
  assert.equal(result.trackCount, 12);
});

test('an enabled provider still never touches familiar or balanced', async () => {
  for (const discovery of ['familiar', 'balanced']) {
    const model = scriptedModel();
    const lbRadio = fakeLbRadio();
    const result = await generateScore(
      { ...REQUEST, discovery },
      { callModel: model.callModel, resolver: fakeResolver(), lbRadio },
    );

    assert.equal(lbRadio.asked.length, 0, `${discovery} must not reach the provider`);
    assert.equal(result.discoverySource, 'llm');
    assert.equal(model.calls[0].prompt, buildScorePrompt({ ...REQUEST, discovery }));
    assert.equal(model.calls[0].schema, llmScoreSchema);
  }
});

test('a provider that is present but disabled is inert', async () => {
  const lbRadio = { ...fakeLbRadio(), enabled: false };
  const model = scriptedModel();
  const result = await generateScore(REQUEST, {
    callModel: model.callModel,
    resolver: fakeResolver(),
    lbRadio,
  });
  assert.equal(result.discoverySource, 'llm');
  assert.equal(model.calls[0].schema, llmScoreSchema);
});

// -------------------------------------------------------------- the happy path

test('deep cuts with the provider on: tags out, real records back, two calls', async () => {
  const model = scriptedModel();
  const lbRadio = fakeLbRadio();
  const resolver = fakeResolver();

  const result = await generateScore(REQUEST, {
    callModel: model.callModel,
    resolver,
    lbRadio,
  });

  assert.equal(result.discoverySource, 'lb-radio');
  assert.equal(result.modelCalls, 2);
  assert.ok(result.modelCalls <= MAX_MODEL_CALLS);
  assert.equal(result.trackCount, 12, 'quota met without a backfill');
  assert.equal(result.backfilled, false);

  // Call 1 asked for tags with the tagged schema; call 2 was the selection.
  assert.equal(model.calls[0].schema, llmScoreWithTagsSchema);
  assert.match(model.calls[0].prompt, /DISCOVERY TAGS/);
  assert.match(model.calls[1].prompt, /Choose exactly 3 of these:/);
  assert.match(model.calls[1].system, /Choose ONLY from the numbered candidates/);

  // The tags the model wrote are what the provider was asked for, one phase
  // at a time, sanitized.
  assert.deepEqual(lbRadio.asked, [
    [{ tag: 'top-tag', weight: 3 }, { tag: 'ambient', weight: 1 }],
    [{ tag: 'heart-tag', weight: 3 }, { tag: 'ambient', weight: 1 }],
    [{ tag: 'base-tag', weight: 3 }, { tag: 'ambient', weight: 1 }],
  ]);

  // Every record in the score came from ListenBrainz, not from the model.
  const titles = result.phases.flatMap((p) => p.tracks.map((t) => t.title));
  assert.ok(titles.every((title) => /record \d+$/.test(title)), titles.join(', '));
  assert.equal(titles.some((title) => title.startsWith('top ')), false, 'no model proposals leaked');

  // And each one carries the sentence the selection call wrote for it.
  const whys = result.phases.flatMap((p) => p.tracks.map((t) => t.why));
  assert.ok(whys.every((why) => /^Why \d+\.$/.test(why)));
});

test('internal handles never reach the assembled result', async () => {
  const result = await generateScore(REQUEST, {
    ...scriptedModelOptions(),
    lbRadio: fakeLbRadio(),
  });
  for (const track of result.phases.flatMap((p) => p.tracks)) {
    assert.equal('candidateId' in track, false);
    assert.equal('phaseIndex' in track, false);
    assert.equal('discoveryTags' in track, false);
  }
});

function scriptedModelOptions() {
  const model = scriptedModel();
  return { callModel: model.callModel, resolver: fakeResolver() };
}

test('the pool is capped, de-duplicated across phases, and numbered', async () => {
  const model = scriptedModel();
  const resolver = fakeResolver();
  await generateScore(REQUEST, { callModel: model.callModel, resolver, lbRadio: fakeLbRadio() });

  const resolved = resolver.calls[0];
  // 60-minute quota is 3/5/4, so the caps are the floor of 10 for top and
  // base and 15 for the heart.
  assert.equal(resolved.length, candidateCap(3) + candidateCap(5) + candidateCap(4));
  assert.deepEqual(
    resolved.map((c) => c.candidateId),
    resolved.map((_, i) => i),
    'candidate numbers are dense and unique across the whole score',
  );

  // The selection prompt offers each phase only its own numbers.
  const topBlock = model.calls[1].prompt.split('\n\n').find((b) => b.startsWith('TOP —'));
  const topIds = [...topBlock.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]));
  assert.equal(topIds.length, candidateCap(3));
  assert.equal(Math.max(...topIds), candidateCap(3) - 1);
});

// ---------------------------------------------------------- silent fallbacks

/** Every one of these must produce a complete, ordinary score. */
const FALLBACKS = [
  ['a 401 from the provider', { fail: new LbRadioError('rejected', 'lb-radio 401') }],
  ['a timeout', { fail: new LbRadioError('timeout', 'lb-radio timed out') }],
  ['an unexpected throw', { fail: new TypeError('boom') }],
  ['an empty playlist', { empty: true }],
  ['too few candidates to fill a phase', { perPhase: 2 }],
];

for (const [label, options] of FALLBACKS) {
  test(`${label} falls back silently to the model's own records`, async () => {
    const model = scriptedModel();
    const events = [];
    const result = await generateScore(REQUEST, {
      callModel: model.callModel,
      resolver: fakeResolver(),
      lbRadio: fakeLbRadio(options),
      onEvent: (event) => events.push(event),
    });

    assert.equal(result.discoverySource, 'llm');
    assert.equal(result.trackCount, 12, 'a complete score, not a degraded one');
    assert.equal(result.short, false);
    assert.equal(model.calls.length, 1, 'no selection call is spent on a dead provider');
    assert.ok(
      events.some((event) => event.type === 'lb_radio_fallback'),
      'the reason is logged even though the visitor never learns of it',
    );
  });
}

test('a score that arrives with no tags falls back instead of failing', async () => {
  const untagged = () => {
    const score = modelScore();
    score.phases.forEach((p) => delete p.discoveryTags);
    return score;
  };
  const model = scriptedModel({ score: untagged });
  const lbRadio = fakeLbRadio();
  const events = [];

  const result = await generateScore(REQUEST, {
    callModel: model.callModel,
    resolver: fakeResolver(),
    lbRadio,
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.discoverySource, 'llm');
  assert.equal(result.trackCount, 12);
  assert.equal(lbRadio.asked.length, 0);
  assert.equal(
    events.find((e) => e.type === 'lb_radio_fallback').reason,
    'no_tags',
  );
});

test('tags that are all punctuation never reach the provider', async () => {
  const injected = () => {
    const score = modelScore();
    score.phases.forEach((p) => {
      p.discoveryTags = [{ tag: 'ambient) artist:(a famous name', weight: 3 }];
    });
    return score;
  };
  const model = scriptedModel({ score: injected });
  const lbRadio = fakeLbRadio();
  const result = await generateScore(REQUEST, {
    callModel: model.callModel,
    resolver: fakeResolver(),
    lbRadio,
  });

  assert.equal(lbRadio.asked.length, 0);
  assert.equal(result.discoverySource, 'llm');
});

test('a failed selection call falls back, and the spent call is still counted', async () => {
  const model = scriptedModel({
    select: () => {
      throw new Error('gateway exploded');
    },
  });
  const result = await generateScore(REQUEST, {
    callModel: model.callModel,
    resolver: fakeResolver(),
    lbRadio: fakeLbRadio(),
  });

  assert.equal(result.discoverySource, 'llm');
  assert.equal(result.modelCalls, 2, 'the burned call is honest about itself');
  assert.equal(result.trackCount, 12);
});

test('a selection full of invented numbers falls back rather than shipping a thin score', async () => {
  const model = scriptedModel({
    select: () => ({ phases: [{ name: 'top', picks: [{ id: 9999, why: 'Invented.' }] }] }),
  });
  const result = await generateScore(REQUEST, {
    callModel: model.callModel,
    resolver: fakeResolver(),
    lbRadio: fakeLbRadio(),
  });

  assert.equal(result.discoverySource, 'llm');
  assert.equal(result.trackCount, 12);
});

test('the provider is not started when the budget is already spent', async () => {
  const model = scriptedModel();
  const lbRadio = fakeLbRadio();
  const result = await generateScore(REQUEST, {
    callModel: model.callModel,
    resolver: fakeResolver(),
    lbRadio,
    lbReserveMs: Infinity,
  });
  assert.equal(lbRadio.asked.length, 0);
  assert.equal(result.discoverySource, 'llm');
});

/**
 * A discovery score that comes up short on runtime is left short. Asking the
 * model to name replacement records from memory is precisely what this path
 * exists to stop doing — a top-up of chart-familiar picks would quietly undo
 * the deep cut.
 */
test('a short provider score is never topped up with remembered records', async () => {
  const model = scriptedModel();
  const result = await generateScore(REQUEST, {
    callModel: model.callModel,
    // Two-minute records: even the widened selection cannot reach 48 minutes.
    resolver: fakeResolver({ durationMs: 120_000 }),
    lbRadio: fakeLbRadio(),
  });

  assert.equal(result.discoverySource, 'lb-radio');
  assert.equal(result.runtimeShort, true, 'the score really is short');
  assert.equal(result.backfilled, false);
  assert.equal(model.calls.length, 2, 'the score call and the selection call, and no third');
  assert.equal(
    model.calls.some((call) => /You are completing a Drydown Score/.test(call.prompt)),
    false,
  );
});

/** A pool too thin to fill a phase is abandoned before any call is spent. */
test('a pool the resolver guts is abandoned rather than half-used', async () => {
  const failing = new Set(Array.from({ length: 13 }, (_, i) => `heart-tag record ${i + 2}`));
  const model = scriptedModel();
  const result = await generateScore(REQUEST, {
    callModel: model.callModel,
    resolver: fakeResolver({ failing }),
    lbRadio: fakeLbRadio(),
  });

  assert.equal(result.discoverySource, 'llm', 'never a half-discovered, half-remembered score');
  assert.equal(model.calls.length, 1, 'no selection call was spent on it');
  assert.equal(result.trackCount, 12);
});

test('a partial resolve on the provider path still marks the score partial', async () => {
  const model = scriptedModel();
  const result = await generateScore(REQUEST, {
    callModel: model.callModel,
    resolver: fakeResolver({ partial: true }),
    lbRadio: fakeLbRadio(),
  });
  assert.equal(result.discoverySource, 'lb-radio');
  assert.equal(result.partial, true);
  assert.equal(result.short, true);
});

// -------------------------------------------------------------- pure helpers

test('poolTargets asks for the quota, widened only when the pool runs short', () => {
  const pools = (durationMs) =>
    ['top', 'heart', 'base'].map((name, i) => ({
      name,
      weight: [0.25, 0.45, 0.3][i],
      tracks: Array.from({ length: 12 }, () => ({ durationMs })),
    }));

  // Four-minute records: 12 of them is exactly the 60-minute floor.
  assert.deepEqual(poolTargets(pools(240_000), 60), { top: 3, heart: 5, base: 4 });

  // Two-minute records: the quota would play for 24 minutes, so more are asked
  // for — heaviest phase first, and never more than two per phase.
  const widened = poolTargets(pools(120_000), 60);
  assert.deepEqual(widened, { top: 5, heart: 7, base: 6 });

  // A pool with no room to widen is left alone rather than over-promised.
  const thin = ['top', 'heart', 'base'].map((name, i) => ({
    name,
    weight: [0.25, 0.45, 0.3][i],
    tracks: Array.from({ length: quotaFor(60)[name] }, () => ({ durationMs: 60_000 })),
  }));
  assert.deepEqual(poolTargets(thin, 60), quotaFor(60));
});

test('pickSelected can only ever narrow the list it was given', () => {
  const pool = (name, ids) => ({
    name,
    tracks: ids.map((id) => ({ candidateId: id, title: `t${id}`, artist: `a${id}` })),
  });
  const pools = [pool('top', [0, 1, 2]), pool('heart', [3, 4])];

  const picked = pickSelected(
    pools,
    {
      phases: [
        {
          name: 'top',
          picks: [
            { id: 2, why: 'Second first.' },
            { id: 3, why: 'Borrowed from another phase.' },
            { id: 99, why: 'Never offered.' },
            { id: 0, why: 'Fine.' },
            { id: 0, why: 'Repeat.' },
            { id: 1, why: 'Over the target.' },
          ],
        },
        { name: 'heart', picks: [{ id: 4, why: '' }, { id: 3, why: 'Good.' }] },
      ],
    },
    { top: 2, heart: 2 },
  );

  assert.deepEqual(
    picked.map((p) => p.tracks.map((t) => `${t.title}:${t.why}`)),
    [['t2:Second first.', 't0:Fine.'], ['t3:Good.']],
  );
  assert.equal('candidateId' in picked[0].tracks[0], false);
});

test('candidateCap gives room to choose without resolving the world', () => {
  assert.equal(candidateCap(2), 10, 'a floor, so a two-track phase still has options');
  assert.equal(candidateCap(5), 15);
  assert.equal(candidateCap(8), 18, 'and a ceiling, so a 90-minute score is not 50 searches');
});
