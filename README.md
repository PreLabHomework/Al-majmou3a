# Al Majmoua

**[prelabhomework.github.io/Al-majmou3a](https://prelabhomework.github.io/Al-majmou3a/)**

A phone-first Pokemon collection tracker built for the Doha market. Photograph a pack, get every card logged with its market price in riyals, and keep a trade shelf you can paste straight into a group chat.

No app store, no backend for the app itself. The collection lives in IndexedDB on the phone.

## Features

- **Scan.** Precision mode reads one card per photo. Bulk mode lays several loose cards on a dark surface, finds each one with opencv.js edge detection, and reads them all in one pass. A failed read shows the actual reason (missing Worker URL, bad secret, CORS, an empty photo) and can be retried per-card without rescanning the batch.
- **Catalog matching.** Resolves against pokemontcg.io using the collector number, printed total, name and set, with spelling-variant handling for Collectr-style names ("EX Holon Phantoms" vs "Holon Phantoms"). Anything that can't be matched shows a banner with Retry (transient failures) and Accept (genuinely not in the English catalog, e.g. Japanese-only sets).
- **Sealed and graded product**, priced and stacked separately from raw singles, with their own display treatment — sealed gets a designed panel instead of an empty photo slot, since there's no catalog artwork for a booster box.
- **Collectr CSV import**, with a review screen before anything is written, live TCGplayer repricing for raw singles, and frozen Collectr prices for sealed/graded.
- **Three collection layouts** (large icons, detail rows, small icons for browsing a big collection fast) plus a bottom detail sheet for the full record and controls, reachable from any layout.
- **Portfolio summary**: total value, a composition bar (sealed/singles/graded), the most valuable card, and a value-over-time line built from one snapshot per price refresh or import.
- **Trade shelf** with a local market premium on top of TCGplayer market, and one tap to copy a formatted listing for a group chat.
- **Dark and light themes**, riyals/dollars toggle, 2/3/4 cards per row — all in Settings, with the scanner/secret/pricing fields folded into a collapsed technical section so day-to-day use never touches them.

## Files

| File | What it is |
|---|---|
| `index.html` | Shell, theme variables, fonts |
| `app.js` | Everything: storage, scanning, catalog lookup, all views |
| `sw.js` | Service worker, makes it installable and usable offline |
| `manifest.json` | PWA manifest |
| `icon-192.png`, `icon-512.png` | Home screen icons |
| `worker.js` | Minimal single-provider (Claude) reference Worker. Kept for reference only — see below for the version actually in use. |

## Setup

### 1. Host the app

Drop everything except `worker.js` into a repo and turn on GitHub Pages. It has to be HTTPS or the camera will not open.

### 2. Deploy the scan Worker

The Worker holds the model API key and proxies card photos so the key never touches the phone. Keep it in a **separate folder outside this repo** — its config is secret-adjacent and shouldn't sit in a public repo.

It supports two providers: Gemini (real free tier, no card required) and Claude (no free tier, ~$0.002/scan). Gemini is the default; switch with one line in `wrangler.toml` if it reads cards poorly.

```bash
npm install -g wrangler
wrangler login
wrangler deploy
```

Then set the two secrets it needs (a model API key, plus a random shared secret so only your app can call it):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
wrangler secret put GEMINI_API_KEY      # or ANTHROPIC_API_KEY
wrangler secret put APP_SECRET
wrangler deploy
```

Test it directly with `curl` before touching the phone, so a failure is isolated to the Worker rather than the app, the camera, or the photo:

```bash
curl -X POST https://your-worker.workers.dev \
  -H "Content-Type: application/json" \
  -H "X-App-Secret: YOUR_HEX_STRING" \
  -d '{"model":"x","max_tokens":50,"messages":[{"role":"user","content":"reply with OK"}]}'
```

`ALLOWED_ORIGIN` in `wrangler.toml` must be the Pages *origin* only — `https://yourname.github.io`, lowercase, no trailing slash, no repo path.

### 3. Get a pokemontcg.io key

Free at pokemontcg.io/developers. Without it you get a much lower daily limit. With it, 1,000 requests a day, and the app caches every lookup for 30 days so you will not come close.

### 4. Fill in Settings

Open the app, go to Settings, expand Technical settings, paste the Worker URL, the shared secret, and the pokemontcg.io key. Save. Add to home screen.

## How scanning works

**Precision mode** sends one photo of one card. Native camera, so autofocus and full resolution. Use it for hits.

**Bulk mode** takes one photo of cards laid out in a grid. opencv.js runs Canny edge detection, finds every quad with a card-shaped aspect ratio, perspective-warps each one into an upright crop, then identifies them three at a time. It loads opencv.js lazily, so precision mode stays fast.

Bulk works best on a dark plain surface with gaps between cards and no flash glare. It only works on loose cards — cards still in binder pockets touch each other, so the edge detection sees one shape instead of many.

Identification reads the printed collector number and set total off the card. `25` plus `198` is close to a unique key across the whole game, which is why this is accurate without a hosted image index. That resolves against pokemontcg.io for the real card record, image, and TCGplayer market price.

Anything the model was unsure about gets a gold border on the review screen. A row that couldn't be identified at all shows the actual reason and a per-row Try again, and won't be saved as an empty entry. Nothing is saved until you tap **Add to collection**.

## Pricing

Prices are TCGplayer market, converted at the riyal peg of 3.64. The peg is fixed, so no FX API and nothing goes stale.

The trade shelf applies a separate **local premium** percentage on top, set in Settings. That is the gap between TCGplayer market and what Doha actually pays. Start at 0, watch what cards actually move for, and tune it.

## Cost

The only per-use cost is the vision call, one per card. On Gemini's free tier (the default) that's $0 — 1,500 requests a day, far more than opening packs needs. On Claude it's roughly $0.002/scan and needs credit on the account. Everything else — catalog lookups, price refresh, import, the trade shelf — is free either way, and card catalog data is cached locally after first lookup.

## Known limitations

- Bulk scan works on loose cards only, not binder pages. See above.
- No backup beyond the manual "Save a backup copy" CSV export in Settings — worth doing now and then, since the collection lives only on the device.
- Public shareable collection link. That's the first thing that needs a real backend.
- Condition grading from the photo. The condition dropdown is manual for now.
