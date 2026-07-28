import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALBUM_ART_TARGET_WIDTH,
  ARTIST_INDIE_POPULARITY_THRESHOLD,
  createSpotifyResolver,
  INDIE_POPULARITY_THRESHOLD,
  isIndie,
  mapWithConcurrency,
  MAX_TRACK_DURATION_MS,
  pickAlbumArt,
} from '../lib/trackResolver.js';

const ok = (body) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => body,
});

const tooManyRequests = (retryAfter = '1') => ({
  ok: false,
  status: 429,
  headers: { get: (name) => (name === 'retry-after' ? retryAfter : null) },
  json: async () => ({}),
});

/** Spotify's real shape: widest first, 640/300/64. */
const defaultImages = [
  { url: 'https://i.scdn.co/image/640', width: 640, height: 640 },
  { url: 'https://i.scdn.co/image/300', width: 300, height: 300 },
  { url: 'https://i.scdn.co/image/64', width: 64, height: 64 },
];

function item({
  id = 'id1',
  name,
  artists,
  popularity = 55,
  durationMs = 210_000,
  images = defaultImages,
}) {
  return {
    id,
    name,
    artists: artists.map((a) => ({ id: `art-${a}`, name: a })),
    album: images === null ? {} : { images },
    popularity,
    duration_ms: durationMs,
  };
}

function trackHit(spec) {
  return { tracks: { items: [item(spec)] } };
}

/** Several results for one query, in the order Spotify returned them. */
function trackHits(specs) {
  return { tracks: { items: specs.map(item) } };
}

/** A fetch double: token requests always succeed, searches come from a queue. */
function makeFetch(searchResponses) {
  const calls = { token: 0, search: 0, urls: [] };
  const queue = [...searchResponses];
  const fetchImpl = async (url) => {
    if (String(url).includes('accounts.spotify.com')) {
      calls.token += 1;
      return ok({ access_token: 'tok', expires_in: 3600 });
    }
    calls.search += 1;
    calls.urls.push(String(url));
    const next = queue.shift();
    if (typeof next === 'function') return next();
    return next ?? ok({ tracks: { items: [] } });
  };
  return { fetchImpl, calls };
}

const deps = (fetchImpl, extra = {}) => ({
  fetchImpl,
  clientId: 'id',
  clientSecret: 'secret',
  sleep: async () => {},
  ...extra,
});

test('mapWithConcurrency preserves order and never exceeds the limit', async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight -= 1;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.ok(peak <= 3, `peak concurrency was ${peak}`);
});

test('resolve records the spotify id, popularity, duration and indie flag', async () => {
  const { fetchImpl, calls } = makeFetch([
    ok(trackHit({ id: 'abc', name: 'Glassy Morning', artists: ['Ana Roxanne'], popularity: 12 })),
  ]);
  const resolver = createSpotifyResolver(deps(fetchImpl));

  const { tracks, misses, partial } = await resolver.resolve([
    { title: 'Glassy Morning', artist: 'Ana Roxanne', why: 'mineral', phaseIndex: 0 },
  ]);

  assert.equal(misses.length, 0);
  assert.equal(partial, false);
  assert.deepEqual(tracks[0], {
    title: 'Glassy Morning',
    artist: 'Ana Roxanne',
    why: 'mineral',
    phaseIndex: 0,
    spotifyId: 'abc',
    artistId: 'art-Ana Roxanne',
    albumArt: 'https://i.scdn.co/image/300',
    popularity: 12,
    durationMs: 210_000,
    indie: true,
  });
  assert.equal(calls.search, 1);
  assert.ok(calls.urls[0].includes('track%3A'), 'uses the track: field filter');
});

test('resolve drops hits that fail verification and reports them as misses', async () => {
  const { fetchImpl } = makeFetch([
    ok(trackHit({ name: 'Holocene (Karaoke Version)', artists: ['Ameritz'] })),
    ok({ tracks: { items: [] } }),
  ]);
  const resolver = createSpotifyResolver(deps(fetchImpl));

  const { tracks, misses } = await resolver.resolve([
    { title: 'Holocene', artist: 'Bon Iver' },
    { title: 'Invented Song', artist: 'Nobody At All' },
  ]);

  assert.equal(tracks.length, 0);
  assert.equal(misses.length, 2);
  assert.deepEqual(
    misses.map((m) => m.reason),
    ['miss', 'miss'],
  );
});

