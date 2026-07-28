/**
 * The whole v1 API surface: generate a score, render a score.
 *
 * Every failure leaves by the same door — a friendly JSON `{error}` code the
 * client maps to a state. The visitor never meets a raw 429 or a stack trace.
 */
import express from 'express';
import { rateLimitsCollection } from '../db.js';
import { ERROR_CODES, ScoreError, STATUS_FOR_CODE } from '../lib/errors.js';
import { generateScore } from '../lib/generateScore.js';
import { clientIp, createRateLimiter } from '../lib/rateLimiter.js';
import { findScore, saveScore } from '../lib/scoreStore.js';
import { readRemixSlug, validateScoreRequest } from '../lib/validation.js';
import { toScoreViewModel } from '../lib/viewModel.js';

const router = express.Router();

const limiter = createRateLimiter({
  getCollection: rateLimitsCollection,
  onError: (error) => console.error('[ratelimit]', error?.message),
});

function fail(res, code) {
  return res.status(STATUS_FOR_CODE[code] ?? 500).json({ error: code });
}

router.post('/api/score', async (req, res) => {
  // A remix replays the stored input rather than echoing it through the
  // browser, so raw visitor text never has to live in the score page.
  let request;
  const remixOf = readRemixSlug(req.body);
  if (remixOf) {
    let original;
    try {
      original = await findScore(remixOf);
    } catch (error) {
      console.error('[remix]', error?.message);
      return fail(res, ERROR_CODES.COOLDOWN);
    }
    if (!original) return fail(res, ERROR_CODES.INVALID_INPUT);
    request = validateScoreRequest({ input: original.input, ...original.options });
  } else {
    request = validateScoreRequest(req.body);
  }

  if (!request.ok) return fail(res, request.code);

  const gate = await limiter.check(clientIp(req));
  if (!gate.allowed) return fail(res, ERROR_CODES.COOLDOWN);

  try {
    const result = await generateScore(request.value);
    const { slug } = await saveScore({ ...request.value, result });
    return res.status(200).json({ slug });
  } catch (error) {
    if (error instanceof ScoreError && error.code === ERROR_CODES.REFUSED) {
      // A refusal is a real answer, not a failure — the call was spent.
      return fail(res, ERROR_CODES.REFUSED);
    }
    console.error('[score]', error?.message);
    await gate.refund(); // a broken generation must not cost a visitor a slot
    return fail(res, ERROR_CODES.GENERATION_FAILED);
  }
});

router.get('/score/:slug', async (req, res) => {
  let doc;
  try {
    doc = await findScore(String(req.params.slug).toLowerCase());
  } catch (error) {
    console.error('[score-render]', error?.message);
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
