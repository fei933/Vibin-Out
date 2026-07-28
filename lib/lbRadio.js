/**
 * ListenBrainz LB Radio — a discovery provider for the deep-cuts dial.
 *
 * What it is: instead of the model naming records from memory, the model names
 * the *sound* (weighted tags) and ListenBrainz's LB Radio returns real
 * recordings from the MusicBrainz corpus. `mode=hard` is the popularity dial —
 * the docs describe easy/medium/hard as slices of the ranked data, hard being
 * the tail end — which is exactly what "deep cuts" has always meant here.
 *
 * Ground truth for everything below is the live probe of 2026-07-27:
 *
 *   - The endpoint is `https://api.listenbrainz.org/1/explore/lb-radio`. It is
 *     NOT on `labs.api.listenbrainz.org` (that host has no such route), and a
 *     trailing slash 404s.
 *   - It is credential-gated: without `Authorization: Token <uuid>` every call
 *     is 401 ("Due to AI scraper's causing undue traffic on our sites, provide
 *     an Auth token"). A bogus token is also 401 — the token is validated, not
 *     merely present. The token is free and self-serve (a listenbrainz.org
 *     account → Settings → user token), but it is still an account secret, so
 *     this provider ships OFF and stays inert until someone sets one.
 *   - Response shape: `payload.jspf.playlist.track[]`, where JSPF calls the
 *     artist `creator` and `identifier` is an ARRAY of MusicBrainz URLs (older
 *     versions emitted a bare string — both are accepted below).
 *
 * The provider is deliberately incapable of breaking a generation: every
 * failure path here ends in the caller falling back to the model's own track
 * choices. It throws typed errors so the caller can log *why*, and the caller
 * catches all of them.
 */

export const LB_RADIO_URL = 'https://api.listenbrainz.org/1/explore/lb-radio';

/** deep cuts == the tail end of the ranked data. See the probe findings, §4. */
export const LB_MODE = 'hard';

/** One phase's fetch. Short on purpose: three of these ride inside the pipeline budget. */
export const LB_TIMEOUT_MS = 8_000;

/** Tags are LLM-authored and reach a query DSL, so they are capped hard. */
export const MAX_TAG_LENGTH = 32;
export const MAX_TAGS_PER_PHASE = 5;
export const MAX_TAG_WEIGHT = 3;

/** Matches `trackSchema`'s ceiling, so nothing from LB can overflow the score schema. */
const MAX_FIELD_LENGTH = 160;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/**
 * The four characters that are STRUCTURAL in the LB Radio prompt DSL
 * (`element:(values):weight:options`) plus `#`, its shorthand sigil.
 *
 * A tag containing any of them is dropped, not laundered. These tags are
 * written by a model that has just read visitor-supplied text, so a tag like
 * `ambient) artist:(some famous name` is not a typo — it is the shape of an
 * injection into the query language. Stripping would turn it into a harmless
 * but meaningless tag that still burns a slot; rejecting says what happened.
 */
const DSL_CHARS = /[():,#]/;
/** Everything outside this is scrubbed to a space after the rejection test. */
const ALLOWED_CHARS = /[^a-z0-9 &'+-]/g;

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class LbRadioError extends Error {
  /** @param {string} reason a short machine-readable cause, safe to log */
  constructor(reason, message = reason, options = {}) {
    super(message, options);
    this.name = 'LbRadioError';
    this.reason = reason;
  }
}

/**
 * One tag, cleaned or rejected. Never throws.
 *
 * Accents are folded rather than scrubbed ("björk" → "bjork") so a legitimate
 * tag is not turned into rubble; anything still outside the ASCII allowlist
 * becomes a space.
 *
 * @param {unknown} raw
 * @returns {string|null} the usable tag, or null when it must be dropped
 */
export function sanitizeTag(raw) {
  if (typeof raw !== 'string') return null;
  if (DSL_CHARS.test(raw) || CONTROL_CHARS.test(raw)) return null;

  const folded = raw
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

  const cleaned = folded.replace(ALLOWED_CHARS, ' ').replace(/\s+/g, ' ').trim();

  if (!cleaned) return null;
  if (cleaned.length > MAX_TAG_LENGTH) return null;
  if (!/[a-z0-9]/.test(cleaned)) return null;
  return cleaned;
}

function sanitizeWeight(raw) {
  const weight = Math.round(Number(raw));
  if (!Number.isFinite(weight)) return 1;
  return Math.min(MAX_TAG_WEIGHT, Math.max(1, weight));
}

/**
 * A phase's tag list, cleaned, de-duplicated and capped.
 * @param {unknown} tags
 * @returns {Array<{tag: string, weight: number}>}
 */
export function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of tags) {
    if (out.length >= MAX_TAGS_PER_PHASE) break;
    const tag = sanitizeTag(typeof entry === 'string' ? entry : entry?.tag);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push({ tag, weight: sanitizeWeight(typeof entry === 'string' ? 1 : entry?.weight) });
  }
  return out;
}

