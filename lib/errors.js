/**
 * Friendly, client-facing error codes. Every failure in the generation
 * pipeline surfaces as one of these — the client maps each to a state,
 * so the user never sees a raw 429/500.
 */
export const ERROR_CODES = {
  COOLDOWN: 'cooldown', // rate limited, or the limiter's store is unreachable
  REFUSED: 'refused', // the model declined the input or the image
  GENERATION_FAILED: 'generation_failed', // LLM, resolver or persist blew up
  INVALID_INPUT: 'invalid_input', // failed server-side validation
  INVALID_PHOTO: 'invalid_photo', // not an image data URL we accept
  PHOTO_TOO_LARGE: 'photo_too_large', // body or decoded image over the cap
};

export class ScoreError extends Error {
  /**
   * @param {string} code one of ERROR_CODES
   * @param {string} [message] internal detail — never shown to the user
   */
  constructor(code, message = code, options = {}) {
    super(message, options);
    this.name = 'ScoreError';
    this.code = code;
  }
}

/** HTTP status per error code. The client reads `error`, not the status. */
export const STATUS_FOR_CODE = {
  [ERROR_CODES.INVALID_INPUT]: 400,
  [ERROR_CODES.INVALID_PHOTO]: 400,
  // A real 413 with a JSON body the client can map — what the design doc
  // forbids is the body parser's raw HTML 413 reaching a visitor, not the
  // status code itself.
  [ERROR_CODES.PHOTO_TOO_LARGE]: 413,
  [ERROR_CODES.COOLDOWN]: 429,
  [ERROR_CODES.REFUSED]: 200,
  [ERROR_CODES.GENERATION_FAILED]: 502,
};

const RESPONSE_BODY_PREVIEW_LENGTH = 300;

/**
 * Flattens an error into the fields worth logging, so a bare `console.error`
 * label is never all that survives a production failure. Deliberately
 * excludes anything that could carry user input, credentials, or a full
 * request body: message text (which the AI SDK sometimes echoes prompt
 * fragments into) is the closest we get, and it stays capped like the
 * response body.
 *
 * @param {unknown} error
 * @returns {Record<string, unknown>}
 */
export function describeError(error) {
  if (!(error instanceof Error)) return { value: String(error) };

  const details = { name: error.name, message: error.message };

  // AI SDK APICallError (and similar provider errors) carry these.
  if (typeof error.statusCode === 'number') details.statusCode = error.statusCode;
  if (typeof error.responseBody === 'string') {
    details.responseBody = error.responseBody.slice(0, RESPONSE_BODY_PREVIEW_LENGTH);
  }

  if (error.cause instanceof Error) {
    details.cause = { name: error.cause.name, message: error.cause.message };
  } else if (error.cause !== undefined) {
    details.cause = String(error.cause);
  }

  return details;
}
