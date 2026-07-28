/**
 * Stored document → template data.
 *
 * Handlebars cannot do arithmetic, so every derived value a template could
 * possibly want (percent widths, labels, embed URLs, formatted runtime) is
 * computed here. This is the contract the score template is written
 * against; a restyle should need to change the markup, never this shape.
 */
import { PHASE_LABELS, PHASE_ORDER } from './schema.js';

export const EMBED_BASE = 'https://open.spotify.com/embed/track/';

const DISCOVERY_LABELS = {
  familiar: 'Familiar',
  balanced: 'Balanced',
  deepcuts: 'Deep cuts',
};

function pct(weight) {
  return Math.round((Number(weight) || 0) * 1000) / 10; // one decimal, sums to ~100
}

export function formatRuntime(runtimeMs) {
  const minutes = Math.round((Number(runtimeMs) || 0) / 60000);
  return minutes > 0 ? `${minutes} min` : null;
}

export function toScoreViewModel(doc) {
  if (!doc?.result) return null;
  const { result } = doc;
  const options = doc.options ?? {};

  const phases = (result.phases ?? []).map((phase) => ({
    name: phase.name,
    label: PHASE_LABELS[phase.name] ?? phase.name,
    scentNotes: phase.scentNotes,
    weight: phase.weight,
    pct: pct(phase.weight),
    trackCount: (phase.tracks ?? []).length,
    tracks: (phase.tracks ?? []).map((track) => ({
      title: track.title,
      artist: track.artist,
      why: track.why,
      spotifyId: track.spotifyId,
      embedUrl: `${EMBED_BASE}${track.spotifyId}`,
      popularity: track.popularity,
      durationMs: track.durationMs,
      indie: Boolean(track.indie),
      // Null for scores stored before artwork was captured, for releases with
      // no cover, and for the key-death degraded mode. Templates must handle
      // it rather than assume a URL.
      albumArt: track.albumArt ?? null,
    })),
  }));

  // Order defensively — stored documents are the long-lived artefact.
  phases.sort((a, b) => PHASE_ORDER.indexOf(a.name) - PHASE_ORDER.indexOf(b.name));

  /**
   * The halo carousel's input: unique cover URLs in render order (top phase
   * first), nulls dropped. Deduped because a score can legitimately draw two
   * tracks from one album, and the ring should not show the same tile twice.
   *
   * An EMPTY ARRAY is a normal, expected state — old scores, art-less
   * releases, degraded mode — and means "omit the carousel entirely". It is
   * never null, so a template can iterate it without a guard.
   */
  const artwork = [
    ...new Set(phases.flatMap((phase) => phase.tracks.map((track) => track.albumArt)).filter(Boolean)),
  ];

  return {
    slug: doc.slug,
    title: result.title,
    // Deliberately NOT doc.input: the page shows the model's reading of the
    // scent, never the visitor's raw words.
    interpretation: result.interpretation,
    duration: options.duration ?? null,
    durationLabel: options.duration ? `${options.duration} min` : null,
    discovery: options.discovery ?? null,
    discoveryLabel: DISCOVERY_LABELS[options.discovery] ?? null,
    phases,
    artwork,
    arc: phases.map(({ name, label, pct: width, scentNotes }) => ({
      name,
      label,
      pct: width,
      scentNotes,
    })),
    trackCount: result.trackCount ?? phases.reduce((sum, p) => sum + p.tracks.length, 0),
    expectedTrackCount: result.expectedTrackCount ?? null,
    /**
     * "This runs shorter than promised, or we could not verify some records."
     * NOT "the track count is under quota" — the duration pill promises
     * minutes, so a score that fills its runtime with fewer records is
     * complete. (`|| result.partial` is kept for documents stored before the
     * semantics changed, whose `short` was computed from track count.)
     */
    short: Boolean(result.short || result.partial),
    // Which of the two it is, so the page can say something specific.
    runtimeShort: Boolean(result.runtimeShort),
    partial: Boolean(result.partial),
    runtimeLabel: formatRuntime(result.runtimeMs),
    createdAt: doc.createdAt ?? null,
  };
}
