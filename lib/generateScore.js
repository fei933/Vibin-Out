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

/**
 * Time budget, sized from measured generation latency (2026-07-27, ten-fixture
 * eval): a 30-minute score takes ~11s of model time, a 60-minute score ~46s,
 * a 90-minute score ~62s — output size scales with the track quota, so the
 * long pills are far slower than the short ones.
 *
 * Vercel's Hobby plan allows up to 300s per function (verified against the
 * duration docs), so the budget is 240s with the remainder as headroom.
 * The previous 45s budget silently made the 60- and 90-minute pills
 * impossible: every long generation aborted itself and returned
 * generation_failed.
 */
export const DEFAULT_BUDGET_MS = 240_000;
/** Ceiling for any single model call. ~45% headroom over the slowest measured. */
export const MODEL_CALL_TIMEOUT_MS = 90_000;
/** Held back from every model call so resolution and persistence still fit. */
export const RESOLVE_RESERVE_MS = 25_000;
/** A backfill is only started when at least this much budget remains. */
export const BACKFILL_RESERVE_MS = 60_000;

function artistKey(artist) {
  return normalizeName(splitArtists(artist)[0] ?? artist);
}

function issueSummary(error) {
  return (error?.issues ?? [])
    .slice(0, 4)
    .map((issue) => `${issue.path?.join('.') || 'root'}: ${issue.message}`)
    .join('; ');
}

/** Same folding the resolver uses, so "Skinny Love" and "Skinny Love" agree. */
function titleKey(title) {
  return normalizeName(title);
}

/**
 * Drop tracks that would repeat a Spotify id, an artist, or a TITLE already
 * in the score.
 *
 * The title rule is what the artist rule cannot see: covers. One eval score
 * played "Skinny Love" twice in a row — Bon Iver's, then Birdy's — because
 * two different artists satisfied the artist rule perfectly. Another paired
 * Etta James' "At Last" with Al Green's.
 *
 * Order decides the winner: top phase first, then heart, then base. The
 * score is a deliberate arc, so the earlier position has the stronger claim
 * on a title. Losers are returned rather than discarded — they have to
 * become misses so the phase is backfilled and the title is excluded from
 * the replacement request.
 *
 * @returns {{phases: object[], dropped: object[]}}
 */
export function dedupeAcrossScore(phases) {
  const seenIds = new Set();
  const seenArtists = new Set();
  const seenTitles = new Set();
  const dropped = [];

  const kept = phases.map((phase) => ({
    ...phase,
    tracks: phase.tracks.filter((track) => {
      const artist = artistKey(track.artist);
      const title = titleKey(track.title);
      if (seenIds.has(track.spotifyId)) {
        dropped.push({ ...track, reason: 'duplicate_track' });
        return false;
      }
      if (seenArtists.has(artist)) {
        dropped.push({ ...track, reason: 'duplicate_artist' });
        return false;
      }
      if (seenTitles.has(title)) {
        dropped.push({ ...track, reason: 'duplicate_title' });
        return false;
      }
      seenIds.add(track.spotifyId);
      seenArtists.add(artist);
      seenTitles.add(title);
      return true;
    }),
  }));

  return { phases: kept, dropped };
}

export function runtimeOf(phases) {
  return phases.reduce(
    (sum, phase) => sum + phase.tracks.reduce((inner, t) => inner + (t.durationMs || 0), 0),
    0,
  );
}

/**
 * Track counts alone are a bad proxy for runtime. Twelve three-minute records
 * "satisfy" the 60-minute quota at 36 real minutes — a third short of what the
 * pill promised. The design doc's bar is the pill's minutes ±20%, so the
 * resolved `duration_ms` decides whether a score is actually complete.
 *
 * Only the lower bound is enforced. Running long is not a broken promise, and
 * the doc says to accept and note it rather than trim.
 */
export const RUNTIME_TOLERANCE = 0.2;
/** Used to size a top-up before any real track durations are known. */
export const ASSUMED_TRACK_MS = 210_000;
/** A runtime top-up may not stretch a phase by more than this. */
export const MAX_RUNTIME_TOPUP_PER_PHASE = 2;

export function runtimeBounds(duration) {
  const target = duration * 60_000;
  return {
    target,
    min: Math.round(target * (1 - RUNTIME_TOLERANCE)),
    max: Math.round(target * (1 + RUNTIME_TOLERANCE)),
  };
}

function averageTrackMs(phases) {
  const durations = phases.flatMap((p) => p.tracks.map((t) => t.durationMs || 0)).filter(Boolean);
  if (!durations.length) return ASSUMED_TRACK_MS;
  return durations.reduce((a, b) => a + b, 0) / durations.length;
}

/**
 * Per-phase track targets: the duration quota, topped up when the resolved
 * runtime falls under tolerance. Extra slots are handed to the phases with the
 * most weight, since that is where the runtime is supposed to live.
 */
export function phaseTargets(phases, duration) {
  const quota = quotaFor(duration);
  const targets = Object.fromEntries(PHASE_ORDER.map((name) => [name, quota[name]]));

  const { min } = runtimeBounds(duration);
  const deficitMs = min - runtimeOf(phases);
  if (deficitMs <= 0) return targets;

  let extra = Math.ceil(deficitMs / averageTrackMs(phases));
  const byWeight = [...phases].sort((a, b) => (b.weight || 0) - (a.weight || 0));
  for (const phase of byWeight) {
    if (extra <= 0) break;
    const share = Math.min(extra, MAX_RUNTIME_TOPUP_PER_PHASE);
    targets[phase.name] += share;
    extra -= share;
  }
  return targets;
}

