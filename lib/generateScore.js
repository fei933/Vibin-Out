/**
 * The generation pipeline.
 *
 * validate → LLM → resolve/verify → backfill once → assemble.
 * (Rate limiting and persistence bracket this in routes/score.js.)
 *
 * Hard cap of three model calls per generation, enforced here and nowhere
 * else: primary, at most one schema-violation retry, at most one combined
 * backfill. Beyond that we accept a short score and say so on the page.
 */
import { ERROR_CODES, ScoreError } from './errors.js';
import { callModel as defaultCallModel } from './llm.js';
import { normalizeName, splitArtists } from './matchVerification.js';
import {
  backfillSchema,
  llmScoreSchema,
  normalizeWeights,
  PHASE_ORDER,
  quotaFor,
  scoreSchema,
  totalQuota,
} from './schema.js';
import { buildBackfillPrompt, buildRetryPrompt, buildScorePrompt, buildSystemPrompt } from './prompt.js';
import { spotifyResolver } from './trackResolver.js';

export const MAX_MODEL_CALLS = 3;
export const DEFAULT_BUDGET_MS = 45_000;
/** Past this point in the budget a backfill can no longer finish safely. */
export const BACKFILL_CUTOFF_MS = 26_000;

function artistKey(artist) {
  return normalizeName(splitArtists(artist)[0] ?? artist);
}

function issueSummary(error) {
  return (error?.issues ?? [])
    .slice(0, 4)
    .map((issue) => `${issue.path?.join('.') || 'root'}: ${issue.message}`)
    .join('; ');
}

/**
 * Drop tracks that would repeat a Spotify id or an artist already in the
 * score. Order is significant: top phase wins ties, then heart, then base.
 */
export function dedupeAcrossScore(phases) {
  const seenIds = new Set();
  const seenArtists = new Set();
  return phases.map((phase) => ({
    ...phase,
    tracks: phase.tracks.filter((track) => {
      const artist = artistKey(track.artist);
      if (seenIds.has(track.spotifyId) || seenArtists.has(artist)) return false;
      seenIds.add(track.spotifyId);
      seenArtists.add(artist);
      return true;
    }),
  }));
}

function trimToQuota(phases, duration) {
  const quota = quotaFor(duration);
  return phases.map((phase) => ({ ...phase, tracks: phase.tracks.slice(0, quota[phase.name]) }));
}

function shortfallsFor(phases, duration) {
  const quota = quotaFor(duration);
  return phases
    .map((phase) => ({
      name: phase.name,
      scentNotes: phase.scentNotes,
      needed: quota[phase.name] - phase.tracks.length,
    }))
    .filter((entry) => entry.needed > 0);
}

