/* "Make this playlist yours" — the score page's half of the Spotify export.
 *
 * Two tiers, one button.
 *
 *   Tier 1  Authorization Code + PKCE in this tab, scope playlist-modify-private
 *           only, token in sessionStorage. Creates a private playlist in the
 *           listener's own account: score title, the interpretation as the
 *           description, the tracks in playing order.
 *   Tier 2  The list, right here — copyable as plain text, every record a
 *           keyless "open in spotify" search link. Not an error state: it is
 *           what everyone outside the five-user dev-mode allowlist gets, what
 *           a declined consent gets, and what this page becomes for good on
 *           the day the key dies. Its markup is server-rendered, so it is on
 *           the page before this file runs and works with the script dead.
 *
 * The rule that outranks the feature: NOTHING in here may break the score.
 * Every entry point is wrapped, every storage access is guarded, and the
 * module returns immediately if the section is not on the page.
 */
import { KEYS, clearAuth, storedToken, take, write } from './export-store.js';
import {
  API_BASE,
  FAILURE,
  buildAuthorizeUrl,
  challengeFrom,
  chunk,
  classifyFailure,
  failureKindFromStatus,
  isSafeSlug,
  playlistDescription,
  playlistName,
  randomToken,
  trackUris,
} from './spotify-export-core.js';

const section = document.getElementById('export');
if (section) start(section);

