/* /callback — the return hop, which exists for about a second.
 *
 * Spotify sends the browser back here with `?code=…&state=…` (or `?error=…`).
 * This file verifies the state, trades the code for a token against
 * accounts.spotify.com using the PKCE verifier this tab stored, keeps the
 * token in sessionStorage, and goes back to the score the listener left from.
 *
 * The exchange is a browser fetch straight to Spotify. Our server is not in the
 * path and never holds a token — that is the condition on which this feature
 * was allowed to exist (design doc v2.1 §4).
 *
 * There is exactly one way out of every branch: back to the score page, with a
 * verdict in sessionStorage that the export picks up. This page never shows an
 * error, because an error page is precisely what tier 2 exists to avoid.
 */
import { KEYS, clearAuth, read, saveToken, take, write } from './export-store.js';
import { FAILURE, TOKEN_ENDPOINT, failureKindFromAuthError, isSafeSlug, tokenRequestBody } from './spotify-export-core.js';

const root = document.getElementById('callback');
if (root) finish(root.getAttribute('data-client-id') || '');

async function finish(clientId) {
  // Read the destination BEFORE anything can fail, so every exit has one.
  const pending = read(KEYS.pending);
  const back = isSafeSlug(pending) ? `/score/${pending}` : '/';

  function leave(verdict) {
    write(KEYS.result, verdict);
    if (verdict !== 'ok') clearAuth();
    // replace, not assign: the callback URL carries an authorization code and
    // has no business in anyone's back button.
    window.location.replace(back);
  }

  try {
    const query = new URLSearchParams(window.location.search);
    const error = query.get('error');
    if (error) {
      leave(failureKindFromAuthError(error));
      return;
    }

    const code = query.get('code');
    const state = query.get('state');
    // Single-use, both of them: taken here whatever happens next, so a
    // replayed callback URL has nothing left to match against.
    const expectedState = take(KEYS.state);
    const verifier = take(KEYS.verifier);

    if (!code || !state || !expectedState || state !== expectedState) {
      leave(FAILURE.STATE_MISMATCH);
      return;
    }
    if (!verifier || !clientId) {
      leave(FAILURE.TOKEN_EXCHANGE);
      return;
    }

    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenRequestBody({
        clientId,
        code,
        // Must be byte-identical to the one sent to /authorize, or Spotify
        // rejects the exchange.
        redirectUri: `${window.location.origin}/callback`,
        verifier,
      }),
    });

    if (!response.ok) {
      leave(FAILURE.TOKEN_EXCHANGE);
      return;
    }

    const payload = await response.json();
    if (!payload || !payload.access_token || !saveToken(payload.access_token, payload.expires_in)) {
      leave(FAILURE.TOKEN_EXCHANGE);
      return;
    }

    leave('ok');
  } catch (networkOrParseFailure) {
    leave(FAILURE.NETWORK);
  }
}
