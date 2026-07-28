import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSlug, MAX_SLUG_BODY, randomSuffix, slugify, SLUG_PATTERN } from '../lib/slug.js';

test('slugify produces url-safe ascii from evocative titles', () => {
  assert.equal(slugify('Rain Through Cedar'), 'rain-through-cedar');
  assert.equal(slugify("L'Été à Paris"), 'lete-a-paris');
  assert.equal(slugify('  ...!!!  '), '');
  assert.ok(slugify('x'.repeat(200)).length <= MAX_SLUG_BODY);
});

test('makeSlug appends a 6-character base36 suffix and falls back on empty titles', () => {
  const slug = makeSlug('Rain Through Cedar');
  assert.match(slug, SLUG_PATTERN);
  assert.equal(slug.slice(0, 'rain-through-cedar-'.length), 'rain-through-cedar-');
  assert.equal(slug.split('-').pop().length, 6);

  assert.match(makeSlug('🌧️'), /^drydown-score-[a-z0-9]{6}$/);
});

test('randomSuffix is drawn from base36 and varies between calls', () => {
  const suffixes = new Set(Array.from({ length: 200 }, () => randomSuffix()));
  assert.ok(suffixes.size > 190, `expected near-unique suffixes, got ${suffixes.size}/200`);
  for (const suffix of suffixes) assert.match(suffix, /^[a-z0-9]{6}$/);
});
