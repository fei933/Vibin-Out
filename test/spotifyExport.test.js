import test from 'node:test';
import assert from 'node:assert/strict';

import { SPOTIFY_SEARCH_BASE, spotifySearchUrl, tracklistText } from '../lib/spotifyExport.js';
import {
  AUTHORIZE_ENDPOINT,
  DESCRIPTION_LIMIT,
  EXPORT_SCOPE,
  FAILURE,
  NAME_LIMIT,
  base64url,
  buildAuthorizeUrl,
  challengeFrom,
  chunk,
  classifyFailure,
  failureKindFromAuthError,
  failureKindFromStatus,
  isSafeSlug,
  playlistDescription,
  playlistName,
  randomToken,
  tokenRequestBody,
  trackUris,
} from '../public/js/spotify-export-core.js';

/**
 * The browser core is imported here directly rather than reimplemented: it is
 * an ES module and Node has the same WebCrypto globals a browser does, so
 * these tests exercise the exact bytes the browser runs. If that ever stops
 * being true — someone reaches for `window` in there — these fail loudly,
 * which is the point.
 */

/* --- PKCE ----------------------------------------------------------------- */

/**
 * RFC 7636 Appendix B, verbatim. The verifier octets, their base64url
 * encoding, and the S256 challenge derived from them. If our encoder drifts by
 * so much as a padding character, Spotify rejects every exchange with
 * `invalid_grant` and the whole feature silently becomes tier 2 — so the known
 * vector is the test, not a round trip against ourselves.
 */
const RFC_OCTETS = [
  116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105,
  214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
];
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

test('base64url matches RFC 7636 Appendix B — unpadded, url-safe alphabet', () => {
  assert.equal(base64url(Uint8Array.from(RFC_OCTETS)), RFC_VERIFIER);
  assert.equal(base64url(RFC_OCTETS), RFC_VERIFIER, 'a plain array works too');
  assert.equal(base64url(Uint8Array.from(RFC_OCTETS).buffer), RFC_VERIFIER, 'so does an ArrayBuffer');
  assert.ok(!RFC_VERIFIER.includes('='), 'never padded');
});

test('base64url handles every remainder length without padding', () => {
  assert.equal(base64url(new Uint8Array([])), '');
  assert.equal(base64url(new Uint8Array([0])).length, 2); // 1 byte  → 2 chars
  assert.equal(base64url(new Uint8Array([0, 0])).length, 3); // 2 bytes → 3 chars
  assert.equal(base64url(new Uint8Array([0, 0, 0])).length, 4); // 3 bytes → 4 chars
  // The two characters that separate base64url from base64.
  assert.equal(base64url(new Uint8Array([251, 255])), '-_8');
});

test('challengeFrom is S256 over the ASCII verifier — RFC 7636 known vector', async () => {
  assert.equal(await challengeFrom(RFC_VERIFIER), RFC_CHALLENGE);
});

test('challengeFrom refuses to invent a challenge without SubtleCrypto', async () => {
  // An insecure context (plain http on a LAN address) is a tier-2 trigger, not
  // a place to fabricate a weaker challenge. `null` stands in for what
  // `globalThis.crypto?.subtle` evaluates to there; passing `undefined` would
  // only re-select the default parameter.
  await assert.rejects(() => challengeFrom(RFC_VERIFIER, null), /insecure context/);
});

test('randomToken produces verifier-legal strings and uses the injected RNG', () => {
  const verifier = randomToken(48);
  assert.equal(verifier.length, 64);
  // RFC 7636 §4.1: 43–128 characters from the unreserved set.
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  assert.match(verifier, /^[A-Za-z0-9\-._~]+$/);

  const fixed = randomToken(3, (bytes) => bytes.fill(0));
  assert.equal(fixed, 'AAAA');
  assert.notEqual(randomToken(48), randomToken(48), 'two calls do not agree');
});

/* --- the authorize URL ---------------------------------------------------- */

test('buildAuthorizeUrl asks for exactly one scope and nothing else', () => {
  const url = new URL(
    buildAuthorizeUrl({
      clientId: 'client-abc',
      redirectUri: 'https://localhost:3000/callback',
      state: 'st4te',
      codeChallenge: RFC_CHALLENGE,
    }),
  );

  assert.equal(`${url.origin}${url.pathname}`, AUTHORIZE_ENDPOINT);
  assert.equal(url.searchParams.get('client_id'), 'client-abc');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://localhost:3000/callback');
  assert.equal(url.searchParams.get('scope'), EXPORT_SCOPE);
  assert.equal(url.searchParams.get('scope'), 'playlist-modify-private');
  assert.equal(url.searchParams.get('state'), 'st4te');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), RFC_CHALLENGE);
  // The secret is the server's, and PKCE does not want one.
  assert.equal(url.searchParams.get('client_secret'), null);
  assert.equal([...url.searchParams.keys()].length, 7, 'no stray parameters');
});

