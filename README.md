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

## project structure

```
app.js                        # Express app — exports it; only listens on a port when run directly
api/index.js                  # Vercel serverless entry point (re-exports app.js)
vercel.json                   # rewrites every route to api/index.js
db.js                         # lazy Mongo connection; scores + rate_limits collections
routes/
  index.js                    # GET / — the input form
  score.js                    # POST /api/score, GET /score/:slug
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
