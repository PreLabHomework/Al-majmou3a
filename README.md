# Al Majmoua

A phone-first Pokemon collection tracker built for the Doha market. Photograph a pack, get every card logged with its market price in riyals, and keep a trade shelf you can paste straight into a group chat.

No app store, no backend for the app itself. The collection lives in IndexedDB on the phone.

## Files

| File | What it is |
|---|---|
| `index.html` | Shell, palette, fonts |
| `app.js` | Everything: storage, scanning, catalog lookup, all four views |
| `sw.js` | Service worker, makes it installable and usable offline |
| `manifest.json` | PWA manifest |
| `icon-192.png`, `icon-512.png` | Home screen icons |
| `worker.js` | Cloudflare Worker, keeps the API key off the phone |

## Setup

### 1. Host the app

Drop everything except `worker.js` into a repo and turn on GitHub Pages. It has to be HTTPS or the camera will not open.

### 2. Deploy the Worker

```bash
npm install -g wrangler
wrangler init majmoua-scan
# replace src/index.js with worker.js
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put APP_SECRET      # any long random string
wrangler deploy
```

In `wrangler.toml` add your Pages URL so the browser will talk to it:

```toml
[vars]
ALLOWED_ORIGIN = "https://yourname.github.io"
```

### 3. Get a pokemontcg.io key

Free at pokemontcg.io/developers. Without it you get a much lower daily limit. With it, 1,000 requests a day, and the app caches every lookup for 30 days so you will not come close.

### 4. Fill in Settings

Open the app, go to Settings, paste the Worker URL, the shared secret, and the pokemontcg.io key. Save. Add to home screen.

## How scanning works

**Precision mode** sends one photo of one card. Native camera, so autofocus and full resolution. Use it for hits.

**Bulk mode** takes one photo of cards laid out in a grid. opencv.js runs Canny edge detection, finds every quad with a card-shaped aspect ratio, perspective-warps each one into an upright crop, then identifies them three at a time. It loads opencv.js lazily, so precision mode stays fast.

Bulk works best on a dark plain surface with gaps between cards and no flash glare.

Identification reads the printed collector number and set total off the card. `25` plus `198` is close to a unique key across the whole game, which is why this is accurate without a hosted image index. That resolves against pokemontcg.io for the real card record, image, and TCGplayer market price.

Anything the model was unsure about, or that found no catalog match, gets a gold border on the review screen. Nothing is saved until you tap **Add to collection**.

## Pricing

Prices are TCGplayer market, converted at the riyal peg of 3.64. The peg is fixed, so no FX API and nothing goes stale.

The trade shelf applies a separate **local premium** percentage on top, set in Settings. That is the gap between TCGplayer market and what Doha actually pays. Start at 0, watch what cards actually move for, and tune it.

## Cost

The only per-use cost is the vision call, one per card, on Haiku. Everything else is free tier. Card catalog data is cached locally after first lookup, so re-opening the app costs nothing.

## Not in v1

- Collectr import. Their API is approval-gated and their terms forbid building anything that competes with them, so a live sync is out. A CSV import is the realistic path when you want it.
- Public shareable collection link. That is the first thing that needs a real backend.
- Condition grading from the photo. The condition dropdown is manual for now.