export async function generateScore(
  { input, duration, discovery },
  {
    callModel = defaultCallModel,
    resolver = spotifyResolver(),
    now = () => Date.now(),
    budgetMs = DEFAULT_BUDGET_MS,
    backfillCutoffMs = BACKFILL_CUTOFF_MS,
    onEvent = () => {},
  } = {},
) {
  const startedAt = now();
  const elapsed = () => now() - startedAt;
  const system = buildSystemPrompt();
  const basePrompt = buildScorePrompt({ input, duration, discovery });
  let callsUsed = 0;

  // ---- 1. the score itself, with one permitted structural retry ----------
  let parsed = null;
  let lastIssues = '';
  for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
    if (callsUsed >= MAX_MODEL_CALLS) break;
    callsUsed += 1;
    let raw;
    try {
      raw = await callModel({
        system,
        prompt: attempt === 0 ? basePrompt : buildRetryPrompt(basePrompt, lastIssues),
        // The model gets the plain object schema (it converts cleanly to
        // strict JSON Schema); `scoreSchema` adds the structural rules and is
        // checked below, so a violation of those is what earns the retry.
        schema: llmScoreSchema,
        timeoutMs: Math.max(5_000, budgetMs - elapsed() - 5_000),
      });
    } catch (error) {
      // The SDK validates against the schema too; a validation failure there
      // is the same situation as ours, so it also earns the one retry.
      lastIssues = issueSummary(error?.cause) || 'invalid structure';
      onEvent({ type: 'model_error', attempt, message: error?.message });
      if (attempt === 1) {
        throw new ScoreError(ERROR_CODES.GENERATION_FAILED, 'model call failed', { cause: error });
      }
      continue;
    }

    const check = scoreSchema.safeParse(raw);
    if (check.success) {
      parsed = check.data;
    } else {
      lastIssues = issueSummary(check.error);
      onEvent({ type: 'schema_violation', attempt, issues: lastIssues });
    }
  }

  if (!parsed) {
    throw new ScoreError(ERROR_CODES.GENERATION_FAILED, `schema violation: ${lastIssues}`);
  }

  if (parsed.refused) {
    onEvent({ type: 'refused' });
    throw new ScoreError(ERROR_CODES.REFUSED, 'model declined the input');
  }

  // ---- 2. resolve every proposal against a real catalogue ----------------
  const weighted = normalizeWeights(parsed.phases);
  const candidates = weighted.flatMap((phase, phaseIndex) =>
    phase.tracks.map((track) => ({ ...track, phaseIndex })),
  );

  const firstPass = await resolver.resolve(candidates, {
    signal: AbortSignal.timeout(Math.max(2_000, budgetMs - elapsed())),
  });
  let partial = firstPass.partial;

  let phases = weighted.map((phase, phaseIndex) => ({
    name: phase.name,
    scentNotes: phase.scentNotes,
    weight: phase.weight,
    tracks: firstPass.tracks.filter((track) => track.phaseIndex === phaseIndex),
  }));
  phases = trimToQuota(dedupeAcrossScore(phases), duration);

  // ---- 3. one combined backfill for every short phase --------------------
  const shortfalls = shortfallsFor(phases, duration);
  const canBackfill =
    shortfalls.length > 0 && callsUsed < MAX_MODEL_CALLS && elapsed() < backfillCutoffMs;

  if (canBackfill) {
    callsUsed += 1;
    const survivingArtists = phases.flatMap((p) => p.tracks.map((t) => t.artist));
    const missedArtists = firstPass.misses.map((m) => m.artist);
    try {
      const extra = await callModel({
        system,
        prompt: buildBackfillPrompt({
          input,
          duration,
          discovery,
          interpretation: parsed.interpretation,
          shortfalls,
          excludedArtists: [...new Set([...survivingArtists, ...missedArtists])],
          excludedTracks: firstPass.misses.map(({ title, artist }) => ({ title, artist })),
        }),
        schema: backfillSchema,
        timeoutMs: Math.max(5_000, budgetMs - elapsed() - 5_000),
      });

      const extraCandidates = (extra?.phases ?? []).flatMap((phase) => {
        const phaseIndex = PHASE_ORDER.indexOf(phase.name);
        if (phaseIndex === -1) return [];
        return (phase.tracks ?? []).map((track) => ({ ...track, phaseIndex }));
      });

      if (extraCandidates.length) {
        const secondPass = await resolver.resolve(extraCandidates, {
          signal: AbortSignal.timeout(Math.max(2_000, budgetMs - elapsed())),
        });
        partial = partial || secondPass.partial;
        phases = phases.map((phase, phaseIndex) => ({
          ...phase,
          tracks: [
            ...phase.tracks,
            ...secondPass.tracks.filter((track) => track.phaseIndex === phaseIndex),
          ],
        }));
        phases = trimToQuota(dedupeAcrossScore(phases), duration);
      }
    } catch (error) {
      // A failed backfill is a shorter score, never a failed generation.
      onEvent({ type: 'backfill_failed', message: error?.message });
    }
  }

  // ---- 4. assemble ------------------------------------------------------
  const cleaned = phases.map((phase) => ({
    name: phase.name,
    scentNotes: phase.scentNotes,
    weight: phase.weight,
    tracks: phase.tracks.map(({ phaseIndex, ...track }) => track),
  }));

  const trackCount = cleaned.reduce((sum, phase) => sum + phase.tracks.length, 0);
  const expectedTrackCount = totalQuota(duration);
  const runtimeMs = cleaned.reduce(
    (sum, phase) => sum + phase.tracks.reduce((inner, t) => inner + (t.durationMs || 0), 0),
    0,
  );

  if (trackCount === 0) {
    throw new ScoreError(ERROR_CODES.GENERATION_FAILED, 'no tracks could be resolved');
  }

  return {
    title: parsed.title,
    interpretation: parsed.interpretation,
    phases: cleaned,
    trackCount,
    expectedTrackCount,
    short: trackCount < expectedTrackCount,
    partial,
    runtimeMs,
    modelCalls: callsUsed,
  };
}
