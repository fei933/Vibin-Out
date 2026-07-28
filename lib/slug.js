import { randomInt } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
export const SUFFIX_LENGTH = 6;
export const MAX_SLUG_BODY = 60;
const FALLBACK = 'drydown-score';

/** Lowercase, de-accented, hyphen-joined ASCII. Empty string if nothing survives. */
export function slugify(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_BODY)
    .replace(/-+$/g, '');
}

/** 6 unbiased base36 characters — ~2.2e9 values, ample for a hobby-scale corpus. */
export function randomSuffix(length = SUFFIX_LENGTH) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** e.g. "rain-through-cedar-x3k9qf" */
export function makeSlug(title) {
  const body = slugify(title) || FALLBACK;
  return `${body}-${randomSuffix()}`;
}

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]{6}$/;
