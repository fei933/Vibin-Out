import test from 'node:test';
import assert from 'node:assert/strict';
import { MockLanguageModelV3 } from 'ai/test';
import { ANTHROPIC_MODEL, callModel, GATEWAY_MODEL, selectProvider } from '../lib/llm.js';
import { llmScoreSchema } from '../lib/schema.js';
import { buildScorePrompt, buildSystemPrompt } from '../lib/prompt.js';

test('provider selection prefers the gateway, falls back to Anthropic, else refuses', () => {
  assert.equal(selectProvider({ AI_GATEWAY_API_KEY: 'k', ANTHROPIC_API_KEY: 'a' }), 'gateway');
  assert.equal(selectProvider({ VERCEL: '1' }), 'gateway', 'OIDC authenticates the gateway on Vercel');
  assert.equal(selectProvider({ ANTHROPIC_API_KEY: 'a' }), 'anthropic');
  assert.equal(selectProvider({}), null);
  assert.equal(GATEWAY_MODEL, 'anthropic/claude-sonnet-5');
  assert.equal(ANTHROPIC_MODEL, 'claude-sonnet-5');
});

function mockModel(text) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 20, text: 20, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

/**
 * Proves the real SDK path — generateText + Output.object + our zod schema —
 * parses a model response into the object the pipeline expects. Catches
 * schema-to-JSON-Schema conversion breakage without spending a token.
 */
test('callModel drives the real AI SDK path and returns a parsed score', async () => {
  const payload = {
    refused: false,
    title: 'Rain Through Cedar',
    interpretation: 'Cool mineral air settling into dry wood.',
    phases: [
      {
        name: 'top',
        scentNotes: 'bergamot',
        weight: 0.25,
        tracks: [{ title: 'Glassy Morning', artist: 'Ana Roxanne', why: 'Mineral sharpness.' }],
      },
    ],
  };

  const output = await callModel({
    model: mockModel(JSON.stringify(payload)),
    system: buildSystemPrompt(),
    prompt: buildScorePrompt({ input: 'cedar', duration: 60, discovery: 'balanced' }),
    schema: llmScoreSchema,
  });

  assert.deepEqual(output, payload);
});

test('callModel surfaces a schema violation as a thrown error the pipeline can retry', async () => {
  await assert.rejects(
    callModel({
      model: mockModel('{"refused": "maybe"}'),
      system: 'x',
      prompt: 'y',
      schema: llmScoreSchema,
    }),
  );
});
