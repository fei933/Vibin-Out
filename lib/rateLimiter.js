/**
 * Hand-rolled fixed-window rate limiter over a single Mongo collection.
 *
 * Two windows, both tunable constants:
 *   - per IP:  PER_IP_LIMIT scores per PER_IP_WINDOW_MS
 *   - global:  GLOBAL_LIMIT scores per GLOBAL_WINDOW_MS
 *
 * FAIL CLOSED. If the store is unreachable we refuse to generate. A hobby
 * site pausing during a rare Atlas outage is acceptable; an unmetered LLM
 * spend on a public endpoint is not.
 *
 * Counters are incremented with a single atomic upsert per window, so
 * concurrent serverless instances cannot race past the cap.
 */

export const PER_IP_LIMIT = 5;
export const PER_IP_WINDOW_MS = 60 * 60 * 1000; // 1 hour
export const GLOBAL_LIMIT = 100;
export const GLOBAL_WINDOW_MS = 24 * 60 * 60 * 1000; // 1 day
export const GLOBAL_KEY = 'global';

const noop = () => {};

function windowStart(now, windowMs) {
  return Math.floor(now / windowMs) * windowMs;
}

/** The driver returns the doc directly (v6) or wrapped in {value} (v4/v5). */
function unwrap(result) {
  if (result && typeof result === 'object' && 'value' in result && !('count' in result)) {
    return result.value;
  }
  return result;
}

/**
 * @param {object} options
 * @param {() => Promise<object>} options.getCollection resolves a collection-like
 *   object exposing findOneAndUpdate/updateOne. Injected in tests.
 */
export function createRateLimiter({
  getCollection,
  now = () => Date.now(),
  perIpLimit = PER_IP_LIMIT,
  perIpWindowMs = PER_IP_WINDOW_MS,
  globalLimit = GLOBAL_LIMIT,
  globalWindowMs = GLOBAL_WINDOW_MS,
  onError = noop,
} = {}) {
  async function bump(collection, key, windowMs, at) {
    const start = windowStart(at, windowMs);
    const doc = unwrap(
      await collection.findOneAndUpdate(
        { _id: `${key}:${start}` },
        {
          $inc: { count: 1 },
          $setOnInsert: { expiresAt: new Date(start + windowMs) },
        },
        { upsert: true, returnDocument: 'after' },
      ),
    );
    // A driver configured to return the pre-update doc (or nothing on insert)
    // would understate the count; treat a missing count as the first hit.
    return doc?.count ?? 1;
  }

  async function refund(collection, key, windowMs, at) {
    const start = windowStart(at, windowMs);
    try {
      await collection.updateOne(
        { _id: `${key}:${start}`, count: { $gt: 0 } },
        { $inc: { count: -1 } },
      );
    } catch (error) {
      onError(error); // a lost refund costs the user one slot, never correctness
    }
  }

  return {
    /**
     * @returns {Promise<{allowed: true, refund: () => Promise<void>}
     *          | {allowed: false, reason: 'cooldown', scope: string}>}
     */
    async check(ip) {
      const at = now();
      const ipKey = `ip:${ip || 'unknown'}`;
      let collection;

      try {
        collection = await getCollection();
      } catch (error) {
        onError(error);
        return { allowed: false, reason: 'cooldown', scope: 'store_unavailable' };
      }

      let ipCount;
      try {
        ipCount = await bump(collection, ipKey, perIpWindowMs, at);
      } catch (error) {
        onError(error);
        return { allowed: false, reason: 'cooldown', scope: 'store_unavailable' };
      }
      if (ipCount > perIpLimit) {
        return { allowed: false, reason: 'cooldown', scope: 'ip' };
      }

      let globalCount;
      try {
        globalCount = await bump(collection, GLOBAL_KEY, globalWindowMs, at);
      } catch (error) {
        onError(error);
        await refund(collection, ipKey, perIpWindowMs, at);
        return { allowed: false, reason: 'cooldown', scope: 'store_unavailable' };
      }
      if (globalCount > globalLimit) {
        // Not this visitor's fault — give their hourly slot back.
        await refund(collection, ipKey, perIpWindowMs, at);
        return { allowed: false, reason: 'cooldown', scope: 'global' };
      }

      let refunded = false;
      return {
        allowed: true,
        /** Called when the generation failed, so the attempt costs nothing. */
        async refund() {
          if (refunded) return;
          refunded = true;
          await refund(collection, ipKey, perIpWindowMs, at);
        },
      };
    },
  };
}

/** Best-effort client IP behind Vercel's proxy (app.set('trust proxy', 1)). */
export function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}
