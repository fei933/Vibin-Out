/**
 * What survives a photo run, and how a remix uses it.
 *
 * Photos are never persisted (design doc v2.1 §5: privacy + Atlas M0
 * headroom). That is easy to honour and easy to break silently, so both ends
 * of the contract live here:
 *
 *   - `storedInputFor` decides the human-readable `input` a photo run leaves
 *     behind: the visitor's words if they typed any, plus a marker saying a
 *     photograph was involved. It is an ops/debugging record, not a machine
 *     flag — the stored document also carries `fromPhoto: true`, because
 *     sniffing for the marker string would misread a visitor who typed it.
 *
 *   - `remixRequestFrom` decides what a remix re-runs. Remix is "the same
 *     input, again" — but the photo is gone, so a photo score cannot re-run
 *     vision. The design doc does not cover this case; the sensible reading of
 *     "photos are never persisted" is that the *derived* reading becomes the
 *     brief. So a remix of a photo score re-runs from the interpretation plus
 *     the phase scent notes: the model's own reading of the room, restated as
 *     text. The result drifts from the original — it is a remix — and, crucially,
 *     it never errors, which a photo-shaped remix otherwise would.
 */
import { MAX_INPUT_LENGTH } from './validation.js';

export const PHOTO_MARKER = '(from a photo)';

/** The `input` a run leaves in Mongo. Never the photo, never a data URL. */
export function storedInputFor(input, fromPhoto) {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!fromPhoto) return text;
  return text ? `${text}\n\n${PHOTO_MARKER}` : PHOTO_MARKER;
}

/** Cut to the input cap on a word boundary, so a brief is never rejected. */
function clamp(text, limit = MAX_INPUT_LENGTH) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * The model's reading of a space, restated as the textual brief a remix runs
 * from: one interpretation sentence plus the notes it assigned to each phase.
 */
export function briefFromResult(result) {
  const interpretation =
    typeof result?.interpretation === 'string' ? result.interpretation.trim() : '';
  const notes = (Array.isArray(result?.phases) ? result.phases : [])
    .filter((phase) => phase && typeof phase.scentNotes === 'string' && phase.scentNotes.trim())
    .map((phase) => `${phase.name}: ${phase.scentNotes.trim()}`)
    .join('; ');

  const parts = [interpretation, notes].filter(Boolean);
  return parts.length ? clamp(parts.join(' — ')) : '';
}

/**
 * Turn a stored score into the request body a remix validates.
 * @param {{input?: string, fromPhoto?: boolean, options?: object, result?: object}} doc
 */
export function remixRequestFrom(doc) {
  const options = doc?.options && typeof doc.options === 'object' ? doc.options : {};
  const request = { duration: options.duration, discovery: options.discovery };

  if (!doc?.fromPhoto) return { ...request, input: doc?.input ?? '' };

  // Fall back to the stored marker only if the result is somehow noteless —
  // the schema makes that impossible, but a remix must never 500 over it.
  return { ...request, input: briefFromResult(doc.result) || doc.input || '' };
}
