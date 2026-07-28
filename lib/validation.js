import { ERROR_CODES } from './errors.js';

export const MAX_INPUT_LENGTH = 500;
export const DURATIONS = [30, 60, 90];
export const DISCOVERY_MODES = ['familiar', 'balanced', 'deepcuts'];
export const DEFAULT_DURATION = 60;
export const DEFAULT_DISCOVERY = 'balanced';

/**
 * Strip control and format characters. Newlines and tabs survive (people
 * paste multi-line fragrance-note lists); everything else in the Cc/Cf
 * classes goes, which also removes zero-width and bidi-override characters
 * used to smuggle instructions past a reader's eye.
 */
export function sanitizeInput(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n\t]+/g, ' ') // collapse exotic whitespace, keep \n \t
    .replace(/[\p{Cc}\p{Cf}]/gu, (ch) => (ch === '\n' || ch === '\t' ? ch : ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Validate a raw request body into pipeline options.
 * @returns {{ok: true, value: {input: string, duration: number, discovery: string}}
 *          | {ok: false, code: string, reason: string}}
 */
export function validateScoreRequest(body) {
  const source = body && typeof body === 'object' ? body : {};
  const input = sanitizeInput(source.input);

  if (!input) {
    return { ok: false, code: ERROR_CODES.INVALID_INPUT, reason: 'empty input' };
  }
  if (input.length > MAX_INPUT_LENGTH) {
    return { ok: false, code: ERROR_CODES.INVALID_INPUT, reason: 'input too long' };
  }

  const duration = Number(source.duration ?? DEFAULT_DURATION);
  if (!DURATIONS.includes(duration)) {
    return { ok: false, code: ERROR_CODES.INVALID_INPUT, reason: 'bad duration' };
  }

  const discovery = String(source.discovery ?? DEFAULT_DISCOVERY);
  if (!DISCOVERY_MODES.includes(discovery)) {
    return { ok: false, code: ERROR_CODES.INVALID_INPUT, reason: 'bad discovery' };
  }

  return { ok: true, value: { input, duration, discovery } };
}

/** A remix request references a stored score instead of carrying an input. */
export function readRemixSlug(body) {
  const raw = body && typeof body === 'object' ? body.remix : undefined;
  if (typeof raw !== 'string') return null;
  const slug = raw.trim().toLowerCase();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 120 ? slug : null;
}