/**
 * Build the LB Radio prompt from weighted tags.
 *
 * One ELEMENT per tag rather than one element listing every tag: multiple
 * values inside a single `tag:(a,b)` element are ANDed by default (a recording
 * must carry all of them), which for three or four tags returns almost
 * nothing. Separate elements are blended, and that is where weight means
 * something — the docs put it plainly: "a term with weight 3 contributes 3x
 * more recordings than a term with weight 1".
 *
 * Weight 1 is the default, so it is left off — `tag:(ambient)` is the exact
 * form the documentation uses.
 *
 * @param {Array<{tag: string, weight: number}>} tags already sanitized
 */
export function buildRadioPrompt(tags) {
  const parts = tags.map(({ tag, weight }) => (weight > 1 ? `tag:(${tag}):${weight}` : `tag:(${tag})`));
  if (!parts.length) throw new LbRadioError('no_tags', 'no usable tags for the prompt');
  return parts.join(' ');
}

/**
 * Percent-encode a query value with nothing left to interpret.
 *
 * `URLSearchParams` writes a space as `+`, and `encodeURIComponent` leaves
 * `(` and `)` literal. Both forms were confirmed live to reach this endpoint's
 * auth gate, so neither is wrong — but a tag arriving as `field+recording`
 * because some layer read `+` literally would match nothing in the corpus
 * while looking perfectly healthy from here, and we cannot see the difference
 * without a token. Encoding all three characters leaves one reading.
 */
function encodeQueryValue(value) {
  return encodeURIComponent(value).replace(/[()]/g, (char) => (char === '(' ? '%28' : '%29'));
}

/** @returns {string} the full request URL, prompt fully percent-encoded. */
export function buildRadioUrl(tags, { mode = LB_MODE, baseUrl = LB_RADIO_URL } = {}) {
  return `${baseUrl}?prompt=${encodeQueryValue(buildRadioPrompt(tags))}&mode=${encodeQueryValue(mode)}`;
}

/**
 * JSPF `identifier` is an array of MusicBrainz URLs; older LB versions emitted
 * a bare string. Both are accepted, and the value is only trusted if it ends
 * in something MBID-shaped.
 * @returns {string|null}
 */
