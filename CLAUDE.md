# Vibin' Out — CLAUDE.md

## Project Overview

**Vibin' Out** is a Node.js/Express web app that lets users create Spotify-backed music playlists based on product scents (perfumes, candles, etc.). Users register, browse scented products, and generate/save playlists with music recommendations from the Spotify API.

- **Stack:** Node.js, Express, Handlebars (hbs), MongoDB/Mongoose, Passport.js, Spotify Web API
- **Previous deployment:** Heroku (free tier removed — currently down)
- **Current target:** Vercel (free Hobby plan) — the app has been adapted to run as a serverless function; see Redeployment Plan below

---

## Environment Variables

The app requires these environment variables (via `.env` file locally or platform config vars in production):

| Variable | Description |
|---|---|
| `MONGODB_URI` | MongoDB connection string (e.g. MongoDB Atlas) — also used by the session store |
| `CLIENT_ID` | Spotify API client ID |
| `CLIENT_SECRET` | Spotify API client secret |
| `SESSION_SECRET` | Secret for signing session cookies (falls back to an insecure dev value locally) |
| `PORT` | Server port for local/traditional hosting (defaults to 3000; unused on Vercel) |

---

## Running Locally

```bash
npm install
# Create a .env file with the variables above
node app.js      # or: npx nodemon app.js
```

App listens on `http://localhost:3000` by default.

---

## Project Structure

```
app.js              # Express app — exports the app; listens on a port only when run directly
api/index.js        # Vercel serverless entry point (re-exports the Express app)
vercel.json         # Rewrites all routes to the function; bundles views/ into it
.npmrc              # legacy-peer-deps=true (mongoose-fuzzy-searching declares a mongoose 5 peer dep)
auth.js             # Passport.js local strategy setup
db.js               # Mongoose schemas (User, Song, Product, Playlist) + DB connection
Procfile            # "web: node app.js" — used by Heroku-compatible platforms (Render, etc.)
routes/
  index.js          # / login/register routes
  list.js           # /list — browse/create playlists
  list-item.js      # /list-item — add/remove songs
  product-view.js   # /product-view — product browser
  profile.js        # /profile — user profile + their playlists
  spotify_auth.js   # Dead code — not imported anywhere; routes fetch their own tokens
  scent_feature_mapping.json  # Maps scent tags to Spotify audio features
views/              # Handlebars templates
public/             # Static assets (CSS, client JS)
```

---

## Data Models

- **User** — username, hashed password, favgenres, favscents, playlists[]
- **Song** — name, artists, album, Spotify href/id/cover, popularity
- **Product** — name, photo, category, brand, scent[]
- **Playlist** — name, product ref, songs[], user ref, slug (auto-generated), fuzzy search indexes

---

## Key Routes

| Route | Description |
|---|---|
| `GET /` | Home / login page |
| `GET /register` | Registration page |
| `GET /list` | All public playlists |
| `POST /list/create` | Create a new playlist |
| `GET /list/:slug` | Individual playlist page with Spotify embed |
| `GET /product-view` | Browse products with playlists |
| `GET /profile` | Current user's profile and playlists |

---

## Redeployment Plan

Heroku's free tier was removed in November 2022. Railway and Fly.io no longer offer recurring free tiers either, which leaves **Vercel** (no cold-start spin-down) and **Render** (long-running server, but cold starts) as the free options.

### Option A: Vercel (Implemented — free Hobby plan)

The app has been adapted to run as a Vercel serverless function:

- `app.js` exports the Express app; `app.listen` only runs when launched directly
- `api/index.js` is the serverless entry point; `vercel.json` rewrites all routes to it and bundles `views/**` into the function (static assets in `public/` are served by Vercel's CDN directly)
- Sessions are stored in MongoDB via `connect-mongo` (in-memory sessions don't survive serverless instance recycling)
- `db.js` caps the Mongo connection pool at 10 per instance (Atlas M0 allows 500 total)
- `.npmrc` sets `legacy-peer-deps=true` so `npm install` succeeds despite `mongoose-fuzzy-searching`'s mongoose 5 peer dep

Deploy steps:

1. Sign up at https://vercel.com with GitHub → **Add New Project** → import `fei933/Vibin-Out`
2. Framework preset: **Other** — no build command needed, defaults are fine
3. Under **Environment Variables**, add: `MONGODB_URI`, `CLIENT_ID`, `CLIENT_SECRET`, `SESSION_SECRET` (generate one, e.g. `openssl rand -hex 32`)
4. Deploy — Vercel gives a free `*.vercel.app` domain
5. Add that URL to the Spotify app's settings if OAuth redirect flows are ever enabled

### Option B: Render (fallback — zero serverless caveats)

The app still runs as a classic server (`node app.js`), so Render works unchanged:

1. Sign up at https://render.com → New → **Web Service** → connect the GitHub repo
2. Build command: `npm install` / Start command: `node app.js`
3. Add the same four environment variables in the dashboard
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

## Pre-deployment Checklist

- [x] Move session secret out of `app.js` into `process.env.SESSION_SECRET`
- [x] Store sessions in MongoDB (`connect-mongo`) so logins survive serverless instances
- [x] Add Vercel entry point (`api/index.js`) + `vercel.json`
- [x] Fix Spotify token expiry in `routes/list.js` (fresh client-credentials token per request)
- [ ] Confirm MongoDB Atlas cluster is active and `MONGODB_URI` is correct
- [ ] Confirm Spotify API credentials are valid
- [ ] Set all required env vars in the Vercel project settings
- [ ] Deploy and click through register → login → create playlist → view playlist
- [ ] Update README with new live URL once redeployed

---

## Notes

- `npm start` runs `node app.js`; `npm run dev` runs nodemon for local development
- Node version is pinned to `22.x` in `package.json` `engines` (current LTS; Vercel-supported)
- The `package.json` lists many redundant transitive dependencies explicitly; this is fine but `npm install` may take longer than expected
- Fuzzy search on Playlist/Song models (via `mongoose-fuzzy-searching`) creates extra index fields in MongoDB — expected behavior
- Spotify client-credentials tokens expire after 1 hour — routes must fetch a fresh token per request (as `list.js` and `list-item.js` now do), never at module load
