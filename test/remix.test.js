import test from 'node:test';
import assert from 'node:assert/strict';
import { briefFromResult, PHOTO_MARKER, remixRequestFrom, storedInputFor } from '../lib/remix.js';
import { MAX_INPUT_LENGTH, validateScoreRequest } from '../lib/validation.js';

const RESULT = {
  title: 'Rain Through Cedar',
  interpretation: 'Cool mineral air settling into dry wood.',
  phases: [
    { name: 'top', scentNotes: 'wet slate, bergamot', weight: 0.25, tracks: [] },
    { name: 'heart', scentNotes: 'black tea', weight: 0.45, tracks: [] },
    { name: 'base', scentNotes: 'cedar, dry resin', weight: 0.3, tracks: [] },
  ],
};

test('storedInputFor keeps the words and marks the photograph', () => {
  assert.equal(storedInputFor('cedar smoke', false), 'cedar smoke');
  assert.equal(storedInputFor('', true), PHOTO_MARKER);
  assert.equal(storedInputFor('cedar smoke', true), `cedar smoke\n\n${PHOTO_MARKER}`);
  assert.equal(storedInputFor('', false), '');
});

test('a remix of a text score replays exactly what was stored', () => {
  const doc = {
    input: 'bergamot, black tea, cedar',
    options: { duration: 90, discovery: 'deepcuts' },
    result: RESULT,
  };
  assert.deepEqual(remixRequestFrom(doc), {
    input: 'bergamot, black tea, cedar',
    duration: 90,
    discovery: 'deepcuts',
  });
});

/**
 * The photo is gone by the time anyone clicks remix, so a photo score cannot
 * re-run vision. It re-runs from the model's own reading instead: the
 * interpretation plus the notes it assigned to each phase. The score drifts —
 * that is what a remix is — but the button never errors, which is the point.
 */
test('a remix of a photo score re-runs from the stored reading, not the marker', () => {
  const doc = {
    input: PHOTO_MARKER,
    fromPhoto: true,
    options: { duration: 30, discovery: 'familiar' },
    result: RESULT,
  };
  const request = remixRequestFrom(doc);

  assert.equal(request.duration, 30, 'the pills carry over');
  assert.equal(request.discovery, 'familiar');
  assert.match(request.input, /Cool mineral air settling into dry wood\./);
  assert.match(request.input, /top: wet slate, bergamot/);
  assert.match(request.input, /heart: black tea/);
  assert.match(request.input, /base: cedar, dry resin/);
  assert.equal(request.input.includes(PHOTO_MARKER), false, 'the marker is not a brief');

  // And it is a request the pipeline will actually accept.
  const validated = validateScoreRequest(request);
  assert.equal(validated.ok, true);
  assert.equal(validated.photo, null, 'a remix never carries an image');
});

test('a remix of a text+photo score still runs from the reading', () => {
  const doc = {
    input: `cedar smoke\n\n${PHOTO_MARKER}`,
    fromPhoto: true,
    options: { duration: 60, discovery: 'balanced' },
    result: RESULT,
  };
  const request = remixRequestFrom(doc);
  assert.match(request.input, /Cool mineral air/);
  assert.equal(request.input.includes(PHOTO_MARKER), false);
  assert.equal(validateScoreRequest(request).ok, true);
});

test('a long reading is clamped to the input cap rather than rejected', () => {
  const wordy = {
    interpretation: `${'stone '.repeat(60)}`.trim(),
    phases: [
      { name: 'top', scentNotes: 'slate '.repeat(40).trim() },
      { name: 'heart', scentNotes: 'tea '.repeat(40).trim() },
      { name: 'base', scentNotes: 'cedar '.repeat(40).trim() },
    ],
  };
  const brief = briefFromResult(wordy);
  assert.ok(brief.length <= MAX_INPUT_LENGTH, `brief is ${brief.length} chars`);
  assert.equal(
    validateScoreRequest({ input: brief, duration: 60, discovery: 'balanced' }).ok,
    true,
  );
});

test('a photo score with an unusable result falls back rather than erroring', () => {
  const doc = { input: PHOTO_MARKER, fromPhoto: true, options: {}, result: {} };
  const request = remixRequestFrom(doc);
  assert.equal(request.input, PHOTO_MARKER, 'never empty — an empty remix would 400');
  assert.equal(remixRequestFrom(null).input, '');
});
