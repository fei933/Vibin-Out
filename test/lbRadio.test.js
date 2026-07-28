import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRadioPrompt,
  buildRadioUrl,
  createLbRadio,
  LB_RADIO_URL,
  LbRadioError,
  lbRadioConfig,
  MAX_TAG_LENGTH,
  mbidFromIdentifier,
  parseJspfTracks,
  sanitizeTag,
  sanitizeTags,
} from '../lib/lbRadio.js';

// ------------------------------------------------------------------ the gate

test('the provider is off unless BOTH variables are set', () => {
  assert.equal(lbRadioConfig({}).enabled, false, 'off by default');
  assert.equal(lbRadioConfig({ LB_RADIO: 'off', LB_TOKEN: 'uuid' }).enabled, false);
  assert.equal(lbRadioConfig({ LB_RADIO: 'deepcuts' }).enabled, false, 'flag without a token');
  assert.equal(lbRadioConfig({ LB_RADIO: 'deepcuts', LB_TOKEN: '   ' }).enabled, false);
  assert.equal(lbRadioConfig({ LB_RADIO: 'deepcuts', LB_TOKEN: 'uuid' }).enabled, true);
  assert.equal(lbRadioConfig({ LB_RADIO: 'DeepCuts', LB_TOKEN: 'uuid' }).enabled, true);
  // deep cuts is the whole scope: no other dial position turns this on.
  assert.equal(lbRadioConfig({ LB_RADIO: 'balanced', LB_TOKEN: 'uuid' }).enabled, false);
});

test('a disabled provider never reaches the network', async () => {
  let called = false;
  const lb = createLbRadio({ token: '', fetchImpl: async () => { called = true; } });
  assert.equal(lb.enabled, false);
  await assert.rejects(lb.tracksForTags([{ tag: 'ambient', weight: 1 }]), (error) => error.reason === 'disabled');
  assert.equal(called, false);
});

// ------------------------------------------------------------ sanitization

test('tags are lowercased, accent-folded and whitespace-collapsed', () => {
  assert.equal(sanitizeTag('Deep   House'), 'deep house');
  assert.equal(sanitizeTag('  Björk  '), 'bjork');
  assert.equal(sanitizeTag('TRIP HOP'), 'trip hop');
  assert.equal(sanitizeTag("rock 'n' roll"), "rock 'n' roll");
  assert.equal(sanitizeTag('r-n-b'), 'r-n-b');
});

/**
 * The tags are authored by a model that has just read visitor-supplied text,
 * and they land in a query DSL where `(`, `)`, `:` and `,` are structural.
 * That is a prompt-injection surface, so a tag carrying DSL punctuation is
 * DROPPED rather than laundered into something harmless-but-meaningless.
 */
test('a tag carrying DSL punctuation is dropped, never repaired', () => {
  assert.equal(sanitizeTag('ambient) artist:(taylor swift'), null);
  assert.equal(sanitizeTag('ambient,rock'), null);
  assert.equal(sanitizeTag('#punk'), null);
  assert.equal(sanitizeTag('jazz:3'), null);
  assert.equal(sanitizeTag('drone\u0000'), null, 'control characters too');
  assert.equal(sanitizeTag('drone\nartist:(x)'), null, 'a newline cannot smuggle a second element');
});

test('tags that cannot be salvaged are dropped rather than erroring', () => {
  assert.equal(sanitizeTag(''), null);
  assert.equal(sanitizeTag('   '), null);
  assert.equal(sanitizeTag('日本語'), null, 'nothing ASCII survives');
  assert.equal(sanitizeTag('---'), null, 'punctuation only');
  assert.equal(sanitizeTag(42), null);
  assert.equal(sanitizeTag(null), null);
  assert.equal(sanitizeTag('a'.repeat(MAX_TAG_LENGTH + 1)), null, 'over the length cap');
  assert.equal(sanitizeTag('a'.repeat(MAX_TAG_LENGTH)), 'a'.repeat(MAX_TAG_LENGTH));
});

test('a tag list is de-duplicated, weight-clamped and capped', () => {
  const tags = sanitizeTags([
    { tag: 'Ambient', weight: 3 },
    { tag: 'ambient', weight: 1 }, // same tag after folding
    { tag: 'drone', weight: 9 }, // over the ceiling
    { tag: 'field recording', weight: 0 }, // under the floor
    { tag: 'jazz', weight: 'two' }, // not a number
    { tag: 'nope)', weight: 2 }, // dropped, does not consume a slot
    { tag: 'shoegaze', weight: 2 },
    { tag: 'dub', weight: 1 },
    { tag: 'techno', weight: 1 }, // past the cap
  ]);

  assert.deepEqual(tags, [
    { tag: 'ambient', weight: 3 },
    { tag: 'drone', weight: 3 },
    { tag: 'field recording', weight: 1 },
    { tag: 'jazz', weight: 1 },
    { tag: 'shoegaze', weight: 2 },
  ]);
  assert.equal(sanitizeTags('ambient').length, 0, 'a non-array is no tags, not a crash');
  assert.equal(sanitizeTags(undefined).length, 0);
});

