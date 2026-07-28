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
import { lbRadioFromEnv, sanitizeTags } from './lbRadio.js';
import { callModel as defaultCallModel } from './llm.js';
import { normalizeName, splitArtists } from './matchVerification.js';
import {
  backfillSchema,
  llmScoreSchema,
  llmScoreWithTagsSchema,
  normalizeWeights,
  PHASE_ORDER,
  quotaFor,
  scoreSchema,
  scoreWithTagsSchema,
  selectionSchema,
  totalQuota,
} from './schema.js';
import {
  buildBackfillPrompt,
  buildRetryPrompt,
  buildScorePrompt,
  buildSelectionPrompt,
  buildSelectionSystemPrompt,
  buildSystemPrompt,
} from './prompt.js';
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

// ------------------------------------------------- the discovery provider
//
// Only reachable when the dial is deep cuts AND LB_RADIO/LB_TOKEN are both
// set — see lib/lbRadio.js. Everything in this section is written so that
// every failure returns a reason instead of throwing: the caller answers a
// reason by running the ordinary model-proposes-tracks path, which is still
// fully in hand because the primary call named records as well as tags.

/** A phase is only started when this much budget remains — it costs a call. */
export const LB_RESERVE_MS = 60_000;
export const LB_MIN_CANDIDATES = 10;
export const LB_MAX_CANDIDATES = 18;

/**
 * How many candidates per phase are worth resolving. Every candidate costs a
 * playback-provider search, so the pool is sized for enough room to choose
 * (and to absorb records that will not resolve) and no more.
 */
export function candidateCap(quotaCount) {
  return Math.min(LB_MAX_CANDIDATES, Math.max(LB_MIN_CANDIDATES, quotaCount * 3));
}

/**
 * How many records to ask for per phase.
 *
 * Same job as `phaseTargets`, one step earlier: on this path every candidate
 * is already resolved, so real durations are known BEFORE anything is chosen
 * and the runtime top-up can be folded into the single selection call rather
 * than costing a backfill. Extra slots are capped by what the pool can supply.
 */
export function poolTargets(pools, duration) {
  const quota = quotaFor(duration);
  const targets = Object.fromEntries(PHASE_ORDER.map((name) => [name, quota[name]]));

  const average = (tracks) => {
    const durations = tracks.map((t) => t.durationMs || 0).filter(Boolean);
    if (!durations.length) return ASSUMED_TRACK_MS;
    return durations.reduce((a, b) => a + b, 0) / durations.length;
  };

  const projected = pools.reduce((sum, pool) => sum + targets[pool.name] * average(pool.tracks), 0);
  const { min } = runtimeBounds(duration);
  if (projected >= min) return targets;

  let extra = Math.ceil((min - projected) / average(pools.flatMap((pool) => pool.tracks)));
  for (const pool of [...pools].sort((a, b) => (b.weight || 0) - (a.weight || 0))) {
    if (extra <= 0) break;
    const room = pool.tracks.length - targets[pool.name];
    const share = Math.max(0, Math.min(extra, MAX_RUNTIME_TOPUP_PER_PHASE, room));
    targets[pool.name] += share;
    extra -= share;
  }
  return targets;
}

/**
 * Turn the model's numbered picks back into resolved tracks.
 *
 * Everything unrecognised is dropped rather than repaired: an id the phase was
 * not offered, an id borrowed from another phase, a repeat, a pick with no
 * sentence. The model can only ever narrow the list it was given, which is the
 * property that makes this call unable to invent a record.
 */
export function pickSelected(pools, selection, targets) {
  const used = new Set();
  return pools.map((pool) => {
    const offered = new Map(pool.tracks.map((track) => [track.candidateId, track]));
    const picks = (selection?.phases ?? []).find((entry) => entry?.name === pool.name)?.picks ?? [];
    const tracks = [];

    for (const pick of picks) {
      if (tracks.length >= targets[pool.name]) break;
      const track = offered.get(pick?.id);
      if (!track || used.has(pick.id)) continue;
      const why = typeof pick.why === 'string' ? pick.why.trim() : '';
      if (!why) continue;
      used.add(pick.id);
      const { candidateId, ...rest } = track;
      tracks.push({ ...rest, why });
    }

    return { ...pool, tracks };
  });
}

/**
 * The whole provider path: tags → LB Radio → resolve → one selection call.
 *
 * @returns {Promise<{phases?: object[], partial?: boolean, modelCalls: number, reason?: string}>}
 *   `phases` present means the score came from the provider; a `reason`
 *   instead means fall back. `modelCalls` is spent either way.
 */
