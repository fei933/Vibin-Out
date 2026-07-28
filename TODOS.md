# TODOS

Captured by /plan-eng-review on 2026-07-27. Context source: the approved design doc
(`~/.gstack/projects/vibin-out/feief-main-design-20260727-133759.md`) — read its
Constraints and Eng Review Amendments sections before picking any of these up.

## 1. v2 feature ladder (in intended order)

**Blocked by:** v1 (Drydown Score) shipping and passing the ten-fixture eval.
**Amended 2026-07-27:** see the design doc's "v2.1 Amendments" section — it reorders and adds to this ladder.

- **Photo input — PROMOTED to v1.5** (was here as distant v2; builder direction 2026-07-27). "Upload a picture of your space" as a second input mode. Same pipeline: a vision call produces the same zod brief schema; downstream unchanged. Hard compression required (design doc v2.1 §5): client-side canvas re-encode (long edge ≤ 1568px, ~1MB cap) + 4MB server backstop; photos never persisted. Crowded market (PhotoVibe, Picture to Playlist) so it's an *addition*, not the identity — scent stays the brand.
- **Spotify export (v1.5, tiered)** — "Export to Spotify" via Authorization Code + PKCE, `playlist-modify-private`, tokens browser-only (design doc v2.1 §4). Works for builder + 4 allowlisted users (dev-mode cap); everyone else gets the copyable-tracklist/deep-link fallback. Must fail invisibly into the fallback — this feature dies first if the key dies (TODO #2).
- **Troi/LB Radio discovery engine** — replaces "LLM proposes tracks" with "LLM emits weighted tags → ListenBrainz LB Radio finds real recordings with popularity control." Makes the Deep Cuts dial real instead of best-effort, and is now the primary path for the "support smaller artists" mission (SoundCloud dropped 2026-07-27: their API requires a paid Artist Pro subscription). MusicBrainz/ListenBrainz is fully open — no gated key. Endpoints are experimental (labs.api.listenbrainz.org) — wrap defensively. This was Approach B in the design doc; the provider interface exists precisely so this slots in.
- **Generic podcast mode** — topic + duration ("30-min commute on X"). Personalized-to-subscription version is dead (Spotify 5-user OAuth wall, documented in the design doc); only build the generic version, and only if users ask.

## 2. Spotify key-death contingency

**What:** fallback plan for the day Spotify revokes/restricts the dev-mode app key.
**Why:** the resolver depends on one client-credentials key; Spotify's 2024–2026 API posture is explicitly hostile to AI playlist tools. Silent key death is the realistic failure (design doc: "accepted risk").
**Actions:**
1. Degraded keyless mode: LLM tracklist renders with "open in Spotify" search deep-links (`https://open.spotify.com/search/<track>%20<artist>`) instead of embeds. Product stays alive with zero Spotify API surface.
2. If the key dies permanently, accelerate the Troi/LB Radio provider (TODO 1) — MusicBrainz-based, no gated key, and MBIDs can resolve to multiple playback surfaces.
   (SoundCloud was the original fallback here — dropped 2026-07-27, their API requires a paid Artist Pro subscription.)
**Where to start:** `lib/trackResolver.js` provider interface; the degraded mode is a second, API-free implementation.

## 3. Scores retention policy

**What:** decide score lifetime — TTL index (e.g. 180 days) vs. keep forever — plus an input-size audit.
**Why:** every generation persists a document forever on a free 512MB Atlas M0. Years of headroom at hobby scale, but share URLs are a promise: expiry = dead links people saved; no expiry = unbounded growth. Decide on purpose.
**When:** revisit at ~1,000 stored scores or first storage alert, whichever comes first.
**Where to start:** `db.js` Score schema — a TTL index is one line if the answer is expiry.
