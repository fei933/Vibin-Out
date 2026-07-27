/**
 * Design preview server — no Mongo, no LLM, no Spotify credentials.
 *
 * The real Express app renders `/` and serves `public/` unchanged; this file
 * only stands in front of it to render the real `score` template against a
 * fixture view model, so the score page can be looked at (and screenshotted)
 * without a database.
 *
 *   node scripts/preview.mjs           → http://localhost:4321
 *   /                                  → home
 *   /score/rain-through-cedar-x3k9qf   → the score page
 *   /score/...?short=1                 → the "shorter than usual" variant
 *   /anything-else                     → the error page (the app's own 404)
 *
 * The Spotify IDs below are real, so the embeds actually load.
 */
import express from 'express';
import app from '../app.js';
import { toScoreViewModel } from '../lib/viewModel.js';

const track = (spotifyId, title, artist, durationMs, why, popularity) => ({
  spotifyId,
  title,
  artist,
  durationMs,
  why,
  popularity,
  indie: popularity < 40,
});

const DOC = {
  slug: 'rain-through-cedar-x3k9qf',
  input: 'bergamot, black tea, cedar — a quiet bookshop on a rainy day',
  options: { duration: 60, discovery: 'deepcuts' },
  createdAt: new Date('2026-07-27T00:00:00Z'),
  result: {
    title: 'Rain Through Cedar',
    interpretation: 'Cool mineral air settling into dry wood, with the tea steeping somewhere in between.',
    trackCount: 12,
    expectedTrackCount: 12,
    short: false,
    runtimeMs: 3_474_000,
    phases: [
      {
        name: 'top',
        scentNotes: 'bergamot, wet stone, grapefruit peel',
        weight: 0.25,
        tracks: [
          track(
            '00kPyLYWouR6nFC8yQY5Kb',
            'Charcoal',
            'Lynx XII',
            188_717,
            'Struck-match percussion, then air — the zest lifting off before you have decided what it is.',
            48,
          ),
          track(
            '08xxuQziMz80GTm8Zfxob1',
            'Leithinis',
            'Coileáinn',
            161_500,
            'A cold room with the window open: that first mineral snap of wet stone.',
            21,
          ),
          track(
            '09umuNRfuF4eDY7wZtOif3',
            'Ephemeral',
            'Zephyrical',
            170_483,
            'Bright, thin, already leaving. Top notes never intend to stay.',
            44,
          ),
        ],
      },
      {
        name: 'heart',
        scentNotes: 'black tea, orris, a thread of smoke',
        weight: 0.45,
        tracks: [
          track(
            '0CxqhLRldWvPvU6ZlvrCjG',
            'Purity',
            'Calmative',
            164_500,
            'The steep begins. Everything softens by a degree and stops hurrying.',
            52,
          ),
          track(
            '0gGoQFbwTakternKhDooJB',
            'Fljótandi',
            'Harmonic Reverie',
            159_374,
            'Tannin in the low end — bitter enough to stay interesting, warm enough to sit in.',
            37,
          ),
          track(
            '04DOoRqn0mhGrVSXWWFZy5',
            'Space Patrol',
            'No Spirit, Sátyr',
            162_400,
            'Smoke drifts across the middle of the record the way it drifts across a room.',
            56,
          ),
          track(
            '0dWVhN39VMnSGh0xiCKggR',
            'flight mode',
            'DYVN, Horace Maurice',
            106_000,
            'Held chords doing what orris does: rounding the edges off the tea.',
            41,
          ),
          track(
            '0H69sRjYmMXDyRGJWrcFtt',
            'In Time',
            'Monocloud, lightheart, Howden',
            140_487,
            'The moment a scent stops announcing itself and simply becomes the room.',
            49,
          ),
        ],
      },
      {
        name: 'base',
        scentNotes: 'cedar, vetiver, dry paper',
        weight: 0.3,
        tracks: [
          track(
            '06mrX3LFC65jmule6OhXrC',
            'Hidden Treasure',
            'Starstrum',
            136_824,
            'Dry wood, close-miked. You can hear the grain.',
            33,
          ),
          track(
            '07KfFPBzpGkBNnsDKcg7o1',
            'Void',
            'Lush Hush',
            150_769,
            'Cedar’s long exhale — nothing added, only what is left behind.',
            45,
          ),
          track(
            '099WpHvgNrPDQjiCOHUtVO',
            'North Of Here',
            'Lerone Gios',
            148_406,
            'Vetiver’s green earth, kept low so the smell of paper can come through.',
            29,
          ),
          track(
            '0dOQLc1j61PCiiAlqr2D6R',
            'Mirth',
            'Gabriel Stone',
            144_559,
            'The last thing still playing on the shelf once everyone has gone home.',
            51,
          ),
        ],
      },
    ],
  },
};

const preview = express();

preview.get('/score/:slug', (req, res, next) => {
  const doc = {
    ...DOC,
    result: { ...DOC.result, short: req.query.short === '1' },
  };
  const score = toScoreViewModel(doc);
  app.render('score', { score, pageTitle: score.title, isScore: true }, (error, html) =>
    error ? next(error) : res.type('html').send(html),
  );
});

// Everything else — home, static assets, the 404/error page — is the real app.
preview.use(app);

const port = Number(process.env.PREVIEW_PORT) || 4321;
preview.listen(port, () => {
  console.log(`preview → http://localhost:${port}/`);
  console.log(`preview → http://localhost:${port}/score/${DOC.slug}`);
});
