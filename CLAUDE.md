# Vibin' Out — CLAUDE.md

## Project Overview

**Vibin' Out** (v2, "The Drydown Score") is a no-login, Node.js/Express app that turns typed scent language into a Spotify-backed playlist. A visitor describes a scent, picks a duration and a discovery mode, and an LLM (claude-sonnet-5 via the AI SDK) proposes a three-phase arc — top/heart/base notes — which is resolved against real Spotify tracks, given a per-track sensory justification, saved, and handed a permanent shareable URL at `/score/<slug>`.

- **Stack:** Node.js 22 (ESM), Express, Handlebars (hbs), MongoDB Atlas, AI SDK v6 (`ai` + `@ai-sdk/anthropic`), Spotify Web API (client-credentials only)
- **Deployment:** Vercel (free Hobby plan), serverless function; see Redeployment Plan below
- **v1 (2022 login/products/playlists app) is gone** — this is a clean-slate rewrite; see Design Context below

---

## Environment Variables

The app requires these environment variables (via `.env` file locally, copied from `.env.example`, or platform config vars in production):

| Variable | Description |
|---|---|
| `MONGODB_URI` | MongoDB connection string (Atlas) — stores score documents and rate-limit counters |
| `CLIENT_ID` | Spotify API client ID (client-credentials only, no user OAuth) |
| `CLIENT_SECRET` | Spotify API client secret |
| `ANTHROPIC_API_KEY` | Direct Anthropic API key — production path (set in Vercel env) and local dev path |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway key — optional, wins over `ANTHROPIC_API_KEY` when set. Not the default: the gateway service requires a credit card on file. Without either key, bare OIDC on Vercel (`VERCEL` env var) falls back to the gateway |
| `PORT` | Server port for local hosting (defaults to 3000; unused on Vercel) |

`SESSION_SECRET` is gone — v2 has no auth, no sessions. See `.env.example` for the authoritative, commented list.

---

## Running Locally

```bash
npm install
cp .env.example .env   # fill in MONGODB_URI, ANTHROPIC_API_KEY, CLIENT_ID, CLIENT_SECRET
node app.js             # or: npm run dev (node --watch)
```

App listens on `http://localhost:3000` by default.

---

## Project Structure

```
app.js              # Express app — exports the app; listens on a port only when run directly
api/index.js        # Vercel serverless entry point (re-exports the Express app)
vercel.json         # Rewrites all routes to the function; bundles views/ into it
db.js               # Lazy Mongo connection; scores + rate_limits collections (no ORM models)
routes/
  index.js          # GET / — the input form
  score.js           # POST /api/score (generate + save), GET /score/:slug (render a saved score)
lib/
  validation.js       # Request sanitizing/validation
  generateScore.js    # The pipeline: LLM -> resolve/verify -> one combined backfill -> assemble
  llm.js              # Provider selection (gateway vs direct Anthropic) + the callModel wrapper
  prompt.js           # System/user prompt builders, seeded by scent_feature_mapping.json
  schema.js            # zod schemas + phase/quota constants
  trackResolver.js    # Provider interface turning {title, artist} into real tracks — Spotify today, LB Radio is the planned second implementation (see TODOS.md)
  matchVerification.js # Guards against the model hallucinating a mismatched track
  rateLimiter.js       # Fail-closed, Mongo-backed fixed-window limiter (per-IP + global)
  scoreStore.js        # Save/find immutable score documents
  slug.js               # Share-URL slug generation
  viewModel.js           # Stored document -> template data contract (all derived values computed here, not in templates)
  errors.js              # Error codes shared between the pipeline and routes
  scent_feature_mapping.json  # Scent taxonomy, now a prompt seed (not a Spotify audio-feature map)
views/
  home.hbs, score.hbs, error.hbs, layout.hbs
public/             # Static assets (CSS, client JS)
test/               # node --test unit tests, one file per lib module, plus render.test.js
```

---

## Data Models

Two plain Mongo collections, no Mongoose schemas/models — see `db.js`:

- **`scores`** — immutable documents: `slug` (unique), `input`, `options` (`duration`, `discovery`), `result` (title, interpretation, phases with tracks + sensory justifications, track/runtime counts), `createdAt`. A remix mints a new slug rather than mutating one.
- **`rate_limits`** — fixed-window counters keyed `ip:<ip>:<windowStart>` and `global:<windowStart>`, with a TTL index on `expiresAt`.

