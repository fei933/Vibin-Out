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
    })),
  }));

  // Order defensively — stored documents are the long-lived artefact.
  phases.sort((a, b) => PHASE_ORDER.indexOf(a.name) - PHASE_ORDER.indexOf(b.name));

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
    arc: phases.map(({ name, label, pct: width, scentNotes }) => ({
      name,
      label,
      pct: width,
      scentNotes,
    })),
    trackCount: result.trackCount ?? phases.reduce((sum, p) => sum + p.tracks.length, 0),
    expectedTrackCount: result.expectedTrackCount ?? null,
    short: Boolean(result.short || result.partial),
    runtimeLabel: formatRuntime(result.runtimeMs),
    createdAt: doc.createdAt ?? null,
  };
}
