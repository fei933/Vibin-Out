/**
 * TrackResolver — turns model-proposed {title, artist} candidates into real,
 * playable records.
 *
 * This is a provider interface on purpose. The Spotify implementation is the
 * only one today; a Troi/LB Radio provider (see TODOS.md) and a keyless
 * deep-link fallback are meant to slot in behind the same `resolve()` shape
 * without the pipeline noticing.
 *
 * Contract:
 *   resolve(candidates, {signal}) -> {
 *     tracks: Array<candidate & {spotifyId, popularity, durationMs, indie}>,
 *     misses: Array<candidate & {reason}>,
 *     partial: boolean   // true when lookups were abandoned (rate limits)
 *   }
 *
 * It never throws for provider trouble. A rate-limited or broken provider
 * yields a shorter score with `partial: true`, which the page renders as a
 * "shorter than usual" note. A 500 is never an acceptable answer here.
 */
import { verifyMatch } from './matchVerification.js';

export const INDIE_POPULARITY_THRESHOLD = 40;

/**
 * An "indie find" has to be true about the *artist*, not just the track.
 * Track popularity alone badged Al Green's "At Last" (track pop 34) and
 * Billie Holiday's "Don't Explain" (29) as indie finds, which is exactly the
 * kind of claim that makes a curator look unserious — those are deep cuts by
 * famous artists, not discoveries.
 *
 * Calibrated against the ten-fixture eval's own artists (2026-07-27). Artist
 * popularity separates them cleanly, with a wide gap at the boundary:
 *   badge:      Itasca 8, Cross Record 15, Meg Baird 17, Raime 18,
 *               Sarah Davachi 29, Zola Jesus 37, Basinski 41, Widowspeak 49
 *   never:      My Bloody Valentine 55, Nick Drake 61, serpentwithfeet 62,
 *               Billie Holiday 64, Kelela 65, Al Green 68, Etta James 69
 */
export const ARTIST_INDIE_POPULARITY_THRESHOLD = 55;

/**
 * A single 63-minute William Basinski piece pushed one 90-minute score to
 * 140 minutes. Anything this long is a different listening proposition than
 * a track in a playlist, so it is treated as a miss and backfilled around.
 */
export const MAX_TRACK_DURATION_MS = 15 * 60 * 1000;

export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_MAX_ATTEMPTS = 3;
const SEARCH_LIMIT = 5;
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SEARCH_URL = 'https://api.spotify.com/v1/search';
const ARTISTS_URL = 'https://api.spotify.com/v1/artists';
const ARTIST_BATCH_SIZE = 50; // Spotify's per-request maximum
const TOKEN_SAFETY_MARGIN_MS = 60_000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run `worker` over `items` with at most `limit` in flight. Order preserved. */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * @param {number|null} trackPopularity
 * @param {number|null|undefined} artistPopularity omit/null to fall back to the
 *   track-only rule, which is what happens when the artist lookup fails.
 */
export function isIndie(trackPopularity, artistPopularity) {
  if (typeof trackPopularity !== 'number' || trackPopularity >= INDIE_POPULARITY_THRESHOLD) {
    return false;
  }
  if (typeof artistPopularity !== 'number') return true; // degraded, track-only
  return artistPopularity < ARTIST_INDIE_POPULARITY_THRESHOLD;
}

export function isTooLong(durationMs) {
  return typeof durationMs === 'number' && durationMs > MAX_TRACK_DURATION_MS;
}

/**
 * Album artwork rides along in the search response Spotify already answers
 * (`track.album.images`), so keeping it costs zero extra API calls. It is
 * what the v2.1 halo carousel is built from, and on a deliberately neutral
 * page it is where all the colour comes from.
 *
 * Spotify returns roughly 640/300/64px, widest first. We want the middle one:
 * big enough for a carousel tile on a retina screen, small enough that a
 * 20-track score is not megabytes of images.
 */
export const ALBUM_ART_TARGET_WIDTH = 300;