test('resolve backs off on 429 and succeeds when the provider recovers', async () => {
  const sleeps = [];
  const { fetchImpl, calls } = makeFetch([
    tooManyRequests('2'),
    ok(trackHit({ name: 'Holocene', artists: ['Bon Iver'], popularity: 70 })),
  ]);
  const resolver = createSpotifyResolver(
    deps(fetchImpl, { sleep: async (ms) => sleeps.push(ms) }),
  );

  const { tracks, partial } = await resolver.resolve([{ title: 'Holocene', artist: 'Bon Iver' }]);

  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].indie, false, 'popularity 70 is not an indie find');
  assert.equal(partial, false);
  assert.deepEqual(sleeps, [2000], 'honours Retry-After');
  assert.equal(calls.search, 2);
});

test('resolve returns partial results instead of throwing on a persistent 429', async () => {
  const { fetchImpl } = makeFetch(Array.from({ length: 12 }, () => tooManyRequests()));
  const resolver = createSpotifyResolver(deps(fetchImpl, { concurrency: 1, maxAttempts: 2 }));

  const { tracks, misses, partial } = await resolver.resolve([
    { title: 'One', artist: 'A' },
    { title: 'Two', artist: 'B' },
    { title: 'Three', artist: 'C' },
  ]);

  assert.equal(tracks.length, 0);
  assert.equal(misses.length, 3);
  assert.equal(partial, true, 'caller must be able to render a "shorter than usual" note');
  assert.equal(
    misses.filter((m) => m.reason === 'skipped').length,
    2,
    'stops asking once the provider is persistently rate limiting',
  );
});

test('the client-credentials token is fetched once and reused', async () => {
  const { fetchImpl, calls } = makeFetch([
    ok(trackHit({ name: 'One', artists: ['A'] })),
    ok(trackHit({ id: 'id2', name: 'Two', artists: ['B'] })),
  ]);
  const resolver = createSpotifyResolver(deps(fetchImpl, { concurrency: 1 }));

  await resolver.resolve([
    { title: 'One', artist: 'A' },
    { title: 'Two', artist: 'B' },
  ]);

  assert.equal(calls.token, 1);
});

/**
 * Regression: AbortSignal.timeout() rejects with a TimeoutError, not an
 * AbortError. Matching only on AbortError meant an expired deadline looked
 * like a transient failure and every queued candidate kept retry-sleeping
 * against a dead signal — the shape of a serverless timeout overrun.
 */
test('a deadline expiry ends the pass promptly instead of retry-sleeping', async () => {
  const sleeps = [];
  const controller = new AbortController();
  const timeoutError = Object.assign(new Error('The operation timed out.'), {
    name: 'TimeoutError',
  });

  const { fetchImpl, calls } = makeFetch([
    () => {
      controller.abort(timeoutError); // the deadline passes mid-flight
      return Promise.reject(timeoutError);
    },
  ]);
  const resolver = createSpotifyResolver(
    deps(fetchImpl, { concurrency: 1, sleep: async (ms) => sleeps.push(ms) }),
  );

  const { tracks, misses, partial } = await resolver.resolve(
    [
      { title: 'One', artist: 'A' },
      { title: 'Two', artist: 'B' },
      { title: 'Three', artist: 'C' },
    ],
    { signal: controller.signal },
  );

  assert.equal(tracks.length, 0);
  assert.equal(partial, true);
  assert.deepEqual(sleeps, [], 'a dead signal must not be slept against');
  assert.equal(calls.search, 1, 'the remaining candidates are abandoned, not retried');
  assert.equal(misses.length, 3);
});

test('an already-expired signal returns immediately without any lookups', async () => {
  const { fetchImpl, calls } = makeFetch([]);
  const resolver = createSpotifyResolver(deps(fetchImpl));
  const signal = AbortSignal.abort();

  const { tracks, misses, partial } = await resolver.resolve(
    [
      { title: 'One', artist: 'A' },
      { title: 'Two', artist: 'B' },
    ],
    { signal },
  );

  assert.equal(calls.search, 0);
  assert.equal(tracks.length, 0);
  assert.equal(misses.length, 2);
  assert.equal(partial, true);
});

/**
 * Regression: response.json() rejecting on a truncated 200 escaped the
 * guarded call, rejected the concurrency pool, and turned one bad response
 * into a 502 for the whole score.
 */
test('a truncated JSON body is one miss, not a failed request', async () => {
  const { fetchImpl } = makeFetch([
    {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    },
    ok(trackHit({ id: 'good', name: 'Two', artists: ['B'] })),
  ]);
  const resolver = createSpotifyResolver(deps(fetchImpl, { concurrency: 1 }));

  const { tracks, misses, partial } = await resolver.resolve([
    { title: 'One', artist: 'A' },
    { title: 'Two', artist: 'B' },
  ]);

  assert.equal(tracks.length, 1, 'the healthy candidate still resolves');
  assert.equal(tracks[0].spotifyId, 'good');
  assert.equal(misses.length, 1);
  assert.equal(misses[0].reason, 'error');
  assert.equal(partial, false);
});

