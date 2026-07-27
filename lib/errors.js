/**
 * Friendly, client-facing error codes. Every failure in the generation
 * pipeline surfaces as one of these — the client maps each to a state,
 * so the user never sees a raw 429/500.
 */
export const ERROR_CODES = {
  COOLDOWN: 'cooldown', // rate limited, or the limiter's store is unreachable
  REFUSED: 'refused', // the model declined the input (abuse / injection)
  GENERATION_FAILED: 'generation_failed', // LLM, resolver or persist blew up
  INVALID_INPUT: 'invalid_input', // failed server-side validation
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
  [ERROR_CODES.COOLDOWN]: 429,
  [ERROR_CODES.REFUSED]: 200,
  [ERROR_CODES.GENERATION_FAILED]: 502,
};