export async function lbRadioPhases({
  lbRadio,
  weighted,
  input,
  duration,
  discovery,
  interpretation,
  callModel,
  resolver,
  signalFor,
  callTimeout,
  onEvent = () => {},
}) {
  const quota = quotaFor(duration);

  // Sanitized here as well as inside the client: these strings were written by
  // a model that had just read visitor-supplied text.
  const tagsByPhase = weighted.map((phase) => sanitizeTags(phase.discoveryTags));
  if (tagsByPhase.some((tags) => tags.length === 0)) return { modelCalls: 0, reason: 'no_tags' };

  let fetched;
  try {
    fetched = await Promise.all(
      tagsByPhase.map((tags) => lbRadio.tracksForTags(tags, { signal: signalFor() })),
    );
  } catch (error) {
    return { modelCalls: 0, reason: error?.reason || 'fetch_failed' };
  }
  if (fetched.some((tracks, i) => tracks.length < quota[PHASE_ORDER[i]])) {
    return { modelCalls: 0, reason: 'thin_candidates' };
  }
  onEvent({ type: 'lb_radio_candidates', counts: fetched.map((tracks) => tracks.length) });

  let candidateId = 0;
  const candidates = fetched.flatMap((tracks, phaseIndex) =>
    tracks.slice(0, candidateCap(quota[PHASE_ORDER[phaseIndex]])).map((track) => ({
      ...track,
      phaseIndex,
      candidateId: candidateId++,
    })),
  );

  // The candidates go through the SAME resolver the model's proposals do:
  // search, match verification, album art, popularity. LB Radio decides what
  // the record is; the playback provider decides whether it can be played.
  let resolved;
  try {
    resolved = await resolver.resolve(candidates, { signal: signalFor() });
  } catch (error) {
    return { modelCalls: 0, reason: 'resolve_failed' };
  }

  let pools = weighted.map((phase, phaseIndex) => ({
    name: phase.name,
    scentNotes: phase.scentNotes,
    weight: phase.weight,
    tracks: resolved.tracks.filter((track) => track.phaseIndex === phaseIndex),
  }));
  // De-duplicate the POOL rather than the finished score: the phases are then
  // disjoint, so whatever the model picks cannot repeat an artist or a title
  // and no pick has to be thrown away afterwards.
  ({ phases: pools } = dedupeAcrossScore(pools));
  if (pools.some((pool) => pool.tracks.length < quota[pool.name])) {
    return { modelCalls: 0, reason: 'thin_pool' };
  }

  const targets = poolTargets(pools, duration);

  let selection;
  try {
    selection = await callModel({
      system: buildSelectionSystemPrompt(),
      prompt: buildSelectionPrompt({
        input,
        duration,
        discovery,
        interpretation,
        phases: pools.map((pool) => ({
          name: pool.name,
          scentNotes: pool.scentNotes,
          needed: targets[pool.name],
          candidates: pool.tracks.map((track) => ({
            id: track.candidateId,
            title: track.title,
            artist: track.artist,
            durationMs: track.durationMs,
          })),
        })),
      }),
      schema: selectionSchema,
      timeoutMs: callTimeout(),
    });
  } catch (error) {
    onEvent({ type: 'lb_radio_selection_failed', message: error?.message });
    return { modelCalls: 1, reason: 'selection_failed' };
  }

  const phases = pickSelected(pools, selection, targets);
  if (phases.some((phase) => phase.tracks.length < quota[phase.name])) {
    return { modelCalls: 1, reason: 'thin_selection' };
  }
  return { phases, partial: resolved.partial, modelCalls: 1 };
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
  { input, duration, discovery, photo = null },
  {
    callModel = defaultCallModel,
    resolver = spotifyResolver(),
    lbRadio = lbRadioFromEnv(),
    now = () => Date.now(),
    budgetMs = DEFAULT_BUDGET_MS,
    backfillReserveMs = BACKFILL_RESERVE_MS,
    lbReserveMs = LB_RESERVE_MS,
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
  /**
   * A photo makes only the PRIMARY call multimodal. The backfill is handed the
   * interpretation the primary call already produced, so re-sending the image
   * would buy nothing and cost image tokens on every short score — hence two
   * system prompts, and `image` passed at exactly one call site below.
   */
  const system = buildSystemPrompt({ photo: Boolean(photo) });
  const backfillSystem = photo ? buildSystemPrompt() : system;
  /**
   * The discovery provider is scoped to deep cuts and ships off. When it is
   * off — which is the default, and always the case for familiar and balanced
   * — nothing below this line changes: same prompt, same schema, same path.
   */
  const lbActive = discovery === 'deepcuts' && Boolean(lbRadio?.enabled);
  const basePrompt = buildScorePrompt({
    input,
    duration,
    discovery,
    photo: Boolean(photo),
    discoveryTags: lbActive,
  });
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
        schema: lbActive ? llmScoreWithTagsSchema : llmScoreSchema,
        image: photo?.dataUrl,
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

    const check = (lbActive ? scoreWithTagsSchema : scoreSchema).safeParse(raw);
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

  // ---- 2. real records ---------------------------------------------------
  const weighted = normalizeWeights(parsed.phases);
  const deadline = () => AbortSignal.timeout(Math.max(2_000, budgetMs - elapsed()));

  /** Provenance, carried onto the stored document. 'llm' is the default path. */
  let discoverySource = 'llm';
  let phases = null;
  let partial = false;
  // Everything the score cannot use — unresolvable, over-long, or a duplicate
  // title/artist — is pooled here. It drives the backfill's exclusion lists,
  // so the replacement request never re-proposes what was just rejected.
  const rejected = [];

  // ---- 2a. the discovery provider, when it is on -------------------------
  //
  // Every way this can go wrong ends in the same place: `phases` stays null
  // and the ordinary path below runs on the records the primary call already
  // named. A visitor is never told any of this happened.
  if (lbActive && callsUsed < MAX_MODEL_CALLS && remaining() > lbReserveMs) {
    const outcome = await lbRadioPhases({
      lbRadio,
      weighted,
      input,
      duration,
      discovery,
      interpretation: parsed.interpretation,
      callModel,
      resolver,
      signalFor: deadline,
      callTimeout,
      onEvent,
    }).catch((error) => ({ modelCalls: 0, reason: error?.reason || 'lb_radio_threw' }));

    callsUsed += outcome.modelCalls;
    if (outcome.phases) {
      phases = outcome.phases;
      partial = Boolean(outcome.partial);
      discoverySource = 'lb-radio';
      onEvent({ type: 'lb_radio', tracks: phases.reduce((n, p) => n + p.tracks.length, 0) });
    } else {
      onEvent({ type: 'lb_radio_fallback', reason: outcome.reason });
    }
  }

  // ---- 2b. otherwise, resolve the model's own proposals ------------------
  if (!phases) {
    const candidates = weighted.flatMap((phase, phaseIndex) =>
      phase.tracks.map(({ discoveryTags, ...track }) => ({ ...track, phaseIndex })),
    );

    const firstPass = await resolver.resolve(candidates, { signal: deadline() });
    partial = firstPass.partial;

    phases = weighted.map((phase, phaseIndex) => ({
      name: phase.name,
      scentNotes: phase.scentNotes,
      weight: phase.weight,
      tracks: firstPass.tracks.filter((track) => track.phaseIndex === phaseIndex),
    }));
    rejected.push(...firstPass.misses);
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
  //
  // Not available on the provider path. A backfill asks the model to name
  // records from memory, which is the exact thing that path exists to replace:
  // topping up a discovery score with chart-familiar picks would quietly undo
  // it. The provider instead sizes its own request to the runtime up front,
  // where real durations are already known.
  const shortfalls = shortfallsFor(phases, targets);
  const canBackfill =
    discoverySource === 'llm' &&
    shortfalls.length > 0 &&
    callsUsed < MAX_MODEL_CALLS &&
    remaining() > backfillReserveMs;

  if (canBackfill) {
    callsUsed += 1;
    backfilled = true;
    onEvent({ type: 'backfill', shortfalls });
    const survivingArtists = phases.flatMap((p) => p.tracks.map((t) => t.artist));
    const survivingTitles = phases.flatMap((p) => p.tracks.map((t) => t.title));
    try {
      const extra = await callModel({
        system: backfillSystem,
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
    // `candidateId` is the discovery path's internal handle; like `phaseIndex`
    // it must not reach the stored document.
    tracks: phase.tracks.map(({ phaseIndex, candidateId, ...track }) => track),
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

  const runtimeShort = runtimeMs < bounds.min;

  return {
    title: parsed.title,
    interpretation: parsed.interpretation,
    phases: cleaned,
    trackCount,
    expectedTrackCount,
    /**
     * The promise a visitor makes with the duration pill is MINUTES, not a
     * track count, so that is what "shorter than usual" is about:
     *   - `runtimeShort` — the music does not reach the pill's minutes -20%
     *   - `partial`      — the provider stopped answering, so some records
     *                      could not be verified
     * A score under its track quota that still fills the runtime is NOT short:
     * seventeen records that play for 80 of a promised 90 minutes kept the
     * promise, and saying otherwise undersells a good score. Track count stays
     * on the result for diagnostics, but no longer drives the note.
     */
    short: runtimeShort || partial,
    runtimeShort,
    partial,
    runtimeMs,
    targetRuntimeMs: bounds.target,
    modelCalls: callsUsed,
    backfilled,
    indieGrounded,
    /**
     * Where the records came from: 'lb-radio' when the ListenBrainz provider
     * chose them, 'llm' when the model named them — including every silent
     * fallback, which is what makes this field the honest record of whether
     * the provider actually did anything.
     */
    discoverySource,
  };
}
