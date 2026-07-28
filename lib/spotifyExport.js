/**
 * The server's half of the export: the two things the tier-2 fallback needs
 * rendered into the page rather than assembled by script.
 *
 * Both are here, not in the browser module, because they are markup inputs —
 * the deep links are real anchors that work with JavaScript dead, and the
 * plain-text list is a textarea's value, so "copy the list" degrades to
 * select-and-copy. Anything that needs crypto or a token lives in
 * public/js/spotify-export-core.js instead.
 *
 * This is also the shape the whole product takes on the day the Spotify key
 * dies (TODOS #2): search deep links need no key, no token and no API.
 */

export const SPOTIFY_SEARCH_BASE = 'https://open.spotify.com/search/';

/**
 * A keyless "open in Spotify" link for one track.
 *
 * Deliberately a search, not a track URL: a search survives regional
 * availability, re-releases and the record simply having moved, and it needs
 * no client credentials to construct.
 *
 * @param {string} title
 * @param {string} artist
 * @returns {string}
 */
export function spotifySearchUrl(title, artist) {
  const query = [title, artist]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(' ');
  return SPOTIFY_SEARCH_BASE + encodeURIComponent(query);
}

/**
 * The tracklist as something you can paste into a message: one record per
 * line, `title — artist`, nothing else. No numbering, no header, no URL —
 * whatever this returns is what lands in someone's clipboard verbatim.
 *
 * @param {Array<{title?: string, artist?: string}>} tracks
 * @returns {string}
 */
export function tracklistText(tracks) {
  return (tracks ?? [])
    .map(({ title, artist }) => [title, artist].map((p) => String(p ?? '').trim()).filter(Boolean).join(' — '))
    .filter(Boolean)
    .join('\n');
}