function trimToQuota(phases, targets) {
  return phases.map((phase) => ({ ...phase, tracks: phase.tracks.slice(0, targets[phase.name]) }));
}

function shortfallsFor(phases, targets) {
  return phases
    .map((phase) => ({
      name: phase.name,
      scentNotes: phase.scentNotes,
      needed: targets[phase.name] - phase.tracks.length,
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
    backfillReserveMs = BACKFILL_RESERVE_MS,
    onEvent = () => {},
  } = {},
) {
  const startedAt = now();
  const elapsed = () => now() - startedAt;
  const remaining = () => budgetMs - elapsed();
  /**
   * Every model call gets a real timeout. Deriving it as
   * `remaining - reserve` alone made the retry worthless: once the primary
   * call had burned the budget, the retry inherited a few seconds and could
   * only ever time out too, so a single slow call consumed both attempts.
   */
  const callTimeout = () =>
    Math.min(MODEL_CALL_TIMEOUT_MS, Math.max(10_000, remaining() - RESOLVE_RESERVE_MS));
  const system = buildSystemPrompt();
  const basePrompt = buildScorePrompt({ input, duration, discovery });
  let callsUsed = 0;
  // Recorded on the result (and so on the stored document): `modelCalls` alone
  // cannot tell a schema retry apart from a backfill, and the fixture eval
  // needs to know which scores actually needed the third call.
  let backfilled = false;

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
        timeoutMs: callTimeout(),
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
  // Everything the score cannot use — unresolvable, over-long, or a duplicate
  // title/artist — is pooled here. It drives the backfill's exclusion lists,
  // so the replacement request never re-proposes what was just rejected.
  const rejected = [...firstPass.misses];
  {
    const { phases: deduped, dropped } = dedupeAcrossScore(phases);
    rejected.push(...dropped);
    phases = trimToQuota(deduped, quotaFor(duration));
  }

  // Targets are the duration quota, topped up when the *resolved* runtime came
  // in under the pill's minutes -20%. Computed after the first pass, because
  // it takes real track lengths to know whether the score is actually long
  // enough — a full count of short records is still a short score.
  const targets = phaseTargets(phases, duration);

  // ---- 3. one combined backfill for every short phase --------------------
  const shortfalls = shortfallsFor(phases, targets);
  const canBackfill =
    shortfalls.length > 0 && callsUsed < MAX_MODEL_CALLS && remaining() > backfillReserveMs;

  if (canBackfill) {
    callsUsed += 1;
    backfilled = true;
    onEvent({ type: 'backfill', shortfalls });
    const survivingArtists = phases.flatMap((p) => p.tracks.map((t) => t.artist));
    const survivingTitles = phases.flatMap((p) => p.tracks.map((t) => t.title));
    try {
      const extra = await callModel({
        system,
        prompt: buildBackfillPrompt({
          input,
          duration,
          discovery,
          interpretation: parsed.interpretation,
          shortfalls,
          excludedArtists: [
            ...new Set([...survivingArtists, ...rejected.map((m) => m.artist)]),
          ],
          // Titles already in the score are excluded too, so the backfill
          // cannot hand us a cover of a record we are already playing.
          excludedTitles: [...new Set([...survivingTitles, ...rejected.map((m) => m.title)])],
          excludedTracks: rejected.map(({ title, artist }) => ({ title, artist })),
        }),
        schema: backfillSchema,
        timeoutMs: callTimeout(),
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
        const { phases: deduped } = dedupeAcrossScore(phases);
        phases = trimToQuota(deduped, targets);
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

  // One batched artist lookup for the whole score, so the indie badge is a
  // claim about the artist rather than about one quiet track. Best-effort:
  // a failure leaves the track-only verdict in place.
  let indieGrounded = false;
  if (typeof resolver.enrichIndie === 'function') {
    try {
      const { enriched } = await resolver.enrichIndie(
        cleaned.flatMap((phase) => phase.tracks),
        { signal: AbortSignal.timeout(Math.max(2_000, Math.min(10_000, remaining()))) },
      );
      indieGrounded = enriched;
    } catch (error) {
      onEvent({ type: 'indie_enrich_failed', message: error?.message });
    }
  }

  const trackCount = cleaned.reduce((sum, phase) => sum + phase.tracks.length, 0);
  const expectedTrackCount = totalQuota(duration);
  const runtimeMs = runtimeOf(cleaned);
  const bounds = runtimeBounds(duration);

  if (trackCount === 0) {
    throw new ScoreError(ERROR_CODES.GENERATION_FAILED, 'no tracks could be resolved');
  }

  // Short on records OR short on minutes. Running long is fine — the doc asks
  // for ±20% and says to accept the overshoot rather than trim it.
  const runtimeShort = runtimeMs < bounds.min;

  return {
    title: parsed.title,
    interpretation: parsed.interpretation,
    phases: cleaned,
    trackCount,
    expectedTrackCount,
    short: trackCount < expectedTrackCount || runtimeShort,
    runtimeShort,
    partial,
    runtimeMs,
    targetRuntimeMs: bounds.target,
    modelCalls: callsUsed,
    backfilled,
    indieGrounded,
  };
}
