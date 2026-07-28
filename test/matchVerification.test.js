import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeName,
  similarity,
  splitArtists,
  verifyMatch,
} from '../lib/matchVerification.js';

test('normalizeName folds diacritics, punctuation, credits and release qualifiers', () => {
  assert.equal(normalizeName('Björk'), 'bjork');
  assert.equal(normalizeName('Holocene - 2011 Remaster'), 'holocene');
  assert.equal(normalizeName('Tea Leaf Dancers (feat. Andreya Triana)'), 'tea leaf dancers');
  assert.equal(normalizeName('Re: Stacks'), 're stacks');
  assert.equal(normalizeName('Simon & Garfunkel'), 'simon and garfunkel');
});

test('similarity is 1 for the same record dressed differently, low for different ones', () => {
  assert.equal(similarity('Holocene', 'Holocene - 2011 Remaster'), 1);
  assert.equal(similarity('Glassy Morning', 'Glassy Mornings'), 1); // one-character token drift
  assert.ok(similarity('Glassy Morning', 'Concrete Evening') < 0.5);
});

test('verifyMatch accepts the record that was actually asked for', () => {
  const result = verifyMatch(
    { title: 'Tea Leaf Dancers', artist: 'Flying Lotus' },
    { title: 'Tea Leaf Dancers (feat. Andreya Triana)', artists: ['Flying Lotus', 'Andreya Triana'] },
  );
  assert.deepEqual(result, { ok: true });
});

test('verifyMatch rejects karaoke, tribute and sound-alike re-recordings', () => {
  const karaoke = verifyMatch(
    { title: 'Holocene', artist: 'Bon Iver' },
    { title: 'Holocene (Karaoke Version)', artists: ['Bon Iver'] },
  );
  assert.equal(karaoke.ok, false);
  assert.equal(karaoke.reason, 'impostor');

  const tribute = verifyMatch(
    { title: 'Holocene', artist: 'Bon Iver' },
    { title: 'Holocene', artists: ['Vitamin String Quartet Tribute'] },
  );
  assert.equal(tribute.ok, false);
  assert.equal(tribute.reason, 'impostor');

  const soundalike = verifyMatch(
    { title: 'Holocene', artist: 'Bon Iver' },
    { title: 'Holocene (In the Style of Bon Iver)', artists: ['Ameritz Audio Karaoke'] },
  );
  assert.equal(soundalike.ok, false);
});

test('verifyMatch rejects the right title by the wrong artist, and the wrong title', () => {
  const wrongArtist = verifyMatch(
    { title: 'Holocene', artist: 'Bon Iver' },
    { title: 'Holocene', artists: ['The Bootleg Orchestra'] },
  );
  assert.equal(wrongArtist.ok, false);
  assert.equal(wrongArtist.reason, 'artist_mismatch');

  const wrongTitle = verifyMatch(
    { title: 'Holocene', artist: 'Bon Iver' },
    { title: 'Skinny Love', artists: ['Bon Iver'] },
  );
  assert.equal(wrongTitle.ok, false);
  assert.equal(wrongTitle.reason, 'title_mismatch');
});

/**
 * Regression: canonical artist names contain the punctuation and conjunctions
 * that splitArtists treats as separators. Splitting before comparing reduced
 * "Tyler, The Creator" to "Tyler" and threw away its own exact Spotify hit.
 */
test('verifyMatch accepts canonical artist names containing commas and ampersands', () => {
  assert.deepEqual(
    verifyMatch(
      { title: 'EARFQUAKE', artist: 'Tyler, The Creator' },
      { title: 'EARFQUAKE', artists: ['Tyler, The Creator'] },
    ),
    { ok: true },
  );

  assert.deepEqual(
    verifyMatch(
      { title: 'The Only Living Boy in New York', artist: 'Simon & Garfunkel' },
      { title: 'The Only Living Boy in New York', artists: ['Simon & Garfunkel'] },
    ),
    { ok: true },
  );

  assert.deepEqual(
    verifyMatch(
      { title: 'Lucky Man', artist: 'Emerson, Lake & Palmer' },
      { title: 'Lucky Man', artists: ['Emerson, Lake & Palmer'] },
    ),
    { ok: true },
  );
});

test('verifyMatch still resolves a genuine collaboration by its primary artist', () => {
  // Requested as a collab, credited on Spotify to the lead artist alone.
  assert.deepEqual(
    verifyMatch(
      { title: 'Moth', artist: 'Burial & Four Tet' },
      { title: 'Moth', artists: ['Burial'] },
    ),
    { ok: true },
  );

  // And the multi-artist credit still matches the multi-artist request.
  assert.deepEqual(
    verifyMatch(
      { title: 'Tea Leaf Dancers', artist: 'Flying Lotus, Andreya Triana' },
      { title: 'Tea Leaf Dancers', artists: ['Flying Lotus', 'Andreya Triana'] },
    ),
    { ok: true },
  );
});

test('the comma-tolerant artist check did not loosen wrong-artist rejection', () => {
  const wrong = verifyMatch(
    { title: 'EARFQUAKE', artist: 'Tyler, The Creator' },
    { title: 'EARFQUAKE', artists: ['Sunset Lounge Trio'] },
  );
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, 'artist_mismatch');
});

test('splitArtists finds the primary credit in a collaboration string', () => {
  assert.deepEqual(splitArtists('Flying Lotus, Andreya Triana'), ['Flying Lotus', 'Andreya Triana']);
  assert.deepEqual(splitArtists('Burial & Four Tet'), ['Burial', 'Four Tet']);
  assert.equal(splitArtists('Malcolm X')[0], 'Malcolm X');
});
