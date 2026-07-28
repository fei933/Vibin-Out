/* The pure half of "make this playlist yours".
 *
 * Everything in here is a function of its arguments: PKCE material, the
 * authorize URL, the two strings Spotify puts on a playlist, and the decision
 * of what to do when a step fails. No DOM, no storage, no fetch — those live
 * in export.js and callback.js, which import this.
 *
 * It is an ES module served straight to the browser AND imported by
 * `node --test`. Both runtimes have the same WebCrypto globals (Node ≥ 18), so
 * there is exactly one implementation of the security-relevant parts and the
 * tests exercise the same code the browser runs. Keep it that way: anything
 * added here must run unchanged in both.
 */

export const AUTHORIZE_ENDPOINT = 'https://accounts.spotify.com/authorize';
export const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
export const API_BASE = 'https://api.spotify.com/v1';

/**
 * The entire scope. Not `playlist-modify-public`, not `user-read-private`,
 * not `user-read-email`: this is per-action authorization to write one private
 * playlist, and the consent screen should say exactly that and nothing more.
 * (Design doc premise 1 — Spotify is a destination, never a login provider.)
 */
export const EXPORT_SCOPE = 'playlist-modify-private';

/** Spotify truncates past these; we'd rather choose where the cut lands. */
export const NAME_LIMIT = 100;
export const DESCRIPTION_LIMIT = 300;

/** The API takes at most 100 URIs per add-tracks call. */
export const URI_CHUNK = 100;

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * base64url, unpadded — the encoding RFC 7636 requires for both the verifier
 * and the challenge. Hand-rolled rather than btoa() because btoa is legacy in
 * Node and this is 12 lines that behave identically everywhere.
 *
 * @param {Uint8Array|ArrayBuffer|number[]} input
 * @returns {string}
 */
export function base64url(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64URL[(chunk >> 18) & 63] + B64URL[(chunk >> 12) & 63];
    if (i + 1 < bytes.length) out += B64URL[(chunk >> 6) & 63];
    if (i + 2 < bytes.length) out += B64URL[chunk & 63];
  }
  return out;
}

/**
 * A random base64url token. Used for both the PKCE verifier (48 bytes → 64
 * chars, inside RFC 7636's 43–128 range and entirely within its unreserved
 * alphabet) and the state parameter.
 *
 * The RNG is injectable so a test can pin the output; production always gets
 * crypto.getRandomValues.
 *
 * @param {number} byteLength
 * @param {(array: Uint8Array) => Uint8Array} [fill]
 */
export function randomToken(byteLength = 48, fill) {
  const bytes = new Uint8Array(byteLength);
  if (fill) fill(bytes);
  else crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/**
 * S256 code challenge: base64url(SHA-256(ASCII(verifier))).
 *
 * `crypto.subtle` exists only in a secure context — https, or http://localhost
 * which browsers also treat as secure. On plain http over a LAN address it is
 * undefined, which is a tier-2 trigger rather than a crash (see
 * INSECURE_CONTEXT).
 *
 * @param {string} verifier
 * @param {SubtleCrypto} [subtle]
 * @returns {Promise<string>}
 */
export async function challengeFrom(verifier, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error('no SubtleCrypto — insecure context');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(digest);
}

/**
 * The authorize URL. Every parameter is required on purpose: a missing
 * redirect_uri or challenge produces a Spotify error page we cannot catch
 * (it never redirects back), so it must fail here, loudly, in a test.
 *
 * @param {{clientId: string, redirectUri: string, state: string, codeChallenge: string, scope?: string}} params
 * @returns {string}
 */
export function buildAuthorizeUrl({ clientId, redirectUri, state, codeChallenge, scope = EXPORT_SCOPE }) {
  for (const [key, value] of Object.entries({ clientId, redirectUri, state, codeChallenge })) {
    if (typeof value !== 'string' || !value) throw new TypeError(`buildAuthorizeUrl: missing ${key}`);
  }
  const query = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
  });
  return `${AUTHORIZE_ENDPOINT}?${query.toString()}`;
}

/**
 * The form body for the code→token exchange. No client secret: that is the
 * whole point of PKCE, and the secret stays server-side where it does search.
 *
 * @param {{clientId: string, code: string, redirectUri: string, verifier: string}} params
 * @returns {URLSearchParams}
 */
export function tokenRequestBody({ clientId, code, redirectUri, verifier }) {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
}

