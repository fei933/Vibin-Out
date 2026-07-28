/**
 * Provider selection and the single wrapper around the AI SDK.
 *
 * One place decides which model answers, so the pipeline never touches the
 * SDK directly and tests can inject a fake `callModel`.
 *
 * NOTE (AI SDK v6): `generateObject` is deprecated in favour of
 * `generateText` + `Output.object()`. Verified against the installed
 * `node_modules/ai/docs/08-migration-guides/24-migration-guide-6-0.mdx`.
 */
import { generateText, Output, gateway } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

export const GATEWAY_MODEL = 'anthropic/claude-sonnet-5';
export const ANTHROPIC_MODEL = 'claude-sonnet-5';

/**
 * Gateway when we have gateway credentials or are running on Vercel (where
 * OIDC authenticates it without a key); the direct Anthropic provider
 * otherwise, which is the normal local-development path.
 * @returns {'gateway'|'anthropic'|null}
 */
export function selectProvider(env = process.env) {
  if (env.AI_GATEWAY_API_KEY || env.VERCEL) return 'gateway';
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}

export function selectModel(env = process.env) {
  const provider = selectProvider(env);
  if (provider === 'gateway') return gateway(GATEWAY_MODEL);
  if (provider === 'anthropic') return anthropic(ANTHROPIC_MODEL);
  throw new Error('no LLM provider configured: set AI_GATEWAY_API_KEY or ANTHROPIC_API_KEY');
}

/**
 * One structured generation. Returns the parsed object or throws.
 * @param {{system: string, prompt: string, schema: import('zod').ZodType,
 *          timeoutMs?: number, temperature?: number, model?: unknown}} options
 */
export async function callModel({ system, prompt, schema, timeoutMs = 40_000, model = selectModel() }) {
  // No `temperature`: claude-sonnet-5 does not support it and the SDK logs a
  // warning for every call while ignoring the value. Curation variety comes
  // from the prompt, not a sampling knob.
  const { output } = await generateText({
    model,
    system,
    prompt,
    output: Output.object({ schema }),
    // Our own hard cap is 3 logical calls per generation; keep the SDK's
    // transient-error retries to one so a bad minute cannot multiply cost.
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(timeoutMs),
  });
  return output;
}
