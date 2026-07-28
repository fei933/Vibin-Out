# vibin' out — the drydown score

Type the way something smells. Get back a three-act playlist.

**Live:** https://vibin-out.vercel.app

## what it is

Vibin' Out turns scent language into a Spotify-backed playlist called a
**Drydown Score** — named for the way a fragrance unfolds over time. Describe
a scent (a candle, a perfume, a room), pick a length and how adventurous the
picks should be, and an LLM reads your description and proposes a three-phase
arc:

- **top notes** — the first impression
- **heart notes** — the body of the scent
- **base notes** — what lingers

Each phase gets real, playable tracks (resolved against Spotify's catalog,
not just imagined by the model), and every track carries a short sensory
justification for why it's there. The result is saved and given a permanent,
shareable URL — `/score/<slug>` — with embedded Spotify players. There's no
login, no account, and no user data beyond the score itself; a "remix" link
lets a visitor regenerate a fresh take on someone else's score without typing
anything.

It's built for coffee-shop and vintage-store owners soundtracking a space,
students soundtracking a study session, and strangers who land on a shared
score link with no context needed.

## stack

- **Node.js 22** (ESM, `"type": "module"`), **Express**
- **Handlebars** (`hbs`) for server-rendered views
- **MongoDB Atlas** — stores score documents and rate-limit counters (two
  plain collections, no ORM models)
- **AI SDK v6** (`ai` + `@ai-sdk/anthropic`) calling **claude-sonnet-5** —
  direct Anthropic API locally, Vercel AI Gateway in production
- **Spotify Web API** (client-credentials only) for track search and embeds
- Deployed on **Vercel** as a serverless function; `vercel.json` rewrites
  every route to `api/index.js`, which re-exports the Express app

## running locally

```bash
npm install
cp .env.example .env   # fill in MONGODB_URI, ANTHROPIC_API_KEY, CLIENT_ID, CLIENT_SECRET
node app.js             # or: npm run dev (node --watch)
```

The app listens on `http://localhost:3000` by default (`PORT` in `.env`).
See `.env.example` for what each variable does — notably: rate limiting
fails *closed*, so score generation refuses outright if Mongo is
unreachable, and exactly one of `ANTHROPIC_API_KEY` / `AI_GATEWAY_API_KEY`
needs to be set (the gateway wins if both are present).

## running tests

```bash
npm test
```

Runs the Node built-in test runner (`node --test`) over `test/*.test.js` —
unit coverage for the generation pipeline, schema validation, the rate
limiter, slug generation, the Spotify track resolver, and server-rendered
view output. Offline, instant, and needs no credentials.

```bash
npx playwright install chromium   # first run only
npm run test:e2e
```

One real end-to-end test: boots the app on an ephemeral port with your `.env`,
drives a real browser from the home page through a live generation to the
score page, and checks the caching headers and the 404 path. It spends one
real LLM call and real Spotify lookups per run (~35s), which is why it is
separate from `npm test`.

```bash
npm run eval            # all ten fixture scents
npm run eval -- 3 7     # just those two
```

The ten-fixture eval — the product go/no-go gate. Also spends real calls, and
writes a readable report with every tracklist for human judgement.

### testing the Spotify export (https + a real login)

The export ("make this playlist yours") uses Authorization Code + PKCE **in the
browser** — the token lives in `sessionStorage` and this server never sees it.
Spotify no longer accepts `http://` redirect URIs, so the ordinary dev server
cannot complete the round trip. Use the HTTPS one:

```bash
npm run dev:https        # → https://localhost:3000
```

On first run it makes a self-signed certificate in `certs/` with `openssl`
(CN=localhost, SAN `DNS:localhost,IP:127.0.0.1`, 825 days — the maximum
browsers accept). **Your browser will warn about it once**; that warning is
correct, and "proceed anyway" is the right answer for a certificate you just
made on your own machine. If you would rather not see it at all, run
`mkcert localhost 127.0.0.1` inside `certs/`, name the output `localhost.key`
and `localhost.crt`, and the script will use those instead. `certs/` is
git-ignored.

Both redirect URIs are already registered in the Spotify dashboard:

```
https://vibin-out.vercel.app/callback
https://localhost:3000/callback
```

Port 3000 matters — `PORT` is respected, but any other port produces an origin
Spotify has never heard of, and it answers a bad `redirect_uri` with its own
error page rather than redirecting back.

Then open a score, press **make this playlist yours**, and log in. What should
happen: Spotify asks for one permission (*create private playlists*), you land
back on the score for a moment, and a private playlist appears in your library
with the score's title, its interpretation and permalink as the description,
and the tracks in drydown order.

**The five-user wall is the expected case, not a bug.** Spotify caps dev-mode
apps at five OAuth users. Anyone not on the dashboard allowlist gets a `403`
(or an `access_denied` redirect), and the page falls straight into **tier 2**:
the same tracklist, copyable as plain text, with a keyless
`open.spotify.com/search/…` link per record. Tier 2 is also what the page
becomes permanently if the Spotify key ever dies, and it renders server-side —
plain anchors, no script, no token. To see it without a Spotify account at all,
unset `CLIENT_ID` and reload a score.

## project structure

```
app.js                        # Express app — exports it; only listens on a port when run directly
api/index.js                  # Vercel serverless entry point (re-exports app.js)
vercel.json                   # rewrites every route to api/index.js
db.js                         # lazy Mongo connection; scores + rate_limits collections
routes/
  index.js                    # GET / — the input form
  score.js                    # POST /api/score, GET /score/:slug
  callback.js                 # GET /callback — the PKCE return hop; renders a page, holds no token
lib/
  validation.js                # request sanitizing/validation
  generateScore.js             # the generation pipeline: LLM -> resolve -> backfill -> assemble
  llm.js                       # provider selection + the one callModel wrapper around the AI SDK
  prompt.js                    # system/user prompt builders (seeded by scent_feature_mapping.json)
  schema.js                    # zod schemas + phase/quota constants
  trackResolver.js             # provider interface for turning {title, artist} into real tracks (Spotify today)
  matchVerification.js         # guards against the model hallucinating a mismatched track
  rateLimiter.js                # fail-closed, Mongo-backed fixed-window limiter
  scoreStore.js                # save/find score documents
  slug.js                      # share-URL slug generation
  viewModel.js                  # stored document -> template data contract
  spotifyExport.js              # keyless search deep links + the plain-text tracklist (tier 2)
  errors.js                    # error codes shared between the pipeline and routes
  scent_feature_mapping.json    # scent taxonomy used to seed the prompt
views/                         # home, score, error, layout (Handlebars)
public/                        # static assets
test/                          # node --test unit tests, one file per lib module (+ render.test.js)
```

## design system

The look is "liner notes from an apothecary" — warm editorial ink-on-paper,
not another dark, glowing AI-generated interface. Paper and ink tones, a
citrine → terracotta → resin accent shift as you scroll from top to base
notes, Fraunces for display type and Newsreader for prose. Full spec and
rationale live in `.impeccable.md`.
