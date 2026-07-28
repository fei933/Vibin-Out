/* The four things the export keeps between two page loads, and nowhere else.
 *
 * sessionStorage, not localStorage and not a cookie: the token must die with
 * the tab and must never be attached to a request to our own server. Nothing
 * here is ever sent anywhere — the score page and /callback are the only
 * readers, and both run on this origin.
 *
 * Every access is guarded. Private mode, a blocked-storage policy and a full
 * quota all present as a throw from sessionStorage, and none of them are
 * allowed to take the score page down with them: a failed read is simply
 * "nothing stored", which routes the export into tier 2.
 */

export const KEYS = {
  verifier: 'vibin.export.verifier', // PKCE code_verifier, single use
  state: 'vibin.export.state', // CSRF state, single use
  pending: 'vibin.export.pending', // the score slug we left from
  token: 'vibin.export.token', // {accessToken, expiresAt}
  result: 'vibin.export.result', // one-shot verdict from /callback
};

/** Milliseconds of slack: a token about to expire is treated as expired. */
const EXPIRY_SLACK_MS = 30_000;

export function read(key) {
  try {
    return window.sessionStorage.getItem(key);
  } catch (error) {
    return null;
  }
}

/** @returns {boolean} false when storage refused — the caller must not proceed. */
export function write(key, value) {
  try {
    window.sessionStorage.setItem(key, value);
    return true;
  } catch (error) {
    return false;
  }
}

export function drop(key) {
  try {
    window.sessionStorage.removeItem(key);
  } catch (error) {
    /* nothing stored, nothing to remove */
  }
}

/** Read and delete in one move: state, verifier and verdict are all single-use. */
export function take(key) {
  const value = read(key);
  drop(key);
  return value;
}

export function saveToken(accessToken, expiresInSeconds) {
  return write(
    KEYS.token,
    JSON.stringify({
      accessToken,
      expiresAt: Date.now() + Number(expiresInSeconds || 0) * 1000,
    }),
  );
}

/** @returns {{accessToken: string, expiresAt: number}|null} */
export function storedToken() {
  const raw = read(KEYS.token);
  if (!raw) return null;
  try {
    const token = JSON.parse(raw);
    if (!token || !token.accessToken || Date.now() > Number(token.expiresAt) - EXPIRY_SLACK_MS) {
      drop(KEYS.token);
      return null;
    }
    return token;
  } catch (error) {
    drop(KEYS.token);
    return null;
  }
}

/** Belt and braces after a failed exchange or a 401: leave nothing half-valid. */
export function clearAuth() {
  drop(KEYS.verifier);
  drop(KEYS.state);
  drop(KEYS.token);
}