function tidy(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cuts at a word boundary where one is close enough to the limit to look chosen. */
function truncate(text, limit) {
  if (text.length <= limit) return text;
  const hard = text.slice(0, Math.max(0, limit - 1));
  const space = hard.lastIndexOf(' ');
  const kept = space > limit * 0.6 ? hard.slice(0, space) : hard;
  return `${kept.replace(/[\s—–,.;:-]+$/, '')}…`;
}

/**
 * @param {string} title the score's title, verbatim if it fits
 * @returns {string}
 */
export function playlistName(title) {
  const clean = tidy(title);
  return clean ? truncate(clean, NAME_LIMIT) : 'a drydown score';
}

/**
 * The description: the model's reading of the scent, then the score's own
 * address — so a playlist that has travelled into someone's library can still
 * be traced back to the reasoning that produced it (positioning axis 3: this
 * is an artifact, not a session).
 *
 * Spotify strips angle brackets from descriptions and counts characters after
 * that, so they go first. The URL is never truncated: half a link is worse
 * than no link, so when the budget is too tight the link is dropped whole.
 *
 * @param {string} interpretation
 * @param {string} [url]
 * @param {number} [limit]
 */
export function playlistDescription(interpretation, url = '', limit = DESCRIPTION_LIMIT) {
  const text = tidy(interpretation).replace(/[<>]/g, '');
  const link = tidy(url);
  if (!link) return truncate(text, limit);
  if (!text) return link.length <= limit ? link : '';

  const joiner = ' · ';
  const budget = limit - link.length - joiner.length;
  // Under ~24 characters the reading is a stub, and a stub plus a URL reads
  // like a broken string. Keep the words, drop the link.
  if (budget < 24) return truncate(text, limit);
  return `${truncate(text, budget)}${joiner}${link}`;
}

/**
 * @param {string[]} ids Spotify track ids
 * @returns {string[]} `spotify:track:<id>` URIs, blanks dropped
 */
export function trackUris(ids) {
  return (ids ?? []).filter((id) => typeof id === 'string' && id).map((id) => `spotify:track:${id}`);
}

/**
 * @param {string[]} uris
 * @param {number} [size]
 * @returns {string[][]}
 */
export function chunk(uris, size = URI_CHUNK) {
  const out = [];
  for (let i = 0; i < uris.length; i += size) out.push(uris.slice(i, i + size));
  return out;
}

/* --- failure taxonomy -----------------------------------------------------
 *
 * The export has exactly two outcomes: a playlist in someone's library, or the
 * list on this page. Everything below the first row is the second outcome —
 * what differs is only the sentence and whether the button should try Spotify
 * again on the next click.
 */

export const FAILURE = {
  DECLINED: 'declined', // ?error=access_denied — refused consent, or not on the allowlist
  NOT_ALLOWLISTED: 'not_allowlisted', // 403 — the five-user dev-mode wall
  UNAUTHORIZED: 'unauthorized', // 401 — token expired or revoked mid-flight
  RATE_LIMITED: 'rate_limited', // 429
  TOKEN_EXCHANGE: 'token_exchange', // /api/token said no
  STATE_MISMATCH: 'state_mismatch', // the round trip did not come back intact
  NETWORK: 'network', // fetch rejected
  INSECURE_CONTEXT: 'insecure_context', // no crypto.subtle: plain http, not localhost
  NO_CLIENT_ID: 'no_client_id', // key death, or the id was never injected
  UNKNOWN: 'unknown',
};

/**
 * Lowercase, matter-of-fact, and never sorry: the list is a real answer, not a
 * consolation. Each sentence names what happened and points at what is there.
 */
const DECISIONS = {
  [FAILURE.DECLINED]: { note: 'nothing left for spotify, then. the tracks are here —', reauth: true },
  [FAILURE.NOT_ALLOWLISTED]: {
    note: 'spotify keeps this app to five listeners. the tracks are here, and each one opens over there —',
    reauth: false,
  },
  [FAILURE.UNAUTHORIZED]: {
    note: 'that permission lapsed. the tracks are here; the button will ask spotify again.',
    reauth: true,
  },
  [FAILURE.RATE_LIMITED]: { note: 'spotify is busy. the tracks are here —', reauth: true },
  [FAILURE.TOKEN_EXCHANGE]: { note: 'spotify never finished the handshake. the tracks are here —', reauth: true },
  [FAILURE.STATE_MISMATCH]: { note: 'that round trip came back wrong. the tracks are here —', reauth: true },
  [FAILURE.NETWORK]: { note: 'no line out to spotify. the tracks are here —', reauth: true },
  [FAILURE.INSECURE_CONTEXT]: {
    note: 'spotify only hands out permission over https. the tracks are here —',
    reauth: false,
  },
  // The key is gone (or was never set). There is nothing to explain and nobody
  // to blame: the list simply IS the feature on this page.
  [FAILURE.NO_CLIENT_ID]: { note: '', reauth: false },
  [FAILURE.UNKNOWN]: { note: 'that didn’t land in your account. the tracks are here —', reauth: true },
};

/**
 * The tier-2 decision. Total by construction — an unrecognised kind is
 * UNKNOWN, which still falls into the list rather than onto an error page.
 *
 * @param {string} kind one of FAILURE
 * @returns {{tier: 1|2, kind: string, note: string, reauth: boolean}}
 */
export function classifyFailure(kind) {
  const known = Object.prototype.hasOwnProperty.call(DECISIONS, kind) ? kind : FAILURE.UNKNOWN;
  return { tier: 2, kind: known, ...DECISIONS[known] };
}

/**
 * HTTP status → failure kind, for any Spotify call (token exchange included:
 * a 403 there is the same dev-mode wall).
 *
 * @param {number} status
 * @returns {string}
 */
export function failureKindFromStatus(status) {
  if (status === 401) return FAILURE.UNAUTHORIZED;
  if (status === 403) return FAILURE.NOT_ALLOWLISTED;
  if (status === 429) return FAILURE.RATE_LIMITED;
  return FAILURE.UNKNOWN;
}

/**
 * `?error=` on the callback → failure kind. Spotify sends `access_denied` both
 * when a user refuses consent and when a dev-mode app turns away someone who
 * is not on the five-person allowlist; the two are indistinguishable from
 * here, which is why the DECLINED sentence has to be true of both.
 *
 * @param {string} error
 */
export function failureKindFromAuthError(error) {
  return error === 'access_denied' ? FAILURE.DECLINED : FAILURE.UNKNOWN;
}

/** A slug is the only thing we will navigate back to. Guards the callback's return hop. */
export function isSafeSlug(slug) {
  return typeof slug === 'string' && /^[a-z0-9][a-z0-9-]{0,120}$/.test(slug);
}