/**
 * Regression: on a cold start every concurrent search saw an empty cache at
 * the same moment and issued its own token POST.
 */
test('concurrent cold-start searches share a single token request', async () => {
  let tokenCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes('accounts.spotify.com')) {
      tokenCalls += 1;
      await new Promise((r) => setTimeout(r, 5)); // a real request takes time
      return ok({ access_token: 'tok', expires_in: 3600 });
    }
    return ok(trackHit({ name: 'Song', artists: ['Artist'] }));
  };
  const resolver = createSpotifyResolver(deps(fetchImpl, { concurrency: 4 }));

  await resolver.resolve(
    Array.from({ length: 8 }, (_, i) => ({ title: 'Song', artist: 'Artist', i })),
  );

  assert.equal(tokenCalls, 1, 'eight concurrent lookups must not mint eight tokens');
});

test('a failed token request does not wedge the cache shut', async () => {
  let tokenCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes('accounts.spotify.com')) {
      tokenCalls += 1;
      if (tokenCalls === 1) return { ok: false, status: 503, json: async () => ({}) };
      return ok({ access_token: 'tok', expires_in: 3600 });
    }
    return ok(trackHit({ name: 'Song', artists: ['Artist'] }));
  };
  const resolver = createSpotifyResolver(
    deps(fetchImpl, { concurrency: 1, maxAttempts: 2 }),
  );

  const { tracks } = await resolver.resolve([{ title: 'Song', artist: 'Artist' }]);

  assert.equal(tokenCalls, 2, 'the second attempt gets a fresh token request');
  assert.equal(tracks.length, 1, 'and the lookup recovers');
});

/**
 * Album art rides along in the search response the resolver already makes, so
 * it costs nothing extra. It is the halo carousel's raw material (v2.1 §3) and
 * the only colour on an otherwise neutral page.
 */
test('pickAlbumArt takes the ~300px cover, not the 640 or the 64', () => {
  assert.equal(pickAlbumArt(defaultImages), 'https://i.scdn.co/image/300');
  assert.equal(ALBUM_ART_TARGET_WIDTH, 300);

  // Nearest wins when there is no exact 300.
  assert.equal(
    pickAlbumArt([
      { url: 'big', width: 640 },
      { url: 'mid', width: 320 },
      { url: 'small', width: 64 },
    ]),
    'mid',
  );
  // Only one size offered — take it rather than nothing.
  assert.equal(pickAlbumArt([{ url: 'only', width: 640 }]), 'only');
  // Dimensions missing entirely: fall back to the first usable URL.
  assert.equal(pickAlbumArt([{ url: 'nodims' }]), 'nodims');
});

test('pickAlbumArt is null-safe for releases with no artwork', () => {
  assert.equal(pickAlbumArt([]), null);
  assert.equal(pickAlbumArt(null), null);
  assert.equal(pickAlbumArt(undefined), null);
  assert.equal(pickAlbumArt('not-an-array'), null);
  assert.equal(pickAlbumArt([{ height: 300 }]), null, 'an entry with no url is not usable');
  assert.equal(pickAlbumArt([{ url: '' }]), null);
});

test('resolve carries album art through, and null when Spotify omits it', async () => {
  const { fetchImpl } = makeFetch([
    ok(trackHit({ name: 'With Art', artists: ['A'] })),
    ok(trackHit({ id: 'id2', name: 'No Art', artists: ['B'], images: [] })),
    ok(trackHit({ id: 'id3', name: 'No Album', artists: ['C'], images: null })),
  ]);
  const resolver = createSpotifyResolver(deps(fetchImpl, { concurrency: 1 }));

  const { tracks } = await resolver.resolve([
    { title: 'With Art', artist: 'A' },
    { title: 'No Art', artist: 'B' },
    { title: 'No Album', artist: 'C' },
  ]);

  assert.equal(tracks.length, 3);
  assert.equal(tracks[0].albumArt, 'https://i.scdn.co/image/300');
  assert.equal(tracks[1].albumArt, null, 'an empty images array is not a crash');
  assert.equal(tracks[2].albumArt, null, 'a missing album object is not a crash');
});

test('isIndie is grounded in popularity, never in what the model claims', () => {
  assert.equal(isIndie(INDIE_POPULARITY_THRESHOLD - 1), true);
  assert.equal(isIndie(INDIE_POPULARITY_THRESHOLD), false);
  assert.equal(isIndie(null), false);
});

/**
 * Regression from the eval: Al Green's "At Last" (track pop 34) wore an
 * "indie find" badge. A quiet track by a famous artist is a deep cut, not a
 * discovery — the badge has to be true about the artist.
 *
 * Thresholds calibrated against the eval's own artists (real Spotify artist
 * popularity, 2026-07-27).
 */
