# Vibin' Out — CLAUDE.md

## Project Overview

**Vibin' Out** is a Node.js/Express web app that lets users create Spotify-backed music playlists based on product scents (perfumes, candles, etc.). Users register, browse scented products, and generate/save playlists with music recommendations from the Spotify API.

- **Stack:** Node.js, Express, Handlebars (hbs), MongoDB/Mongoose, Passport.js, Spotify Web API
- **Previous deployment:** Heroku (free tier removed — currently down)
- **Live URL (target):** https://vibinout.herokuapp.com/ (needs new hosting)

---

## Environment Variables

The app requires these environment variables (via `.env` file locally or platform config vars in production):

| Variable | Description |
|---|---|
| `MONGODB_URI` | MongoDB connection string (e.g. MongoDB Atlas) |
| `CLIENT_ID` | Spotify API client ID |
| `CLIENT_SECRET` | Spotify API client secret |
| `PORT` | Server port (defaults to 3000 if not set) |

> **Important:** Session secret in `app.js` is currently hardcoded as `'(store this elsewhere!)'`. This should be moved to an env var before production deployment.

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
app.js              # Express app entry point
auth.js             # Passport.js local strategy setup
db.js               # Mongoose schemas (User, Song, Product, Playlist) + DB connection
Procfile            # "web: node app.js" — used by Heroku-compatible platforms
routes/
  index.js          # / login/register routes
  list.js           # /list — browse/create playlists
  list-item.js      # /list-item — add/remove songs
  product-view.js   # /product-view — product browser
  profile.js        # /profile — user profile + their playlists
  spotify_auth.js   # Spotify client credentials token setup
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

Heroku's free tier was removed in November 2022. Below are recommended free/low-cost alternatives.

### Option A: Railway (Recommended — closest to Heroku experience)

1. Sign up at https://railway.app
2. Create a new project → **Deploy from GitHub repo**
3. Railway auto-detects Node.js and runs `npm start` (or respects `Procfile`)
4. Add environment variables under **Variables** tab:
   - `MONGODB_URI`, `CLIENT_ID`, `CLIENT_SECRET`
   - `SESSION_SECRET` (after refactoring the hardcoded secret)
5. Railway provides a free `*.up.railway.app` domain
6. Free tier: $5 credit/month (enough for a small app)

### Option B: Render (Free static + web services)

1. Sign up at https://render.com
2. New → **Web Service** → connect GitHub repo
3. Build command: `npm install`
4. Start command: `node app.js`
5. Add environment variables in the dashboard
6. Free tier: web service spins down after 15 min of inactivity (cold starts)

### Option C: Fly.io

1. Install flyctl: `curl -L https://fly.io/install.sh | sh`
2. `fly launch` in project root (auto-detects Node)
3. Set secrets: `fly secrets set MONGODB_URI=... CLIENT_ID=... CLIENT_SECRET=...`
4. `fly deploy`
5. Free tier: 3 shared-CPU VMs, 256 MB RAM each

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

- [ ] Move session secret out of `app.js` into `process.env.SESSION_SECRET`
- [ ] Confirm MongoDB Atlas cluster is active and `MONGODB_URI` is correct
- [ ] Confirm Spotify API credentials are valid
- [ ] Set all required env vars on the chosen platform
- [ ] Verify `Procfile` (`web: node app.js`) is present for Railway/Heroku-style platforms
- [ ] Test `npm install && node app.js` locally with production env vars before pushing
- [ ] Update README with new live URL once redeployed

---

## Notes

- `nodemon` is used in `package.json`'s `start` script — production platforms should use `node app.js` directly (as in the Procfile), not `nodemon`
- The `package.json` lists many redundant transitive dependencies explicitly; this is fine but `npm install` may take longer than expected
- Fuzzy search on Playlist/Song models (via `mongoose-fuzzy-searching`) creates extra index fields in MongoDB — expected behavior