// ------------------------------------------------------------------ the DSL

test('each tag is its own weighted element, and weight 1 is left implicit', () => {
  assert.equal(
    buildRadioPrompt([
      { tag: 'ambient', weight: 3 },
      { tag: 'trip hop', weight: 2 },
      { tag: 'dub', weight: 1 },
    ]),
    'tag:(ambient):3 tag:(trip hop):2 tag:(dub)',
  );
});

test('the request asks for the tail of the ranked data', () => {
  const url = buildRadioUrl([{ tag: 'deep house', weight: 2 }]);
  assert.ok(url.startsWith(`${LB_RADIO_URL}?`), 'the main api host, no trailing slash');
  const params = new URL(url).searchParams;
  assert.equal(params.get('prompt'), 'tag:(deep house):2');
  assert.equal(params.get('mode'), 'hard', 'hard mode IS the popularity dial');
});

test('an empty tag list is a refusal to build a prompt at all', () => {
  assert.throws(() => buildRadioPrompt([]), (error) => error instanceof LbRadioError);
});

// ---------------------------------------------------------------- parsing

/** The exact shape confirmed against a live JSPF playlist (probe findings §5). */
const JSPF = (tracks) => ({ payload: { jspf: { playlist: { track: tracks } } } });

test('a JSPF track maps creator to artist and identifier to an mbid', () => {
  const tracks = parseJspfTracks(
    JSPF([
      {
        title: 'Indoor Kid',
        creator: 'Sløtface',
        album: 'AWAKE/ASLEEP',
        duration: 170000,
        identifier: ['https://musicbrainz.org/recording/273c17b3-9e39-4dd4-bea7-ecaad28202e7'],
      },
    ]),
  );
  assert.deepEqual(tracks, [
    {
      title: 'Indoor Kid',
      artist: 'Sløtface',
      recordingMbid: '273c17b3-9e39-4dd4-bea7-ecaad28202e7',
    },
  ]);
});

test('the older bare-string identifier is accepted too', () => {
  assert.equal(
    mbidFromIdentifier('https://musicbrainz.org/recording/273c17b3-9e39-4dd4-bea7-ecaad28202e7'),
    '273c17b3-9e39-4dd4-bea7-ecaad28202e7',
  );
  assert.equal(mbidFromIdentifier(['not a url', 'https://musicbrainz.org/recording/AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'.toLowerCase()]), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(mbidFromIdentifier([]), null);
  assert.equal(mbidFromIdentifier('https://musicbrainz.org/recording/not-an-mbid'), null);
  assert.equal(mbidFromIdentifier(undefined), null);
});

test('malformed responses yield fewer candidates, never an exception', () => {
  assert.deepEqual(parseJspfTracks(undefined), []);
  assert.deepEqual(parseJspfTracks({}), []);
  assert.deepEqual(parseJspfTracks(JSPF('not an array')), []);
  assert.deepEqual(parseJspfTracks(JSPF([null, 7, 'x'])), []);

  const partial = parseJspfTracks(
    JSPF([
      { title: 'No Artist' },
      { creator: 'No Title' },
      { title: '  ', creator: 'Blank' },
      { title: 'Good One', creator: 'Real Artist' },
      { title: 'Good One', creator: 'Real Artist' }, // repeated by the provider
      { title: 'x'.repeat(500), creator: 'Too Long' },
      { title: 'Bad\u0007Bell', creator: 'Control Char' },
    ]),
  );
  assert.deepEqual(partial, [{ title: 'Good One', artist: 'Real Artist', recordingMbid: null }]);
});

// ------------------------------------------------------------ HTTP behaviour

function stubFetch(responses) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    impl: async (url, options) => {
      calls.push({ url, options });
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (typeof next === 'function') return next();
      return next;
    },
  };
}

/**
 * A request that only ever ends by abort. `AbortSignal.timeout()`'s internal
 * timer is unref'd, so a ref'd timer of our own has to hold the event loop
 * open or the whole test file is cancelled mid-run.
 */
function neverSettles(signal) {
  return new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error('the abort never arrived')), 2_000);
    const done = () => {
      clearTimeout(keepAlive);
      reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    };
    if (signal.aborted) done();
    else signal.addEventListener('abort', done, { once: true });
  });
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const status = (code) => ({ ok: false, status: code, json: async () => ({ error: 'nope' }) });

