/**
 * Vibin' Out v2 — the Drydown Score.
 *
 * Three routes, no auth, no sessions. Nothing here connects to Mongo or
 * Spotify at import time: on Vercel this module is evaluated on every cold
 * start, and the home page must render even when every dependency is down.
 */
import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import home from './routes/index.js';
import score from './routes/score.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'hbs');

// Behind Vercel's proxy — required for correct client IPs in the rate limiter.
app.set('trust proxy', 1);

// No app-wide body parser. POST /api/score is the only route that reads a body,
// and since v1.5 it needs a 4MB ceiling for a photo — mounting that globally
// would hand every other path (including 404s) a 4MB buffer to fill. The
// parsers live on the route instead, where the friendly `photo_too_large`
// answer lives too. See routes/score.js.
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.use('/', home);
app.use('/', score);

app.use((req, res) => {
  res.status(404).render('error', {
    title: 'nothing here',
    message: 'That page has no scent behind it.',
  });
});

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
app.use((error, req, res, next) => {
  console.error('[unhandled]', error?.stack || error);
  res.status(500).render('error', {
    title: 'something went wrong',
    message: 'The still misfired. Try again in a moment.',
  });
});

// On Vercel the app is imported by api/index.js and served as a function;
// only bind a port when this file is run directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`vibin' out listening on http://localhost:${port}`));
}

export default app;
