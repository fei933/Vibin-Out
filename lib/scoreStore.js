/**
 * Persistence for score documents.
 *
 * Saving is a HARD pipeline step: a score that cannot be saved has no share
 * URL, and the share URL is the product. A failed save is a failed
 * generation (and refunds the visitor's quota slot) rather than a page that
 * renders once and then evaporates.
 *
 * Documents are immutable — a remix mints a new slug — which is what lets
 * GET /score/:slug be cached forever at the edge.
 */
import { scoresCollection } from '../db.js';
import { makeSlug } from './slug.js';

const SLUG_ATTEMPTS = 3;

function isDuplicateKey(error) {
  return error?.code === 11000;
}

/**
 * The document is assembled field by field from an explicitly destructured
 * argument — never a spread of the caller's object. That is what guarantees a
 * photo cannot reach Mongo even if a future caller passes one through: the only
 * trace of an image is the boolean `fromPhoto` and whatever marker the caller
 * put in `input` (see lib/remix.js).
 *
 * @param {{title: string}} result the assembled score
 * @returns {Promise<{slug: string}>}
 */
export async function saveScore(
  { input, duration, discovery, result, fromPhoto = false },
  { collection, now = () => new Date() } = {},
) {
  const scores = collection ?? (await scoresCollection());

  for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt += 1) {
    const slug = makeSlug(result.title);
    try {
      await scores.insertOne({
        slug,
        input,
        options: { duration, discovery },
        fromPhoto: Boolean(fromPhoto),
        result,
        createdAt: now(),
      });
      return { slug };
    } catch (error) {
      if (isDuplicateKey(error) && attempt < SLUG_ATTEMPTS - 1) continue;
      throw error;
    }
  }
  throw new Error('could not allocate a unique slug');
}

export async function findScore(slug, { collection } = {}) {
  const scores = collection ?? (await scoresCollection());
  return scores.findOne({ slug });
}