/** @returns {string|null} a URL, or null when the release has no artwork. */
export function pickAlbumArt(images, target = ALBUM_ART_TARGET_WIDTH) {
  if (!Array.isArray(images)) return null;
  const usable = images.filter((image) => typeof image?.url === 'string' && image.url);
  if (!usable.length) return null;

  const sized = usable.filter((image) => typeof image.width === 'number' && image.width > 0);
  if (!sized.length) return usable[0].url; // no dimensions given; take what there is

  let best = sized[0];
  for (const image of sized) {
    if (Math.abs(image.width - target) < Math.abs(best.width - target)) best = image;
  }
  return best.url;
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * @param {object} deps injected in tests: fetchImpl, sleep, now
 */
export function createSpotifyResolver({
  fetchImpl = globalThis.fetch,
  clientId = process.env.CLIENT_ID,
  clientSecret = process.env.CLIENT_SECRET,
  concurrency = DEFAULT_CONCURRENCY,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  sleep = wait,
  now = () => Date.now(),
  market = 'US',
} = {}) {
  let tokenCache = null; // { token, expiresAt } — instance-lifetime, survives warm invocations
  let tokenRequest = null; // the in-flight request, shared by everyone waiting on it

  async function requestToken(signal) {
    if (!clientId || !clientSecret) throw new Error('spotify credentials missing');

    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: 'grant_type=client_credentials',
      signal,
    });
    if (!response.ok) throw new Error(`spotify token request failed: ${response.status}`);
    const body = await response.json();
    tokenCache = {
      token: body.access_token,
      expiresAt: now() + Math.max(0, (body.expires_in ?? 3600) * 1000 - TOKEN_SAFETY_MARGIN_MS),
    };
    return tokenCache.token;
  }

  /**
   * On a cold start every concurrent search sees an empty cache at the same
   * moment, so the in-flight promise is cached alongside the token — without
   * it, `concurrency` simultaneous token POSTs go out and Spotify rate-limits
   * us for the privilege. Cleared on settle so a failed request cannot wedge
   * the cache shut.
   */
  async function getToken(signal) {
    if (tokenCache && tokenCache.expiresAt > now()) return tokenCache.token;
    if (!tokenRequest) {
      tokenRequest = requestToken(signal).finally(() => {
        tokenRequest = null;
      });
    }
    return tokenRequest;
  }

  function retryDelay(attempt, retryAfterHeader) {
    const retryAfter = Number(retryAfterHeader);
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 8000);
    return Math.min(500 * 2 ** attempt, 8000);
  }

  /**
   * `AbortSignal.timeout()` rejects with a **TimeoutError**, not an
   * AbortError — checking only for the latter meant an expired deadline was
   * treated as a transient failure, so every queued candidate went on
   * retry-sleeping against a signal that would never succeed. That is exactly
   * how a request overruns the serverless timeout. Ask the signal directly.
   */
  function isAborted(signal, error) {
    if (signal?.aborted) return true;
    return error?.name === 'AbortError' || error?.name === 'TimeoutError';
  }

  /** @returns {{status:'ok', item}|{status:'miss'}|{status:'rate_limited'}|{status:'aborted'}|{status:'error'}} */
  async function searchOne(candidate, signal) {
    const query = `track:"${candidate.title}" artist:"${candidate.artist}"`;
    const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&type=track&limit=${SEARCH_LIMIT}${
      market ? `&market=${market}` : ''
    }`;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (isAborted(signal)) return { status: 'aborted' };

      let response;
      try {
        const token = await getToken(signal);
        response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, signal });
      } catch (error) {
        if (isAborted(signal, error)) return { status: 'aborted' };
        if (attempt === maxAttempts - 1) return { status: 'error' };
        await sleep(retryDelay(attempt));
        continue;
      }

      if (response.status === 429) {
        if (attempt === maxAttempts - 1) return { status: 'rate_limited' };
        await sleep(retryDelay(attempt, response.headers?.get?.('retry-after')));
        continue;
      }
      if (response.status === 401) {
        tokenCache = null; // token died early; one more attempt with a fresh one
        if (attempt === maxAttempts - 1) return { status: 'error' };
        continue;
      }
      if (!response.ok) {
        if (attempt === maxAttempts - 1) return { status: 'error' };
        await sleep(retryDelay(attempt));
        continue;
      }

      // A truncated or non-JSON 200 must not escape this guarded call: an
      // unhandled rejection here would reject the whole concurrency pool and
      // turn one bad response into a 502 for the entire score.
      let body;
      try {
        body = await response.json();
      } catch (error) {
        if (isAborted(signal, error)) return { status: 'aborted' };
        return { status: 'error' };
      }

      const items = body?.tracks?.items ?? [];
      let sawTooLong = false;
      for (const item of items) {
        const artists = (item.artists ?? []).map((a) => a.name).filter(Boolean);
        if (!verifyMatch(candidate, { title: item.name, artists }).ok) continue;
        // Keep scanning past an over-long hit: a radio edit or single version
        // of the same record is often further down the same result page.
        if (isTooLong(item.duration_ms)) {
          sawTooLong = true;
          continue;
        }
        return { status: 'ok', item, artists };
      }
      return { status: sawTooLong ? 'too_long' : 'miss' };
    }
    return { status: 'error' };
  }

  return {
    name: 'spotify',

    async resolve(candidates, { signal } = {}) {
      const tracks = [];
      const misses = [];
      let partial = false;
      // Once the provider is persistently rate-limiting us — or the deadline
      // has passed — stop asking and return what we already have.
      let abandoned = false;

      const outcomes = await mapWithConcurrency(candidates, concurrency, async (candidate) => {
        if (abandoned || signal?.aborted) return { candidate, result: { status: 'skipped' } };
        const result = await searchOne(candidate, signal);
        if (result.status === 'rate_limited' || result.status === 'aborted') abandoned = true;
        return { candidate, result };
      });

      for (const { candidate, result } of outcomes) {
        if (result.status === 'ok') {
          tracks.push({
            ...candidate,
            spotifyId: result.item.id,
            artistId: result.item.artists?.[0]?.id ?? null,
            albumArt: pickAlbumArt(result.item.album?.images),
            popularity: result.item.popularity ?? null,
            durationMs: result.item.duration_ms ?? null,
            // Provisional: enrichIndie() re-decides this once artist
            // popularity is known. Correct already if that lookup fails.
            indie: isIndie(result.item.popularity),
          });
        } else if (
          result.status === 'rate_limited' ||
          result.status === 'aborted' ||
          result.status === 'skipped'
        ) {
          partial = true;
          misses.push({ ...candidate, reason: result.status });
        } else {
          misses.push({ ...candidate, reason: result.status });
        }
      }

      return { tracks, misses, partial };
    },

    /**
     * Second, batched pass that grounds the indie badge in artist popularity.
     * Called once per score against the finished tracklist, so a 21-track
     * score costs exactly one extra request (Spotify takes 50 ids at a time).
     *
     * Zero LLM involvement by design — the badge is a claim about the world,
     * so it is answered with data, never with the model's self-report.
     *
     * Degrades rather than fails: if the lookup errors, every track keeps the
     * track-only verdict it already has.
     */
    async enrichIndie(tracks, { signal } = {}) {
      const ids = [...new Set(tracks.map((t) => t.artistId).filter(Boolean))];
      if (!ids.length) return { tracks, enriched: false };

      const popularity = new Map();
      try {
        for (const batch of chunk(ids, ARTIST_BATCH_SIZE)) {
          const token = await getToken(signal);
          const response = await fetchImpl(`${ARTISTS_URL}?ids=${batch.join(',')}`, {
            headers: { authorization: `Bearer ${token}` },
            signal,
          });
          if (!response.ok) throw new Error(`spotify artists request failed: ${response.status}`);
          const body = await response.json();
          for (const artist of body?.artists ?? []) {
            if (artist?.id) popularity.set(artist.id, artist.popularity ?? null);
          }
        }
      } catch {
        return { tracks, enriched: false };
      }

      for (const track of tracks) {
        const artistPopularity = popularity.get(track.artistId);
        if (typeof artistPopularity !== 'number') continue;
        track.artistPopularity = artistPopularity;
        track.indie = isIndie(track.popularity, artistPopularity);
      }
      return { tracks, enriched: true };
    },
  };
}

let sharedResolver = null;

/** Process-wide resolver so the client-credentials token is cached between requests. */
export function spotifyResolver() {
  if (!sharedResolver) sharedResolver = createSpotifyResolver();
  return sharedResolver;
}