const TAGS = [{ tag: 'ambient', weight: 2 }];

test('the token rides as an Authorization: Token header', async () => {
  const fetchStub = stubFetch([ok(JSPF([{ title: 'A', creator: 'B' }]))]);
  const lb = createLbRadio({ token: 'a-real-uuid', fetchImpl: fetchStub.impl });
  const tracks = await lb.tracksForTags(TAGS);

  assert.equal(tracks.length, 1);
  assert.equal(fetchStub.calls[0].options.headers.authorization, 'Token a-real-uuid');
  assert.match(fetchStub.calls[0].url, /prompt=tag%3A%28ambient%29%3A2/);
});

test('401 and 400 are permanent — one attempt, no retry', async () => {
  for (const code of [400, 401, 403, 404, 429]) {
    const fetchStub = stubFetch([status(code)]);
    const lb = createLbRadio({ token: 't', fetchImpl: fetchStub.impl, sleep: async () => {} });
    await assert.rejects(lb.tracksForTags(TAGS), (error) => error.reason === 'rejected');
    assert.equal(fetchStub.calls.length, 1, `${code} must not be retried`);
  }
});

test('a 5xx earns exactly one retry, then gives up', async () => {
  const fetchStub = stubFetch([status(503)]);
  let slept = 0;
  const lb = createLbRadio({
    token: 't',
    fetchImpl: fetchStub.impl,
    sleep: async () => {
      slept += 1;
    },
  });
  await assert.rejects(lb.tracksForTags(TAGS), (error) => error.reason === 'server_error');
  assert.equal(fetchStub.calls.length, 2);
  assert.equal(slept, 1);
});

test('a 5xx followed by a 200 succeeds on the retry', async () => {
  const queue = [status(500), ok(JSPF([{ title: 'A', creator: 'B' }]))];
  const lb = createLbRadio({
    token: 't',
    sleep: async () => {},
    fetchImpl: async () => queue.shift(),
  });
  assert.equal((await lb.tracksForTags(TAGS)).length, 1);
});

test('a network error earns the one retry', async () => {
  let calls = 0;
  const lb = createLbRadio({
    token: 't',
    sleep: async () => {},
    fetchImpl: async () => {
      calls += 1;
      throw new TypeError('fetch failed');
    },
  });
  await assert.rejects(lb.tracksForTags(TAGS), (error) => error.reason === 'network');
  assert.equal(calls, 2);
});

/**
 * A blown deadline is a statement about the time budget, not a transient
 * failure: a second 8s attempt spends 16s of a generation to reach the same
 * fallback. So timeouts get one attempt and fall through.
 */
test('a timeout is not retried', async () => {
  let calls = 0;
  const lb = createLbRadio({
    token: 't',
    timeoutMs: 5,
    sleep: async () => {},
    fetchImpl: (_url, { signal }) => {
      calls += 1;
      return neverSettles(signal);
    },
  });
  await assert.rejects(lb.tracksForTags(TAGS), (error) => error.reason === 'timeout');
  assert.equal(calls, 1);
});

test('an unreadable 200 body is a failure, not a crash', async () => {
  const lb = createLbRadio({
    token: 't',
    sleep: async () => {},
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('truncated'); } }),
  });
  await assert.rejects(lb.tracksForTags(TAGS), (error) => error.reason === 'bad_body');
});

test('an outer abort signal cancels the fetch, and is not retried either', async () => {
  const controller = new AbortController();
  let calls = 0;
  const lb = createLbRadio({
    token: 't',
    sleep: async () => {},
    fetchImpl: (_url, { signal }) => {
      calls += 1;
      queueMicrotask(() => controller.abort());
      return neverSettles(signal);
    },
  });
  await assert.rejects(lb.tracksForTags(TAGS, { signal: controller.signal }));
  assert.equal(calls, 1);
});

test('tags are sanitized inside the client too, not only by its caller', async () => {
  const fetchStub = stubFetch([ok(JSPF([]))]);
  const lb = createLbRadio({ token: 't', fetchImpl: fetchStub.impl });
  await lb.tracksForTags([{ tag: 'Ambient) artist:(x', weight: 1 }, { tag: 'Drone', weight: 2 }]);
  assert.match(new URL(fetchStub.calls[0].url).searchParams.get('prompt'), /^tag:\(drone\):2$/);

  await assert.rejects(
    lb.tracksForTags([{ tag: '#punk', weight: 1 }]),
    (error) => error.reason === 'no_tags',
  );
  assert.equal(fetchStub.calls.length, 1, 'an all-invalid tag list never reaches the network');
});
