/**
 * Fuzzy match verification for resolved tracks.
 *
 * Search engines answer *something* for almost any query. Accepting the top
 * hit blindly is how a score ends up full of karaoke backing tracks and
 * tribute-band covers. Every hit is compared against what was actually asked
 * for before it is allowed into a score.
 *
 * Pure functions, no I/O — this is the module the resolver's correctness
 * rests on, so it is unit-tested directly.
 */

export const TITLE_SIMILARITY_THRESHOLD = 0.7;
export const ARTIST_SIMILARITY_THRESHOLD = 0.8;

/** Phrases that mark a result as a re-recording rather than the record asked for. */
const IMPOSTOR_PATTERNS = [
  /\bkaraoke\b/,
  /\btribute\b/,
  /\bmade famous by\b/,
  /\bin the style of\b/,
  /\boriginally performed by\b/,
  /\bbacking track\b/,
  /\bas made popular by\b/,
  /\bcover version\b/,
  /\bcovers? of\b/,
  /\bsound-?alike\b/,
  /\bworkout mix\b/,
  /\blullaby (?:versions?|renditions?)\b/,
  /\bstring quartet tribute\b/,
  /\b8-?bit\b/,
];

/** Qualifier tails that Spotify appends and the model never writes. */
const QUALIFIER_TAIL =
  /\b(remaster(?:ed)?|mono|stereo|radio edit|single version|album version|deluxe|expanded|anniversary|edition|bonus track|remix|mix|live|version|edit|take)\b/;

/**
 * Fold a title or artist to a comparable form: no diacritics, no punctuation,
 * no "feat." credits, no parenthetical or dash-suffixed qualifiers.
 */
export function normalizeName(value) {
  let text = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  // Drop bracketed groups: "(2011 Remaster)", "[Live]", "(feat. X)".
  text = text.replace(/[([{][^)\]}]*[)\]}]/g, ' ');

  // Drop a trailing " - <qualifier...>" segment ("- 2011 Remaster", "- Live").
  const dashIndex = text.indexOf(' - ');
  if (dashIndex !== -1) {
    const tail = text.slice(dashIndex + 3);
    if (QUALIFIER_TAIL.test(tail)) text = text.slice(0, dashIndex);
  }

  text = text
    .replace(/\b(?:feat|ft|featuring|with)\b[\s.].*$/, ' ')
    .replace(/&/g, ' and ')
    .replace(/\bpt\b\.?/g, 'part')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return text;
}

export function tokenize(value) {
  const normalized = normalizeName(value);
  return normalized ? normalized.split(' ') : [];
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[b.length];
}

/** Tokens count as equal when identical, or one typo/plural apart (length >= 4). */
function tokensEqual(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  return levenshtein(a, b) <= 1;
}

/**
 * Dice coefficient over token sets, with fuzzy token equality.
 * 1 = identical, 0 = nothing in common.
 */
export function similarity(a, b) {
  const left = tokenize(a);
  const right = tokenize(b);
  if (!left.length || !right.length) return 0;

  const unused = [...right];
  let shared = 0;
  for (const token of left) {
    const hit = unused.findIndex((candidate) => tokensEqual(token, candidate));
    if (hit !== -1) {
      shared += 1;
      unused.splice(hit, 1);
    }
  }
  return (2 * shared) / (left.length + right.length);
}

export function looksLikeImpostor(text) {
  const normalized = normalizeName(text);
  // Bracketed qualifiers are stripped by normalizeName, so also scan the raw
  // string — "(Karaoke Version)" lives exactly there.
  const raw = String(text ?? '').toLowerCase();
  return IMPOSTOR_PATTERNS.some((pattern) => pattern.test(normalized) || pattern.test(raw));
}

/** Split a credit string into individual artist names. */
export function splitArtists(value) {
  return String(value ?? '')
    .split(/,|&|\band\b|\bwith\b|\bfeat\.?\b|\bft\.?\b|\sx\s|\/|;/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Does the returned credit correspond to the artist that was asked for?
 *
 * The whole requested credit is compared FIRST, because plenty of canonical
 * artist names contain the very punctuation and conjunctions that
 * `splitArtists` treats as separators — "Tyler, The Creator",
 * "Simon & Garfunkel", "Emerson, Lake & Palmer". Splitting those up front
 * reduced them to "Tyler" and "Simon", which scored below the threshold
 * against their own exact Spotify hit and got the correct record thrown away.
 *
 * Only when the whole credit fails do we treat it as a collaboration and try
 * the primary artist against each returned artist.
 */
function artistMatches(requestedArtist, foundArtists, artistCredit) {
  const meets = (a, b) => similarity(a, b) >= ARTIST_SIMILARITY_THRESHOLD;

  // 1. The credit exactly as asked for, against each returned artist and
  //    against the full returned credit ("Flying Lotus, Andreya Triana").
  if (foundArtists.some((candidate) => meets(requestedArtist, candidate))) return true;
  if (meets(requestedArtist, artistCredit)) return true;

  // 2. Only now assume it was a collaboration and split it.
  const parts = splitArtists(requestedArtist);
  if (parts.length > 1) {
    return foundArtists.some((candidate) => meets(parts[0], candidate));
  }
  return false;
}

/**
 * @param {{title: string, artist: string}} requested what the model asked for
 * @param {{title: string, artists: string[]}} found what the provider returned
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function verifyMatch(requested, found) {
  const foundArtists = Array.isArray(found?.artists) ? found.artists : [found?.artists];
  const artistCredit = foundArtists.filter(Boolean).join(', ');

  // The model does not ask for karaoke; if the result advertises itself as a
  // re-recording and the request did not, it is the wrong record.
  const requestedIsImpostor =
    looksLikeImpostor(requested?.title) || looksLikeImpostor(requested?.artist);
  if (!requestedIsImpostor && (looksLikeImpostor(found?.title) || looksLikeImpostor(artistCredit))) {
    return { ok: false, reason: 'impostor' };
  }

  if (!artistMatches(requested?.artist, foundArtists, artistCredit)) {
    return { ok: false, reason: 'artist_mismatch' };
  }

  const titleScore = similarity(requested?.title, found?.title);
  if (titleScore < TITLE_SIMILARITY_THRESHOLD) {
    return { ok: false, reason: 'title_mismatch' };
  }

  return { ok: true };
}