function start(root) {
  const button = document.getElementById('export-start');
  const note = document.getElementById('export-note');
  const fallback = document.getElementById('export-fallback');
  const copyButton = document.getElementById('export-copy');
  const copyNote = document.getElementById('export-copy-note');
  const textarea = document.getElementById('export-text');
  const lede = document.getElementById('export-lede');
  const done = document.getElementById('export-done');
  const slug = root.getAttribute('data-slug') || '';
  const clientId = root.getAttribute('data-client-id') || '';
  const redirectUri = `${window.location.origin}/callback`;

  function announce(target, message) {
    if (!target) return;
    target.textContent = message || '';
    target.hidden = !message;
  }

  /** The section's own line: what just happened to the export. */
  function say(message) {
    announce(note, message);
  }

  /* Same contract as share.js: the page is the single source, so an exported
     playlist can never disagree with the score printed above it. */
  function text(node) {
    return node ? node.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  function readTracks() {
    const out = [];
    const items = document.querySelectorAll('#score li.track[data-spotify-id]');
    for (let i = 0; i < items.length; i += 1) {
      out.push({
        id: items[i].getAttribute('data-spotify-id'),
        title: text(items[i].querySelector('.track-title')),
        artist: text(items[i].querySelector('.track-artist')),
      });
    }
    return out;
  }

  /** The whole of tier 2: reveal the list, say the one true sentence, stop. */
  function toTierTwo(kind) {
    const decision = classifyFailure(kind);
    if (fallback) fallback.hidden = false;
    say(decision.note);
    if (button) {
      button.disabled = false;
      button.textContent = button.getAttribute('data-label') || button.textContent;
      // A button that can only fail again is worse than no button. Where the
      // wall is structural — the five-user cap, no https, no key — it goes
      // away and the list stands on its own.
      if (!decision.reauth) {
        button.hidden = true;
        // ...and the paragraph above stops offering it. Leaving "put this in
        // your own Spotify" over a list that exists precisely because you
        // cannot is the one thing that would make tier 2 read as a failure.
        const instead = lede && lede.getAttribute('data-tier2');
        if (instead) lede.textContent = instead;
      }
    }
    return decision;
  }

  /* --- copy the list ------------------------------------------------------ */

  if (copyButton && textarea) {
    copyButton.addEventListener('click', () => {
      const reveal = () => {
        // No clipboard API, or the browser refused it. Show the text and
        // select it: Ctrl/Cmd-C is the floor this never falls below.
        textarea.hidden = false;
        textarea.focus();
        textarea.select();
        announce(copyNote, 'select and copy — it’s all there.');
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
          .writeText(textarea.value)
          .then(() => announce(copyNote, 'the list is on your clipboard.'), reveal);
      } else {
        reveal();
      }
    });
  }

  /* --- tier 1 ------------------------------------------------------------- */

  async function authorize() {
    const verifier = randomToken(48);
    const state = randomToken(16);
    // Without storage the round trip cannot be verified on the way back, so it
    // is not started at all — an unverifiable state parameter is no state
    // parameter.
    if (!write(KEYS.verifier, verifier) || !write(KEYS.state, state)) {
      toTierTwo(FAILURE.UNKNOWN);
      return;
    }
    write(KEYS.pending, slug);
    const codeChallenge = await challengeFrom(verifier);
    window.location.assign(buildAuthorizeUrl({ clientId, redirectUri, state, codeChallenge }));
  }

  async function call(path, token, init = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        'content-type': 'application/json',
        ...(init.headers || {}),
      },
    });
    if (!response.ok) {
      const error = new Error(`spotify ${response.status}`);
      error.kind = failureKindFromStatus(response.status);
      // A revoked token is worth nothing; drop it so the next click re-asks.
      if (response.status === 401) clearAuth();
      throw error;
    }
    return response.status === 204 ? null : response.json();
  }

  async function exportPlaylist(token) {
    if (button) {
      button.disabled = true;
      button.textContent = 'making it yours…';
    }
    say('');

    const me = await call('/me', token);
    const playlist = await call(`/users/${encodeURIComponent(me.id)}/playlists`, token, {
      method: 'POST',
      body: JSON.stringify({
        name: playlistName(text(document.querySelector('#score .score-head h1'))),
        // Private, always. The scope cannot make a public playlist and the
        // listener did not ask to publish anything.
        public: false,
        description: playlistDescription(
          text(document.querySelector('#score .interpretation')),
          `${window.location.origin}/score/${slug}`,
        ),
      }),
    });

    const uris = trackUris(readTracks().map((track) => track.id));
    for (const batch of chunk(uris)) {
      // Sequential on purpose: the add-tracks endpoint appends, so parallel
      // batches would land in whatever order they finished and the drydown
      // would arrive shuffled.
      // eslint-disable-next-line no-await-in-loop
      await call(`/playlists/${encodeURIComponent(playlist.id)}/tracks`, token, {
        method: 'POST',
        body: JSON.stringify({ uris: batch }),
      });
    }

    const href = playlist.external_urls && playlist.external_urls.spotify;
    if (button) button.hidden = true;
    say('');
    if (done) {
      const link = done.querySelector('a');
      if (link && href) link.href = href;
      else if (link) link.remove();
      done.hidden = false;
    }
  }

  async function run(token) {
    try {
      await exportPlaylist(token);
    } catch (error) {
      toTierTwo(error && error.kind ? error.kind : FAILURE.NETWORK);
    }
  }

  /* --- entry points ------------------------------------------------------- */

  if (!clientId) {
    // Key death, or an id that was never injected. The server already rendered
    // the list visible; this only makes sure nothing below runs.
    if (fallback) fallback.hidden = false;
    return;
  }

  if (!window.crypto || !window.crypto.subtle) {
    toTierTwo(FAILURE.INSECURE_CONTEXT);
    return;
  }

  if (button) {
    button.setAttribute('data-label', button.textContent);
    button.addEventListener('click', () => {
      const token = storedToken();
      if (token) run(token);
      else authorize().catch(() => toTierTwo(FAILURE.UNKNOWN));
    });
  }

  /* Coming back from /callback. Anything but `ok` is tier 2; `ok` with a
     pending slug that matches this page means the listener already asked for
     this and should not have to ask twice. */
  const verdict = take(KEYS.result);
  const pending = take(KEYS.pending);
  if (verdict && verdict !== 'ok') {
    toTierTwo(verdict);
  } else if (verdict === 'ok' && isSafeSlug(pending) && pending === slug) {
    const token = storedToken();
    if (token) run(token);
    else toTierTwo(FAILURE.TOKEN_EXCHANGE);
  }
}