test('isIndie requires the ARTIST to be obscure, not just the track', () => {
  // Al Green: track 34 (quiet) but artist 68 (famous) — must never badge.
  assert.equal(isIndie(34, 68), false);
  // Billie Holiday: track 29, artist 64.
  assert.equal(isIndie(29, 64), false);
  // Kelela: track 29, artist 65.
  assert.equal(isIndie(29, 65), false);

  // Raime: track 6, artist 18. Meg Baird: track 4, artist 17.
  assert.equal(isIndie(6, 18), true);
  assert.equal(isIndie(4, 17), true);
  // Widowspeak sits just under the boundary and should still badge.
  assert.equal(isIndie(2, 49), true);

  // A popular track by an obscure artist is still not a "find".
  assert.equal(isIndie(80, 10), false);
  // Exactly at the artist threshold is not below it.
  assert.equal(isIndie(10, ARTIST_INDIE_POPULARITY_THRESHOLD), false);
  assert.equal(isIndie(10, ARTIST_INDIE_POPULARITY_THRESHOLD - 1), true);
});

test('enrichIndie re-decides the badge with one batched artist request', async () => {
  const calls = { artists: 0, urls: [] };
  const fetchImpl = async (url) => {
    if (String(url).includes('accounts.spotify.com')) {
      return ok({ access_token: 'tok', expires_in: 3600 });
    }
    calls.artists += 1;
    calls.urls.push(String(url));
    return ok({
      artists: [
        { id: 'art-Al Green', popularity: 68 },
        { id: 'art-Raime', popularity: 18 },
      ],
    });
  };
  const resolver = createSpotifyResolver(deps(fetchImpl));

  const tracks = [
    { title: 'At Last', artist: 'Al Green', artistId: 'art-Al Green', popularity: 34, indie: true },
    { title: 'This Foundry', artist: 'Raime', artistId: 'art-Raime', popularity: 6, indie: true },
  ];
  const { enriched } = await resolver.enrichIndie(tracks);

  assert.equal(enriched, true);
  assert.equal(calls.artists, 1, 'one batched request for the whole score');
  assert.match(calls.urls[0], /\/v1\/artists\?ids=art-Al%20Green,art-Raime|\/v1\/artists\?ids=art-Al Green,art-Raime/);
  assert.equal(tracks[0].indie, false, 'Al Green is a deep cut, not an indie find');
  assert.equal(tracks[0].artistPopularity, 68);
  assert.equal(tracks[1].indie, true, 'Raime still badges');
});

test('enrichIndie degrades to the track-only rule when the lookup fails', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('accounts.spotify.com')) {
      return ok({ access_token: 'tok', expires_in: 3600 });
    }
    return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) };
  };
  const resolver = createSpotifyResolver(deps(fetchImpl));

  const tracks = [
    { title: 'At Last', artist: 'Al Green', artistId: 'art-Al Green', popularity: 34, indie: true },
  ];
  const { enriched } = await resolver.enrichIndie(tracks);

  assert.equal(enriched, false);
  assert.equal(tracks[0].indie, true, 'the pre-existing verdict survives rather than erroring');
});

/**
 * Regression from the eval: a single 63.6-minute William Basinski piece took
 * a 90-minute score to 140.5 minutes.
 */
test('an over-long track is a miss, so the phase gets backfilled around it', async () => {
  const { fetchImpl } = makeFetch([
    ok(trackHit({ name: 'dlp 1.1', artists: ['William Basinski'], durationMs: 63.6 * 60_000 })),
  ]);
  const resolver = createSpotifyResolver(deps(fetchImpl));

  const { tracks, misses } = await resolver.resolve([
    { title: 'dlp 1.1', artist: 'William Basinski' },
  ]);

  assert.equal(tracks.length, 0);
  assert.equal(misses.length, 1);
  assert.equal(misses[0].reason, 'too_long');
  assert.ok(MAX_TRACK_DURATION_MS === 15 * 60 * 1000, 'the cap is a named constant');
});

test('a shorter edit further down the results is preferred over an over-long one', async () => {
  const { fetchImpl } = makeFetch([
    ok(
      trackHits([
        { id: 'long', name: 'Avril 14th', artists: ['Aphex Twin'], durationMs: 20 * 60_000 },
        { id: 'short', name: 'Avril 14th', artists: ['Aphex Twin'], durationMs: 2 * 60_000 },
      ]),
    ),
  ]);
  const resolver = createSpotifyResolver(deps(fetchImpl));

  const { tracks, misses } = await resolver.resolve([
    { title: 'Avril 14th', artist: 'Aphex Twin' },
  ]);

  assert.equal(misses.length, 0);
  assert.equal(tracks[0].spotifyId, 'short', 'scanning continues past the over-long hit');
  assert.equal(tracks[0].durationMs, 2 * 60_000);
});
