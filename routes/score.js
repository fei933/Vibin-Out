/**
 * The whole v1 API surface: generate a score, render a score.
 *
 * Every failure leaves by the same door — a friendly JSON `{error}` code the
 * client maps to a state. The visitor never meets a raw 429 or a stack trace.
 */
import express from 'express';
import { rateLimitsCollection } from '../db.js';
import { describeError, ERROR_CODES, ScoreError, STATUS_FOR_CODE } from '../lib/errors.js';
import { generateScore } from '../lib/generateScore.js';
import { clientIp, createRateLimiter } from '../lib/rateLimiter.js';
import { remixRequestFrom, storedInputFor } from '../lib/remix.js';
import { findScore, saveScore } from '../lib/scoreStore.js';
import { readRemixSlug, validateScoreRequest } from '../lib/validation.js';
import { toScoreViewModel } from '../lib/viewModel.js';

const router = express.Router();

/**
 * Sized for one client-compressed photo (~1MB JPEG → ~1.4MB of base64) plus
 * the rest of the body, with room for a browser that compresses less well than
 * ours does. Deliberately mounted HERE and not app-wide: this is the only route
 * that accepts a body at all, so no other path has to carry a 4MB ceiling.
 */
export const BODY_LIMIT = '4mb';

const parseJson = express.json({ limit: BODY_LIMIT });
const parseForm = express.urlencoded({ extended: false, limit: '16kb' });

const limiter = createRateLimiter({
  getCollection: rateLimitsCollection,
  onError: (error) => console.error('[ratelimit]', describeError(error)),
});

function fail(res, code) {
  return res.status(STATUS_FOR_CODE[code] ?? 500).json({ error: code });
}

/**
 * Body parsing with its own door.
 *
 * A body-parser failure normally throws past the route into the app's error
 * handler, which renders an HTML 500 — a fetch() caller would get a page of
 * markup where it expected `{error}`. Catching it here keeps every failure on
 * this route JSON, and turns an oversized body into `photo_too_large` rather
 * than a raw 413 the client cannot phrase.
 */
function readBody(req, res, next) {
  const handle = (error, done) => {
    if (!error) return done();
    if (error.type === 'entity.too.large') return fail(res, ERROR_CODES.PHOTO_TOO_LARGE);
    return fail(res, ERROR_CODES.INVALID_INPUT);
  };
  parseJson(req, res, (jsonError) =>
    handle(jsonError, () => parseForm(req, res, (formError) => handle(formError, next))),
  );
}

router.post('/api/score', readBody, async (req, res) => {
  // A remix replays the stored input rather than echoing it through the
  // browser, so raw visitor text never has to live in the score page.
  let request;
  const remixOf = readRemixSlug(req.body);
  if (remixOf) {
    let original;
    try {
      original = await findScore(remixOf);
    } catch (error) {
      console.error('[remix]', describeError(error));
      return fail(res, ERROR_CODES.COOLDOWN);
    }
    if (!original) return fail(res, ERROR_CODES.INVALID_INPUT);
    // Photo scores keep no photo, so a remix of one re-runs text-only from the
    // stored reading — see lib/remix.js. A remix never carries an image.
    request = validateScoreRequest(remixRequestFrom(original));
  } else {
    request = validateScoreRequest(req.body);
  }

  if (!request.ok) return fail(res, request.code);

  const photo = remixOf ? null : (request.photo ?? null);
  const gate = await limiter.check(clientIp(req));
  if (!gate.allowed) return fail(res, ERROR_CODES.COOLDOWN);

  try {
    const result = await generateScore({ ...request.value, photo });
    // Field by field, not a spread: the photo lives in `photo`, and the only
    // thing that may reach storage is the fact that there was one.
    const { slug } = await saveScore({
      input: storedInputFor(request.value.input, Boolean(photo)),
      duration: request.value.duration,
      discovery: request.value.discovery,
      fromPhoto: Boolean(photo),
      result,
    });
    return res.status(200).json({ slug });
  } catch (error) {
    if (error instanceof ScoreError && error.code === ERROR_CODES.REFUSED) {
      // A refusal is a real answer, not a failure — the call was spent.
      return fail(res, ERROR_CODES.REFUSED);
    }
    console.error('[score]', describeError(error));
    await gate.refund(); // a broken generation must not cost a visitor a slot
    return fail(res, ERROR_CODES.GENERATION_FAILED);
  }
});

router.get('/score/:slug', async (req, res) => {
  let doc;
  try {
    doc = await findScore(String(req.params.slug).toLowerCase());
  } catch (error) {
    console.error('[score-render]', describeError(error));
    return res.status(503).render('error', {
      title: 'the still is cooling down',
      message: 'Scores are resting for a moment. Try again shortly.',
    });
  }

  const score = toScoreViewModel(doc);
  if (!score) {
    return res.status(404).render('error', {
      title: 'no such score',
      message: 'That link has no scent behind it. Distill a new one.',
    });
  }

  // Scores are immutable — a remix mints a new slug — so this can sit at the
  // edge forever, which is what keeps share traffic off a free Atlas tier.
  res.set('Cache-Control', 'public, s-maxage=31536000, immutable');
  return res.render('score', { score, pageTitle: score.title, isScore: true });
});

export default router;
