import test from 'node:test';
import assert from 'node:assert/strict';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { ANTHROPIC_MODEL, callModel, GATEWAY_MODEL, selectModel, selectProvider } from '../lib/llm.js';
import { llmScoreSchema } from '../lib/schema.js';
import { buildScorePrompt, buildSystemPrompt } from '../lib/prompt.js';

test('provider selection prefers explicit keys over implicit OIDC, else refuses', () => {
  assert.equal(selectProvider({ AI_GATEWAY_API_KEY: 'k', ANTHROPIC_API_KEY: 'a' }), 'gateway');
  assert.equal(
    selectProvider({ ANTHROPIC_API_KEY: 'a', VERCEL: '1' }),
    'anthropic',
    'an explicit Anthropic key must win over bare OIDC — the gateway requires a credit card on file',
  );
  assert.equal(selectProvider({ VERCEL: '1' }), 'gateway', 'OIDC authenticates the gateway on Vercel');
  assert.equal(selectProvider({ ANTHROPIC_API_KEY: 'a' }), 'anthropic');
  assert.equal(selectProvider({}), null);
  assert.equal(GATEWAY_MODEL, 'anthropic/claude-sonnet-5');
  assert.equal(ANTHROPIC_MODEL, 'claude-sonnet-5');
});

/**
 * The provider packages version independently of `ai`, and a mismatched pair
 * fails only at the first real call. @ai-sdk/anthropic v2 speaks the v2
 * language-model spec and ai@6 speaks v3 — installing the "obvious" ^2.0.0
 * produced exactly that silent break. Pin the invariant instead.
 */
test('both providers speak the language-model spec this ai version expects', () => {
  const expected = new MockLanguageModelV3({}).specificationVersion;
  assert.equal(selectModel({ ANTHROPIC_API_KEY: 'x' }).specificationVersion, expected);
  assert.equal(selectModel({ AI_GATEWAY_API_KEY: 'x' }).specificationVersion, expected);
  assert.throws(() => selectModel({}), /no LLM provider configured/);
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

/**
 * A capturing mock: the AI SDK hands `doGenerate` the converted prompt, so
 * this is where we find out what the provider would actually be sent.
 */
function capturingModel(text = '{"ok":true}') {
  const captured = {};
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      captured.prompt = options.prompt;
      return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  return { model, captured };
}

const OK_SCHEMA = z.object({ ok: z.boolean() });
const PHOTO = `data:image/jpeg;base64,${Buffer.alloc(24, 3).toString('base64')}`;

/**
 * The multimodal contract. `image` is handed in as a data URL string; the SDK
 * converts it to the language-model spec's file part and detects the media
 * type from the URL itself, which is why we pass no `mediaType`. Asserting on
 * the converted prompt catches both a wrong part shape and a silently dropped
 * image — neither of which any text-level assertion would see.
 */
test('callModel sends an image part, before the text, when a photo is present', async () => {
  const { model, captured } = capturingModel();

  await callModel({ model, system: 'sys', prompt: 'read the room', schema: OK_SCHEMA, image: PHOTO });

  const user = captured.prompt.find((message) => message.role === 'user');
  assert.equal(user.content.length, 2);
  // Asserted field by field: the SDK also sets `filename`/`providerOptions` to
  // undefined, which is not part of the contract we depend on.
  assert.equal(user.content[0].type, 'file', 'the v3 spec calls an image part a file part');
  assert.equal(user.content[0].mediaType, 'image/jpeg', 'detected from the data URL');
  assert.equal(user.content[0].data, PHOTO.slice('data:image/jpeg;base64,'.length));
  assert.equal(user.content[1].type, 'text');
  assert.equal(user.content[1].text, 'read the room');
  assert.equal(
    captured.prompt.find((message) => message.role === 'system').content,
    'sys',
    'the system prompt still travels separately',
  );
});

test('callModel without a photo sends one plain text part — the unchanged path', async () => {
  const { model, captured } = capturingModel();

  await callModel({ model, system: 'sys', prompt: 'cedar smoke', schema: OK_SCHEMA });

  const user = captured.prompt.find((message) => message.role === 'user');
  assert.deepEqual(user.content, [{ type: 'text', text: 'cedar smoke' }]);
  assert.equal(
    JSON.stringify(captured.prompt).includes('"file"'),
    false,
    'a text-only score never carries a file part',
  );
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