---

## Key Routes

| Route | Description |
|---|---|
| `GET /` | Home — the scent input form |
| `POST /api/score` | Validate input, rate-limit, run the generation pipeline, save, return `{slug}` (or a remix of an existing score via `{remix: <slug>}`) |
| `GET /score/:slug` | Render a saved score page with Spotify embeds; cached at the edge forever (scores are immutable) |

---

## Redeployment Plan

Heroku's free tier was removed in November 2022. Railway and Fly.io no longer offer recurring free tiers either, which leaves **Vercel** (no cold-start spin-down) and **Render** (long-running server, but cold starts) as the free options.

### Option A: Vercel (Implemented — free Hobby plan)

The app has been adapted to run as a Vercel serverless function:

- `app.js` exports the Express app; `app.listen` only runs when launched directly
- `api/index.js` is the serverless entry point; `vercel.json` rewrites all routes to it and bundles `views/**` into the function (static assets in `public/` are served by Vercel's CDN directly)
- No sessions — v2 has no auth. Mongo holds only score documents and rate-limit counters.
- `db.js` caps the Mongo connection pool at 10 per instance (Atlas M0 allows 500 total)

Deploy steps:

1. Sign up at https://vercel.com with GitHub → **Add New Project** → import `fei933/Vibin-Out`
2. Framework preset: **Other** — no build command needed, defaults are fine
3. Under **Environment Variables**, add: `MONGODB_URI`, `CLIENT_ID`, `CLIENT_SECRET`, `ANTHROPIC_API_KEY` (production uses the direct Anthropic key; the AI Gateway is only used if `AI_GATEWAY_API_KEY` is set, since the gateway service requires a credit card on file)
4. Deploy — Vercel gives a free `*.vercel.app` domain
5. Add that URL to the Spotify app's settings if OAuth redirect flows are ever enabled

### Option B: Render (fallback — zero serverless caveats)

The app still runs as a classic server (`node app.js`), so Render works unchanged:

1. Sign up at https://render.com → New → **Web Service** → connect the GitHub repo
2. Build command: `npm install` / Start command: `node app.js`
3. Add `MONGODB_URI`, `CLIENT_ID`, `CLIENT_SECRET`, and `ANTHROPIC_API_KEY` in the dashboard (no Vercel OIDC here, so the AI Gateway isn't auto-authenticated — use the direct Anthropic key)
4. Free tier caveat: the service spins down after 15 min of inactivity (~30 s cold start)

### Database: MongoDB Atlas (Free M0 Cluster)

The app uses `process.env.MONGODB_URI`. If the old Atlas cluster is gone:

1. Go to https://cloud.mongodb.com → create a free **M0** cluster
2. Under **Database Access**: create a DB user with password
3. Under **Network Access**: allow `0.0.0.0/0` (or the platform's IP range)
4. Get the connection string: `mongodb+srv://<user>:<pass>@cluster0.xxxxx.mongodb.net/playlistdb`
5. Set this as `MONGODB_URI` in the platform config

### Spotify API

Credentials come from https://developer.spotify.com/dashboard:

1. Log into the Spotify Developer Dashboard
2. Open (or recreate) the app → copy **Client ID** and **Client Secret**
3. Under **Redirect URIs**: add your new deployment URL if using OAuth flows
4. Set `CLIENT_ID` and `CLIENT_SECRET` as environment variables

---

## Deployment Status — Session Log (2026-07-27)

### Done

- All serverless adaptation code is merged to `main` (PRs #1 and #2 plus sync merges); `main` is the deployable branch
- Vercel project is created and connected to this repo with auto-deploy from `main`: **https://vibin-out.vercel.app**
- New Atlas M0 cluster created: `primary-cluster.fiobc3h.mongodb.net` (Atlas project "Vibin Out App"), with DB user `feifeiw933_db_user`
- Env vars added in Vercel (including `MONGODB_URI`)
- Repo metadata in `package.json` fixed to point at `fei933/Vibin-Out` (was the old NYU class repo); `.gitignore` added

### Atlas allowlist — fixed

The earlier `500 FUNCTION_INVOCATION_FAILED` / `SSL alert number 80` issue was a non-allowlisted client IP. `0.0.0.0/0` was added to Atlas Network Access and the site was redeployed; **https://vibin-out.vercel.app returns 200 as of 2026-07-27**. (That deploy is still the old, pre-rewrite app — `main` hasn't picked up the Drydown Score yet.)

`MONGODB_URI` must use this exact shape (Atlas's copy button omits the DB name — it must be in the path or data goes to a DB named `test`; URL-encode special chars in the password):

```
mongodb+srv://feifeiw933_db_user:<url-encoded-password>@primary-cluster.fiobc3h.mongodb.net/playlistdb?retryWrites=true&w=majority&appName=primary-cluster
```

Note: Atlas **Service Accounts are the wrong tool** for app connections (they're for the Atlas Admin API / infrastructure automation). DB user + password in the URI is the correct auth method — the user was advised not to create one.

### Current status — the v2 rewrite, branch `claude/drydown-v1`

The Drydown Score rewrite is complete on `claude/drydown-v1` but not yet merged to `main` (merging auto-deploys). Blocked on:

1. **Working credentials, to run the ten-fixture eval** (design-doc step 3.5 — the go/no-go gate before anything merges):
   - Local `ANTHROPIC_API_KEY` is currently invalid; a valid key, or a working `AI_GATEWAY_API_KEY`, is needed
   - Spotify `CLIENT_ID`/`CLIENT_SECRET` and `MONGODB_URI` also needed locally to run the eval end-to-end
2. **The eval itself passing**
3. **E2E + a deploy smoke test**
4. **Three example scores**, then merge to `main`

### Remaining checklist

- [ ] Get a working `ANTHROPIC_API_KEY` (or `AI_GATEWAY_API_KEY`) and local Spotify/Mongo credentials
- [ ] Run and pass the ten-fixture eval (design-doc step 3.5, go/no-go gate)
- [ ] E2E pass + deploy smoke test
- [ ] Produce three example scores
- [ ] Merge `claude/drydown-v1` to `main` (auto-deploys) and verify https://vibin-out.vercel.app serves the new app

### UI critique — done

The planned impeccable/teach-impeccable UI critique happened; it's what produced the v2 product direction and design system — see Design Context below and `.impeccable.md`.

---

## Notes

- `npm start` runs `node app.js`; `npm run dev` runs `node --watch app.js` for local development
- Node version is pinned to `22.x` in `package.json` `engines` (current LTS; Vercel-supported)
- Tests run via `npm test` (`node --test`) — no separate test runner dependency
- Spotify client-credentials tokens are fetched lazily and cached per instance until they expire, inside `lib/trackResolver.js` (`getToken`/`tokenCache`) — never fetched at module load

---

## Design Context

*(Established 2026-07-27 via impeccable/teach-impeccable + gstack office-hours. Full spec in `.impeccable.md` — that file is the source of truth; this is the summary.)*

- **Product direction (v2, "The Drydown Score"):** no-login scent→playlist generator. Design doc: `~/.gstack/projects/vibin-out/feief-main-design-20260727-133759.md`.
- **Audience:** coffee shop/vintage store owners soundtracking their space; students soundtracking study sessions; strangers arriving on shared `/score/<slug>` URLs.
- **Brand voice:** "an unusually perceptive record-store employee" — lowercase, literate, sensory tasting-note copy. Never hypey, never "AI-powered ✨".
- **Aesthetic:** "liner notes from an apothecary" — warm editorial ink-on-paper. Paper `#F6F1E7`, ink `#211D17`. Phase accents citrine `#D9A441` → terracotta `#B8552F` → resin `#4A3B2A`; links vetiver `#3F5142`. Light theme.
- **Type:** Fraunces (display/wordmark), Newsreader (prose), IBM Plex Mono 13px (track metadata + sensory justifications).
- **Wordmark:** `vibin' out` — lowercase Fraunces, purely typographic, citrine apostrophe as the only color. Clean slate from the 2022 look.
- **Signature interaction:** the drydown scroll (page accents shift citrine→terracotta→resin as you scroll top→heart→base notes); near-zero motion elsewhere; reduced-motion crossfade fallback.
- **Standing bar:** WCAG AA; meaning never carried by color alone.
- **Anti-references:** dark-neon AI aesthetics, glassmorphism, gradient text, Spotify-clone dark UI, card grids, and the 2022 design itself.
