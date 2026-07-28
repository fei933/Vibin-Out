/**
 * GET /callback — the OAuth return hop, and the only new server surface the
 * export needs.
 *
 * It does nothing with the authorization code. The code arrives in the query
 * string, the browser reads it, exchanges it for a token against
 * accounts.spotify.com with the PKCE verifier it kept in sessionStorage, and
 * navigates back to the score. The server sees the request URL and renders a
 * page — it never reads the code, never proxies the exchange, never stores a
 * token. That is the design doc's condition for the feature existing at all
 * (v2.1 §4: "Tokens live only in the browser... this is per-action
 * authorization, not an account system").
 *
 * Registered redirect URIs (Spotify dashboard):
 *   https://vibin-out.vercel.app/callback
 *   https://localhost:3000/callback     ← `npm run dev:https`
 * Spotify stopped accepting plain http for redirects, which is why the local
 * dev server has a certificate.
 */
import express from 'express';

const router = express.Router();

router.get('/callback', (req, res) => {
  // A page carrying an authorization code must never sit in a shared cache,
  // and there is nothing here worth keeping anyway.
  res.set('Cache-Control', 'no-store');
  res.render('callback', {
    pageTitle: 'coming back',
    isCallback: true,
    spotifyClientId: process.env.CLIENT_ID || '',
  });
});

export default router;