export function mbidFromIdentifier(identifier) {
  const candidates = Array.isArray(identifier) ? identifier : [identifier];
  for (const value of candidates) {
    if (typeof value !== 'string') continue;
    const match = value.trim().match(UUID);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

function cleanField(value) {
  if (typeof value !== 'string') return null;
  if (CONTROL_CHARS.test(value)) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_FIELD_LENGTH) return null;
  return trimmed;
}

/**
 * Pull candidates out of an LB Radio response body. Tolerates every shape of
 * malformed answer by returning fewer (or zero) candidates — a thin result is
 * a fallback, never an exception.
 *
 * @returns {Array<{title: string, artist: string, recordingMbid: string|null}>}
 */
export function parseJspfTracks(body) {
  const raw = body?.payload?.jspf?.playlist?.track;
  if (!Array.isArray(raw)) return [];

  const seen = new Set();
  const tracks = [];
  for (const entry of raw) {
    const title = cleanField(entry?.title);
    // JSPF calls the artist "creator". Reading `entry.artist` here would
    // silently yield an empty provider — the single easiest bug in this file.
    const artist = cleanField(entry?.creator);
    if (!title || !artist) continue;
    // Separated by a character `cleanField` has already refused to pass, so
    // no title/artist pair can collide with a different one by concatenation.
    // Written as an escape: a raw NUL in the source makes git treat this whole
    // file as binary, which costs every future reviewer the diff.
    const key = `${title.toLowerCase()}\u0000${artist.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tracks.push({ title, artist, recordingMbid: mbidFromIdentifier(entry?.identifier) });
  }
  return tracks;
}

/**
 * Provider configuration, read from the environment.
 *
 * OFF is the default and the only state that needs no explanation: the
 * endpoint demands a token we do not ship. Turning it on is two variables.
 */
export function lbRadioConfig(env = process.env) {
  const flag = String(env.LB_RADIO ?? '').trim().toLowerCase();
  const token = String(env.LB_TOKEN ?? '').trim();
  return {
    /** The only discovery mode this provider serves. */
    discovery: 'deepcuts',
    mode: LB_MODE,
    token,
    enabled: flag === 'deepcuts' && token.length > 0,
  };
}

function isAbort(error) {
  return error?.name === 'AbortError' || error?.name === 'TimeoutError';
}

/**
 * @param {object} deps injected in tests: fetchImpl, sleep
 */
export function createLbRadio({
  token = '',
  enabled = Boolean(token),
  mode = LB_MODE,
  fetchImpl = globalThis.fetch,
  baseUrl = LB_RADIO_URL,
  timeoutMs = LB_TIMEOUT_MS,
  sleep = wait,
  retryDelayMs = 250,
} = {}) {
  /**
   * One attempt. Returns candidates, or throws an LbRadioError carrying
   * whether another attempt could possibly help.
   */
  async function attempt(tags, signal) {
    const url = buildRadioUrl(tags, { mode, baseUrl });
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;

    let response;
    try {
      response = await fetchImpl(url, {
        headers: { authorization: `Token ${token}`, accept: 'application/json' },
        signal: combined,
      });
    } catch (error) {
      /**
       * A blown deadline is NOT retried. It is a statement about the time
       * budget, not a transient hiccup: a second 8s attempt would spend 16s of
       * a generation to reach the same fallback we can reach now. Genuine
       * network errors (DNS, connection reset) do get the one retry.
       */
      if (isAbort(error)) throw new LbRadioError('timeout', 'lb-radio timed out', { cause: error });
      const networkError = new LbRadioError('network', 'lb-radio unreachable', { cause: error });
      networkError.retryable = true;
      throw networkError;
    }

    /**
     * 5xx is COMMON here, not exotic. Probing one unchanged URL six times in a
     * row (2026-07-28) returned 401, 401, 401, then 500, 500, 500 — the host
     * starts answering `{"code":500,"error":"An unknown error occured."}` under
     * repeated requests from one address, and recovers on its own. So a 500
     * says "ask again in a moment", which is exactly one retry followed by a
     * fallback, and never a reason to fail a generation.
     */
    if (response.status >= 500) {
      const error = new LbRadioError('server_error', `lb-radio ${response.status}`);
      error.retryable = true;
      throw error;
    }
    // 400 (bad prompt) and 401 (bad or missing token) are PERMANENT — the same
    // request will fail identically forever, so retrying only burns budget.
    if (!response.ok) throw new LbRadioError('rejected', `lb-radio ${response.status}`);

    let body;
    try {
      body = await response.json();
    } catch (error) {
      if (isAbort(error)) throw new LbRadioError('timeout', 'lb-radio body timed out', { cause: error });
      throw new LbRadioError('bad_body', 'lb-radio returned unreadable JSON', { cause: error });
    }

    return parseJspfTracks(body);
  }

  return {
    name: 'lb-radio',
    enabled,
    mode,

    /**
     * Candidates for one phase.
     * @param {Array<{tag: string, weight: number}>} tags sanitized tags
     * @returns {Promise<Array<{title: string, artist: string, recordingMbid: string|null}>>}
     * @throws {LbRadioError}
     */
    async tracksForTags(tags, { signal } = {}) {
      if (!enabled) throw new LbRadioError('disabled', 'lb-radio provider is off');
      const usable = sanitizeTags(tags);
      if (!usable.length) throw new LbRadioError('no_tags', 'no usable tags');

      for (let tries = 0; ; tries += 1) {
        try {
          return await attempt(usable, signal);
        } catch (error) {
          const canRetry = error?.retryable === true && tries === 0 && !signal?.aborted;
          if (!canRetry) throw error;
          await sleep(retryDelayMs);
        }
      }
    },
  };
}

/**
 * The provider the pipeline uses by default. Always returns an object, so no
 * caller has to null-check; `enabled` is false unless both variables are set.
 */
export function lbRadioFromEnv(env = process.env) {
  const config = lbRadioConfig(env);
  return createLbRadio({ token: config.token, enabled: config.enabled, mode: config.mode });
}