test('buildAuthorizeUrl refuses to build half a request', () => {
  const good = {
    clientId: 'c',
    redirectUri: 'https://localhost:3000/callback',
    state: 's',
    codeChallenge: 'x',
  };
  for (const missing of Object.keys(good)) {
    assert.throws(
      () => buildAuthorizeUrl({ ...good, [missing]: '' }),
      new RegExp(`missing ${missing}`),
      // Spotify answers a malformed authorize request with its own error page
      // and never redirects back, so there would be nothing to fall back from.
      `${missing} must be caught before the redirect`,
    );
  }
});

test('the token exchange sends the verifier and no secret', () => {
  const body = tokenRequestBody({
    clientId: 'client-abc',
    code: 'auth-code',
    redirectUri: 'https://localhost:3000/callback',
    verifier: RFC_VERIFIER,
  });
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'auth-code');
  assert.equal(body.get('code_verifier'), RFC_VERIFIER);
  assert.equal(body.get('client_id'), 'client-abc');
  assert.equal(body.get('client_secret'), null);
});

/* --- what goes on the playlist -------------------------------------------- */

test('playlistName keeps a normal title verbatim and cuts a long one at a word', () => {
  assert.equal(playlistName('Rain Through Cedar'), 'Rain Through Cedar');
  assert.equal(playlistName('  Rain   Through\nCedar '), 'Rain Through Cedar');
  assert.equal(playlistName(''), 'a drydown score');
  assert.equal(playlistName(null), 'a drydown score');

  const long = playlistName(`${'wet stone '.repeat(30)}end`);
  assert.ok(long.length <= NAME_LIMIT, long.length);
  assert.match(long, /…$/);
  assert.ok(!/\s…$/.test(long), 'no orphaned space before the ellipsis');
});

test('playlistDescription carries the reading and the score’s own address', () => {
  const url = 'https://vibin-out.vercel.app/score/rain-through-cedar-x3k9qf';
  const description = playlistDescription('Cool mineral air settling into dry wood.', url);
  assert.equal(description, `Cool mineral air settling into dry wood. · ${url}`);
  assert.ok(description.length <= DESCRIPTION_LIMIT);
});

test('playlistDescription truncates the words, never the link', () => {
  const url = 'https://vibin-out.vercel.app/score/rain-through-cedar-x3k9qf';
  const description = playlistDescription('cedar smoke '.repeat(60), url);

  assert.ok(description.length <= DESCRIPTION_LIMIT, description.length);
  assert.ok(description.endsWith(url), 'the address survives whole');
  assert.match(description, /…\s·\s/, 'the cut is visible, and it is in the prose');
});

test('playlistDescription drops the link rather than ship a stub of prose', () => {
  // A URL long enough to leave under 24 characters for the reading: better to
  // print the reading and lose the link than to print three words and a link.
  const url = `https://example.test/${'x'.repeat(270)}`;
  const description = playlistDescription('Cool mineral air settling into dry wood.', url);
  assert.equal(description, 'Cool mineral air settling into dry wood.');
  assert.ok(!description.includes('http'));
});

test('playlistDescription survives the empty and the hostile', () => {
  const url = 'https://vibin-out.vercel.app/score/x';
  assert.equal(playlistDescription('', url), url);
  assert.equal(playlistDescription('', ''), '');
  assert.equal(playlistDescription(null, ''), '');
  // Spotify strips angle brackets and counts what is left; we strip first so
  // the length budget is the length that actually arrives.
  assert.equal(playlistDescription('<script>alert(1)</script> cedar', ''), 'scriptalert(1)/script cedar');
  assert.ok(playlistDescription('cedar '.repeat(200), url).length <= DESCRIPTION_LIMIT);
});

test('track URIs are spotify:track: form, with blanks dropped', () => {
  assert.deepEqual(trackUris(['abc', '', null, 'def', undefined]), [
    'spotify:track:abc',
    'spotify:track:def',
  ]);
  assert.deepEqual(trackUris([]), []);
  assert.deepEqual(trackUris(undefined), []);
});

test('URIs are chunked to the API’s hundred-per-call ceiling', () => {
  const uris = Array.from({ length: 250 }, (_, i) => `spotify:track:${i}`);
  const batches = chunk(uris);
  assert.deepEqual(batches.map((b) => b.length), [100, 100, 50]);
  // Order is the drydown — top notes first — so it must survive chunking.
  assert.equal(batches[0][0], 'spotify:track:0');
  assert.equal(batches[2][49], 'spotify:track:249');
  assert.deepEqual(chunk([]), []);
});

/* --- the tier-2 decision table -------------------------------------------- */

test('every failure lands in tier 2 — there is no third outcome', () => {
  const kinds = [
    ...Object.values(FAILURE),
    'something-spotify-invented-last-tuesday',
    undefined,
    null,
    '',
  ];
  for (const kind of kinds) {
    const decision = classifyFailure(kind);
    assert.equal(decision.tier, 2, String(kind));
    assert.equal(typeof decision.note, 'string');
    assert.equal(typeof decision.reauth, 'boolean');
  }
});

