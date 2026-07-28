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

/** The only image types the vision call is asked to read. */
export const PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Decoded-size ceiling for an uploaded photo.
 *
 * The client compresses to ~1MB before it sends anything (public/js/photo.js),
 * so this is headroom for a hand-rolled request rather than a limit a real
 * visitor can reach. Base64 inflates by 4/3, so 2MB decoded is ~2.7MB on the
 * wire — comfortably inside the route's 4MB body limit.
 */
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

/**
 * Anchored, single-pass: one character class with no overlapping alternative,
 * so matching a megabyte-long string is linear rather than a backtracking trap.
 */
const PHOTO_DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

/** Byte length of a base64 payload without allocating the buffer to find out. */
export function decodedBase64Size(base64) {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/**
 * @returns {{ok: true, value: null | {dataUrl: string, mediaType: string, bytes: number}}
 *          | {ok: false, code: string, reason: string}}
 */
export function validatePhoto(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  const bad = (reason, code = ERROR_CODES.INVALID_PHOTO) => ({ ok: false, code, reason });

  if (typeof raw !== 'string') return bad('photo is not a string');

  const match = PHOTO_DATA_URL.exec(raw);
  if (!match) return bad('photo is not a jpeg/png/webp base64 data URL');

  const [, mediaType, base64] = match;
  // A base64 payload whose length is not a multiple of four is malformed, and
  // `Buffer.from` would silently accept it — so reject here rather than hand
  // the provider something it will choke on mid-generation.
  if (base64.length % 4 !== 0) return bad('photo payload is not valid base64');

  const bytes = decodedBase64Size(base64);
  if (bytes <= 0) return bad('photo payload is empty');
  if (bytes > MAX_PHOTO_BYTES) {
    return bad('photo over the decoded size cap', ERROR_CODES.PHOTO_TOO_LARGE);
  }

  return { ok: true, value: { dataUrl: raw, mediaType, bytes } };
}

/**
 * Validate a raw request body into pipeline options.
 *
 * Since v1.5 a request carries scent text, a photo, or both — at least one.
 * The photo is deliberately returned OUTSIDE `value`: `value` is the shape that
 * gets persisted, and a photo must never reach a stored document.
 *
 * @returns {{ok: true, value: {input: string, duration: number, discovery: string},
 *            photo: null | {dataUrl: string, mediaType: string, bytes: number}}
 *          | {ok: false, code: string, reason: string}}
 */
export function validateScoreRequest(body) {
  const source = body && typeof body === 'object' ? body : {};
  const input = sanitizeInput(source.input);

  const photo = validatePhoto(source.photo);
  if (!photo.ok) return { ok: false, code: photo.code, reason: photo.reason };

  if (!input && !photo.value) {
    return { ok: false, code: ERROR_CODES.INVALID_INPUT, reason: 'no scent and no photo' };
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

  return { ok: true, value: { input, duration, discovery }, photo: photo.value };
}

/** A remix request references a stored score instead of carrying an input. */
export function readRemixSlug(body) {
  const raw = body && typeof body === 'object' ? body.remix : undefined;
  if (typeof raw !== 'string') return null;
  const slug = raw.trim().toLowerCase();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 120 ? slug : null;
}
