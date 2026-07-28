import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../app.js';
import { BODY_LIMIT } from '../routes/score.js';

/**
 * These drive the real Express app over a real socket, because what is being
 * checked is middleware ordering — that a body-parser failure never escapes
 * into the app's HTML error handler. Calling the handler directly would prove
 * nothing about that.
 *
 * None of them reach Mongo or the LLM: body parsing fails, or validation
 * rejects, before the rate limiter is ever consulted.
 */
async function withServer(run) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function post(base, body, headers = {}) {
  return fetch(`${base}/api/score`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('the body limit is stated in megabytes, sized for one compressed photo', () => {
  assert.equal(BODY_LIMIT, '4mb');
});

/**
 * The design doc's rule: never a raw 413. body-parser's own answer is an HTML
 * error page; a fetch() client parsing that as JSON gets an exception instead
 * of a message it can show.
 */
test('an over-limit body comes back as friendly JSON, not body-parser HTML', async () => {
  await withServer(async (base) => {
    const oversized = JSON.stringify({
      input: 'cedar',
      duration: 60,
      discovery: 'balanced',
      photo: `data:image/jpeg;base64,${'A'.repeat(5 * 1024 * 1024)}`,
    });

    const response = await post(base, oversized);
    const text = await response.text();

    assert.equal(response.status, 413);
    assert.match(response.headers.get('content-type') || '', /application\/json/);
    assert.deepEqual(JSON.parse(text), { error: 'photo_too_large' });
    assert.equal(/<html|<!doctype/i.test(text), false, 'no HTML error page');
    assert.equal(/PayloadTooLargeError|at\s+\w+\s+\(/.test(text), false, 'no stack trace');
  });
});

test('malformed JSON is invalid_input, not a 500', async () => {
  await withServer(async (base) => {
    const response = await post(base, '{"input": "cedar",');
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_input' });
  });
});

test('a well-formed body under the limit gets past parsing to validation', async () => {
  await withServer(async (base) => {
    // Rejected for its content (a gif is not a vision type), which proves the
    // request reached the validator rather than dying in the parser.
    const response = await post(base, {
      input: '',
      photo: `data:image/gif;base64,${Buffer.alloc(64, 1).toString('base64')}`,
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_photo' });
  });
});

test('neither words nor a photo is invalid_input', async () => {
  await withServer(async (base) => {
    const response = await post(base, { input: '   ' });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_input' });
  });
});

/**
 * The 4MB ceiling belongs to POST /api/score alone. Every other path takes no
 * body at all, so none of them should be willing to buffer megabytes.
 */
test('other routes were not handed the 4MB ceiling', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/`, { method: 'GET' });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Describe what/);
  });
});
