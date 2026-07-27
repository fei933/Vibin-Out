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
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_MAX_ATTEMPTS = 3;
const SEARCH_LIMIT = 5;
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SEARCH_URL = 'https://api.spotify.com/v1/search';
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

export function isIndie(popularity) {
  return typeof popularity === 'number' && popularity < INDIE_POPULARITY_THRESHOLD;
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
      for (const item of items) {
        const artists = (item.artists ?? []).map((a) => a.name).filter(Boolean);
        if (verifyMatch(candidate, { title: item.name, artists }).ok) {
          return { status: 'ok', item, artists };
        }
      }
      return { status: 'miss' };
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
            popularity: result.item.popularity ?? null,
            durationMs: result.item.duration_ms ?? null,
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
  };
}

let sharedResolver = null;

/** Process-wide resolver so the client-credentials token is cached between requests. */
export function spotifyResolver() {
  if (!sharedResolver) sharedResolver = createSpotifyResolver();
  return sharedResolver;
}