test('an unrecognised failure is UNKNOWN, and still says something true', () => {
  const decision = classifyFailure('teapot');
  assert.equal(decision.kind, FAILURE.UNKNOWN);
  assert.match(decision.note, /tracks are here/);
});

test('the decision table: which walls are worth re-asking at', () => {
  // Structural walls — asking again produces the same wall, so the button goes.
  assert.equal(classifyFailure(FAILURE.NOT_ALLOWLISTED).reauth, false);
  assert.equal(classifyFailure(FAILURE.INSECURE_CONTEXT).reauth, false);
  assert.equal(classifyFailure(FAILURE.NO_CLIENT_ID).reauth, false);

  // Transient or user-owned — a second click is a reasonable thing to offer.
  assert.equal(classifyFailure(FAILURE.DECLINED).reauth, true);
  assert.equal(classifyFailure(FAILURE.UNAUTHORIZED).reauth, true);
  assert.equal(classifyFailure(FAILURE.RATE_LIMITED).reauth, true);
  assert.equal(classifyFailure(FAILURE.NETWORK).reauth, true);
  assert.equal(classifyFailure(FAILURE.TOKEN_EXCHANGE).reauth, true);
  assert.equal(classifyFailure(FAILURE.STATE_MISMATCH).reauth, true);
});

test('key death says nothing at all — the list is simply what this page is', () => {
  assert.equal(classifyFailure(FAILURE.NO_CLIENT_ID).note, '');
});

test('the copy never apologises and never shouts', () => {
  for (const kind of Object.values(FAILURE)) {
    const { note } = classifyFailure(kind);
    if (!note) continue;
    assert.ok(!/sorry|oops|unfortunately|error|failed|whoops/i.test(note), note);
    assert.equal(note, note.toLowerCase(), `voice is lowercase: ${note}`);
  }
});

test('HTTP status maps onto the wall it actually is', () => {
  assert.equal(failureKindFromStatus(401), FAILURE.UNAUTHORIZED);
  // The five-user dev-mode cap, which is the whole reason tier 2 exists.
  assert.equal(failureKindFromStatus(403), FAILURE.NOT_ALLOWLISTED);
  assert.equal(failureKindFromStatus(429), FAILURE.RATE_LIMITED);
  assert.equal(failureKindFromStatus(500), FAILURE.UNKNOWN);
  assert.equal(failureKindFromStatus(418), FAILURE.UNKNOWN);
});

test('?error=access_denied covers both a refusal and the allowlist wall', () => {
  // Spotify sends the same code either way, so DECLINED's sentence has to be
  // true of both — it names no cause.
  assert.equal(failureKindFromAuthError('access_denied'), FAILURE.DECLINED);
  assert.match(classifyFailure(FAILURE.DECLINED).note, /tracks are here/);
  assert.equal(failureKindFromAuthError('server_error'), FAILURE.UNKNOWN);
  assert.equal(failureKindFromAuthError(''), FAILURE.UNKNOWN);
});

test('the return hop only ever goes to a slug', () => {
  assert.equal(isSafeSlug('rain-through-cedar-x3k9qf'), true);
  assert.equal(isSafeSlug('//evil.example.com'), false);
  assert.equal(isSafeSlug('../../etc/passwd'), false);
  assert.equal(isSafeSlug('https://evil.example.com'), false);
  assert.equal(isSafeSlug('-leading-dash'), false);
  assert.equal(isSafeSlug(''), false);
  assert.equal(isSafeSlug(null), false);
});

/* --- the keyless half ----------------------------------------------------- */

test('the deep link is a search, and it is encoded', () => {
  assert.equal(
    spotifySearchUrl('Glassy Morning', 'Ana Roxanne'),
    `${SPOTIFY_SEARCH_BASE}Glassy%20Morning%20Ana%20Roxanne`,
  );
  // A search survives a re-release, a regional block and a moved track id —
  // which is exactly why this, and not open.spotify.com/track/<id>.
  assert.match(spotifySearchUrl('Sunday & Co / Pt. 2', 'Låpsley'), /%26|%2F|L%C3%A5psley/);
  assert.equal(spotifySearchUrl('Solo', ''), `${SPOTIFY_SEARCH_BASE}Solo`);
  assert.equal(spotifySearchUrl('', ''), SPOTIFY_SEARCH_BASE);
});

test('the plain-text list is exactly title — artist, one per line', () => {
  assert.equal(
    tracklistText([
      { title: 'Glassy Morning', artist: 'Ana Roxanne' },
      { title: 'Wet Stone', artist: 'Loscil' },
    ]),
    'Glassy Morning — Ana Roxanne\nWet Stone — Loscil',
  );
  // Whatever this returns is what lands in someone's clipboard, verbatim: no
  // numbering, no header, no trailing URL.
  assert.equal(tracklistText([]), '');
  assert.equal(tracklistText(undefined), '');
  assert.equal(tracklistText([{ title: 'Untitled', artist: '' }]), 'Untitled');
});
