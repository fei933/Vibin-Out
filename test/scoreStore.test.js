import test from 'node:test';
import assert from 'node:assert/strict';
import { saveScore } from '../lib/scoreStore.js';
import { PHOTO_MARKER, storedInputFor } from '../lib/remix.js';

/** Collection double: records what would have been written. */
function fakeCollection({ failFirst = 0 } = {}) {
  const docs = [];
  let failures = failFirst;
  return {
    docs,
    async insertOne(doc) {
      if (failures > 0) {
        failures -= 1;
        const duplicate = new Error('E11000 duplicate key');
        duplicate.code = 11000;
        throw duplicate;
      }
      docs.push(doc);
      return { acknowledged: true };
    },
  };
}

const RESULT = {
  title: 'Rain Through Cedar',
  interpretation: 'Cool mineral air settling into dry wood.',
  phases: [{ name: 'top', scentNotes: 'slate', weight: 1, tracks: [] }],
};

const PHOTO_DATA_URL = `data:image/jpeg;base64,${Buffer.alloc(512, 9).toString('base64')}`;

/**
 * The rule from the design doc (v2.1 §5) that has no second chance: a stored
 * document must not contain the photo. Once a data URL is in Mongo it is in
 * every backup, so this is asserted on the actual written document rather than
 * on the call site.
 */
test('a photo run persists the derived score and no trace of the image', async () => {
  const collection = fakeCollection();

  await saveScore(
    {
      input: storedInputFor('', true),
      duration: 60,
      discovery: 'balanced',
      fromPhoto: true,
      result: RESULT,
      // Passed deliberately: a future caller spreading its request in must not
      // be able to smuggle an image through. saveScore destructures, so it
      // cannot.
      photo: { dataUrl: PHOTO_DATA_URL, mediaType: 'image/jpeg', bytes: 512 },
    },
    { collection },
  );

  const [doc] = collection.docs;
  const serialized = JSON.stringify(doc);
  assert.equal(serialized.includes('base64'), false, 'no data URL anywhere in the document');
  assert.equal(serialized.includes(PHOTO_DATA_URL.slice(30, 60)), false, 'no image payload');
  assert.equal('photo' in doc, false, 'no photo field');
  assert.deepEqual(Object.keys(doc).sort(), [
    'createdAt',
    'fromPhoto',
    'input',
    'options',
    'result',
    'slug',
  ]);
  assert.equal(doc.fromPhoto, true, 'only the fact that there was one survives');
  assert.equal(doc.input, PHOTO_MARKER);
  assert.equal(doc.result, RESULT);
});

test('a text run stores the words and is not marked as a photo run', async () => {
  const collection = fakeCollection();
  await saveScore(
    { input: 'cedar, wet stone', duration: 30, discovery: 'familiar', result: RESULT },
    { collection },
  );

  const [doc] = collection.docs;
  assert.equal(doc.input, 'cedar, wet stone');
  assert.equal(doc.fromPhoto, false, 'the flag is always present, so remix can trust it');
  assert.deepEqual(doc.options, { duration: 30, discovery: 'familiar' });
});

test('slug collisions retry, and the photo flag survives the retry', async () => {
  const collection = fakeCollection({ failFirst: 1 });
  const { slug } = await saveScore(
    { input: PHOTO_MARKER, duration: 60, discovery: 'balanced', fromPhoto: true, result: RESULT },
    { collection },
  );
  assert.match(slug, /^rain-through-cedar-[a-z0-9]{6}$/);
  assert.equal(collection.docs[0].fromPhoto, true);
});
