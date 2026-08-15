/* Al Majmoua - Pokemon collection tracker for the Doha market
   Local-first PWA. Collection lives in IndexedDB on the device. */

/* ---------------------------------------------------------------- config */

const DEFAULTS = {
  workerUrl: '',        // your Cloudflare Worker endpoint
  workerSecret: '',     // shared secret, must match the Worker
  pokemonKey: '',       // pokemontcg.io free key (optional but recommended)
  qarRate: 3.64,        // riyal is pegged to USD, so this is a constant
  premium: 0,           // local market premium %, applied to trade asks only
  theme: 'dark',
  currency: 'QAR',
  cols: 3,              // cards per row in the large layout
  advanced: false       // hide the technical settings by default
};

const CFG = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('cfg') || '{}'));
const saveCfg = () => localStorage.setItem('cfg', JSON.stringify(CFG));

const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'];

/* Rough TCGplayer convention, not gospel. Adjust once you see what condition
   actually costs in Doha. */
const COND_MULT = { NM: 1, LP: 0.85, MP: 0.7, HP: 0.5, DMG: 0.3 };

/* Sealed product has no condition, and a graded price already prices the
   condition, so neither takes the raw-card multiplier. */
const valueOf = c => {
  const p = c.priceUsd || 0;
  if (c.kind === 'sealed' || c.grade) return p;
  return p * (COND_MULT[c.condition] ?? 1);
};

/* Copies of one printing in one condition share a row. Keyed on the catalog
   id where we have one. Sealed has no id at all, so it keys on product name
   plus set. A row with no id but a real name and number still has a
   trustworthy identity, which is what lets an unmatched import row stack
   instead of duplicating on every re-import. A failed scan has no number, so
   it returns null and always stays its own row. */
const stackKey = c => {
  if (c.kind === 'sealed') return ['sealed', c.name, c.setName].join('|');
  const tail = [c.variant || 'normal', c.condition || 'NM', c.grade || ''].join('|');
  if (c.cardId) return ['id', c.cardId, tail].join('|');
  if (c.name && c.number) return ['raw', c.name, c.setName, c.number, tail].join('|');
  return null;
};

/* How many copies of a row are on the trade shelf. Falls back to the old
   forTrade boolean so rows written before stacking still read correctly. */
const tradeOf = c => c.tradeQty ?? (c.forTrade ? (c.qty || 1) : 0);

/* A row is repriceable only if we can look it up and the stored price is a
   raw-card market price. Graded and sealed prices come from elsewhere and a
   refresh would silently overwrite them with the wrong figure. */
const canRefresh = c => !!c.cardId && !c.grade && c.kind !== 'sealed';

/* ------------------------------------------------------------------- db */

const DB = (() => {
  let db;
  const open = () => new Promise((res, rej) => {
    if (db) return res(db);
    const r = indexedDB.open('majmoua', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('cards'))
        d.createObjectStore('cards', { keyPath: 'id', autoIncrement: true });
      if (!d.objectStoreNames.contains('catalog'))
        d.createObjectStore('catalog', { keyPath: 'key' });
    };
    r.onsuccess = () => { db = r.result; res(db); };
    r.onerror = () => rej(r.error);
  });

  const tx = async (store, mode) => (await open()).transaction(store, mode).objectStore(store);
  const wrap = req => new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });

  return {
    all:    async ()   => wrap((await tx('cards', 'readonly')).getAll()),
    put:    async (c)  => wrap((await tx('cards', 'readwrite')).put(c)),
    del:    async (id) => wrap((await tx('cards', 'readwrite')).delete(id)),
    clear:  async ()   => wrap((await tx('cards', 'readwrite')).clear()),
    cacheGet: async (k) => wrap((await tx('catalog', 'readonly')).get(k)),
    cacheSet: async (k, v) => wrap((await tx('catalog', 'readwrite')).put({ key: k, value: v, at: Date.now() }))
  };
})();

/* -------------------------------------------------------------- helpers */

const $  = (s, r = document) => r.querySelector(s);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const inUsd = n => '$' + (Number(n) || 0).toFixed(2);
const inQar = n => Math.round((Number(n) || 0) * CFG.qarRate).toLocaleString() + ' QAR';
/* money() is whichever currency is selected, alt() is the other one. Stored
   values are always USD, so switching is display only and nothing migrates. */
const money = n => CFG.currency === 'USD' ? inUsd(n) : inQar(n);
const alt   = n => CFG.currency === 'USD' ? inQar(n) : inUsd(n);

function applyTheme() {
  document.documentElement.dataset.theme = CFG.theme === 'light' ? 'light' : 'dark';
  const meta = $('#themeColor');
  if (meta) meta.setAttribute('content', CFG.theme === 'light' ? '#FAF7F5' : '#1A0D12');
}

let toastTimer;
function toast(msg, tone = 'ok') {
  let t = $('#toast');
  if (!t) { t = el('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.className = 'fixed left-4 right-4 bottom-24 z-50 px-4 py-3 rounded text-sm text-center fade-up ' +
    (tone === 'bad' ? 'bg-maroon text-bone' : 'bg-bone text-ink');
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3200);
}

function flash() {
  const s = $('#shutter');
  s.classList.remove('fire');
  void s.offsetWidth;
  s.classList.add('fire');
}

/* Downscale a File to a JPEG data URL, long edge capped. */
function fileToCanvas(file, maxEdge = 1600) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const c = el('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      res(c);
    };
    img.onerror = () => rej(new Error('Could not read that image'));
    img.src = URL.createObjectURL(file);
  });
}

const canvasToB64 = (c, q = 0.82) => c.toDataURL('image/jpeg', q).split(',')[1];

/* Artwork for a row, or a lettered placeholder for sealed product and
   anything that never resolved to a catalog image. */
function thumb(c, cls) {
  if (c.image) {
    // Catalog artwork is a portrait card scan and fills the frame. A camera
    // capture is whatever shape the phone took, so it must not be cropped.
    const fit = c.image.startsWith('data:') ? 'object-contain' : 'object-cover';
    return `<img src="${esc(c.image)}" alt="${esc(c.name)}" class="${cls} ${fit}" loading="lazy">`;
  }
  // No catalog image exists for sealed product, so an empty photo frame is
  // just a hole. Give it a designed panel that carries the name instead.
  if (c.kind === 'sealed') {
    const words = String(c.name || '').split(/\s+/);
    const short = words.slice(0, 6).join(' ') + (words.length > 6 ? '\u2026' : '');
    return `<div class="${cls} bg-maroonD flex flex-col justify-between p-2 overflow-hidden">
      <span class="text-[8px] uppercase tracking-[0.18em] opacity-70">Sealed</span>
      <span class="font-display text-[11px] leading-tight break-words">${esc(short)}</span>
      <span class="h-1 w-full bg-maroon rounded"></span>
    </div>`;
  }
  return `<div class="${cls} bg-ink3 flex items-center justify-center text-muted text-xl">?</div>`;
}

/* Cards are portrait. A landscape photo usually means the phone was held
   sideways, so a failed read is worth one more attempt rotated. */
function rotateCanvas(src, deg = 90) {
  const out = el('canvas');
  out.width = src.height;
  out.height = src.width;
  const ctx = out.getContext('2d');
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate(deg * Math.PI / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return out;
}

/* ---------------------------------------------------------------- vision */

const VISION_PROMPT = `You are reading a single Pokemon trading card from a photo.
Return ONLY a JSON object, no prose, no markdown fences:
{"name":"","number":"","printedTotal":"","setHint":"","language":"EN","variant":"normal","confidence":0.0}

Rules:
- "name" is the Pokemon or card name exactly as printed, including suffixes like ex, V, VMAX, VSTAR, GX.
- "number" is the collector number printed at the bottom, digits only, no leading zeros. For a card marked 025/198 return "25". For alternate numbering like TG12 or SV045 return it as printed.
- "printedTotal" is the number after the slash. If there is no slash, return "".
- "setHint" is the set name if you can read it, otherwise "".
- "language" is "EN" for English, "JP" for Japanese, or the two-letter code you see.
- "variant" is "reverse" if the non-artwork part of the card is foiled, "holo" if only the artwork is foiled, otherwise "normal".
- "confidence" is 0 to 1, how sure you are of name and number together.
If the image is not a trading card, return {"name":"","number":"","printedTotal":"","setHint":"","language":"","variant":"normal","confidence":0}`;

async function identify(b64) {
  if (!CFG.workerUrl) throw new Error('No scanner endpoint set. Add the Worker URL in Settings.');
  const r = await fetch(CFG.workerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-App-Secret': CFG.workerSecret },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
          { type: 'text', text: VISION_PROMPT }
        ]
      }]
    })
  });
  if (!r.ok) {
    const detail = r.status === 401 ? 'Scanner rejected the shared secret (401). Check Settings.'
      : r.status === 403 ? 'Scanner refused the request (403). Check ALLOWED_ORIGIN on the Worker.'
      : `Scanner returned ${r.status}.`;
    throw new Error(detail);
  }
  const data = await r.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const clean = text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); }
  catch { throw new Error('Scanner replied but not in the expected format.'); }
}

/* --------------------------------------------------------------- catalog */

const PTCG = 'https://api.pokemontcg.io/v2/cards';

/* pokemontcg.io's keyless tier throws intermittent 500s and 502s under
   sequential load. Without retries a single transient failure leaves a row
   permanently unmatched, because enrichImport swallows the error and moves on.
   Retry 5xx, 429 and network faults; a 4xx is a bad query and will never
   succeed, so fail fast on those. */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, headers, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, { headers });
      if (r.ok) return r;
      if (r.status >= 400 && r.status < 500 && r.status !== 429)
        throw new Error('Card database returned ' + r.status);
      last = new Error('Card database returned ' + r.status);
    } catch (e) {
      last = e;
      if (/returned 4\d\d/.test(e.message) && !/429/.test(e.message)) throw e;
    }
    if (i < attempts - 1) await sleep(400 * Math.pow(3, i) + Math.random() * 300);
  }
  throw last;
}

/* Catalog data is static, so a hit caches for 30 days. An empty result caches
   for one day only: it may mean the card genuinely is not indexed, but it may
   also mean a set was added since, and a short window lets a later retry pick
   it up without making every lookup expensive. Prices are not static, so a
   refresh passes fresh=true to skip the read and overwrite the entry. */
async function ptcgQuery(q, fresh = false) {
  const key = 'q:' + q;
  if (!fresh) {
    const hit = await DB.cacheGet(key);
    const ttl = (hit && hit.value && hit.value.length) ? 30 * 864e5 : 864e5;
    if (hit && Date.now() - hit.at < ttl) return hit.value;
  }

  const headers = CFG.pokemonKey ? { 'X-Api-Key': CFG.pokemonKey } : {};
  const r = await fetchWithRetry(`${PTCG}?q=${encodeURIComponent(q)}&pageSize=12`, headers);
  const out = (await r.json()).data || [];
  await DB.cacheSet(key, out);
  return out;
}

/* Collectr and pokemontcg.io name the same things differently. Collectr
   prefixes the ex-era sets with "EX " and qualifies card names in
   parentheses, so "Gyarados (Delta Species)" in "EX Holon Phantoms" is
   "Gyarados \u03b4" in "Holon Phantoms" and every exact-match query misses.
   Generate the plausible spellings and try each. */
function setVariants(set) {
  const out = [];
  const push = x => { x = (x || '').trim(); if (x && !out.includes(x)) out.push(x); };
  push(set);
  push(String(set || '').replace(/^EX\s+/i, ''));   // EX Holon Phantoms -> Holon Phantoms
  push(String(set || '').replace(/^SV:\s*/i, ''));   // SV: 151 -> 151
  push(String(set || '').split(':')[0]);             // Generations: Radiant Collection -> Generations
  return out;
}

/* Compare set names ignoring case, accents and punctuation, so Collectr's
   "Pokemon Go" and the catalog's "Pok\u00e9mon GO" are recognised as the same set. */
const slug = x => String(x || '').toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');

function setMatches(wantSet, gotSet) {
  if (!wantSet) return true;              // nothing to check against
  const g = slug(gotSet);
  if (!g) return false;
  return setVariants(wantSet).some(v => {
    const w = slug(v);
    if (!w) return false;
    if (w === g) return true;
    return w.length >= 5 && g.length >= 5 && (w.includes(g) || g.includes(w));
  });
}

function nameVariants(name) {
  const out = [];
  const push = x => { x = (x || '').trim(); if (x && !out.includes(x)) out.push(x); };
  push(name);
  push(String(name || '').replace(/\s*\([^)]*\)/g, ''));   // drop "(Delta Species)"
  return out;
}

/* Prefer an exact name match, then a partial, then whatever is left. */
function bestHit(hits, name, setName) {
  if (hits.length < 2 || !name) return hits[0];
  const want = name.toLowerCase();
  const bare = want.replace(/\s*\([^)]*\)/g, '').trim();
  const wantSets = setVariants(setName).map(x => x.toLowerCase());
  const score = c => {
    const n = (c.name || '').toLowerCase();
    const st = (c.set?.name || '').toLowerCase();
    let v = n === want ? 0 : n === bare ? 1 : n.includes(bare) ? 2 : 4;
    if (wantSets.includes(st)) v -= 1;
    return v;
  };
  return [...hits].sort((a, b) => score(a) - score(b))[0];
}

/* Resolve a card reading to a real catalog card. Collector number plus
   printed total is close to a unique key, so try that first. Set name comes
   from an import row and is a strong tiebreak when the number is bare. */
async function resolve(read, strict = false) {
  const rawNum = String(read.number || '').trim();
  const num = /^\d+$/.test(rawNum) ? (rawNum.replace(/^0+/, '') || '0') : rawNum;
  const total = String(read.printedTotal || '').replace(/^0+/, '');
  const names = nameVariants(read.name || '');
  const sets = setVariants(read.setName || read.setHint || '');
  // A promo code like SWSH260 is distinctive enough to search alone. A plain
  // number like 25 is not: it would return hundreds of cards.
  const codeLike = num && !/^\d+$/.test(num);

  const tries = [];
  if (num && total) tries.push(`number:"${num}" set.printedTotal:${total}`);
  if (num) for (const n of names) tries.push(`number:"${num}" name:"${n}"`);
  if (num) for (const st of sets) tries.push(`number:"${num}" set.name:"${st}"`);
  if (codeLike) tries.push(`number:"${num}"`);
  for (const n of names) for (const st of sets) tries.push(`name:"${n}" set.name:"${st}"`);
  for (const n of names) tries.push(`name:"${n}"`);

  for (const q of tries) {
    const hits = await ptcgQuery(q);
    if (!hits.length) continue;
    const pick = bestHit(hits, read.name || '', read.setName || read.setHint || '');
    if (!pick) continue;
    // On an import or retry the number came off a real record, so a match
    // whose number disagrees is the wrong card. This matters most on the
    // expensive singles, where a confident wrong match beats no match only in
    // appearance.
    if (strict) {
      // The number came off a real record, so a match that disagrees is the
      // wrong card. The set has to agree too, otherwise a bare name search
      // can return a same-numbered card from an unrelated set and hand an
      // expensive row a confident wrong price.
      if (num && String(pick.number || '').replace(/^0+/, '') !== num) continue;
      if (!setMatches(read.setName || '', pick.set?.name)) continue;
    }
    return pick;
  }
  return null;
}

/* Pick the price that matches the printing we think we have. */
function priceOf(card, variant) {
  const p = card?.tcgplayer?.prices;
  if (!p) return null;
  const orders = {
    reverse: ['reverseHolofoil', 'holofoil', 'normal', '1stEditionHolofoil'],
    holo:    ['holofoil', 'reverseHolofoil', 'normal', '1stEditionHolofoil'],
    firstEd: ['1stEditionHolofoil', '1stEditionNormal', 'holofoil', 'normal'],
    normal:  ['normal', 'holofoil', 'reverseHolofoil', '1stEditionHolofoil']
  };
  for (const k of (orders[variant] || orders.normal)) {
    const v = p[k];
    if (v && (v.market || v.mid)) return { usd: v.market || v.mid, printing: k };
  }
  const first = Object.entries(p)[0];
  return first && (first[1].market || first[1].mid)
    ? { usd: first[1].market || first[1].mid, printing: first[0] } : null;
}

/* ---------------------------------------------------------------- cropper */

let cvReady = null;
function loadOpenCV() {
  if (cvReady) return cvReady;
  cvReady = new Promise((res, rej) => {
    const s = el('script');
    s.src = 'https://docs.opencv.org/4.x/opencv.js';
    s.async = true;
    s.onload = () => {
      if (window.cv && cv.Mat) return res();
      cv['onRuntimeInitialized'] = () => res();
    };
    s.onerror = () => rej(new Error('Could not load the cropper. Check your connection.'));
    document.head.appendChild(s);
  });
  return cvReady;
}

function orderCorners(pts) {
  const bySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byDiff = [...pts].sort((a, b) => (a.y - a.x) - (b.y - b.x));
  return [bySum[0], byDiff[0], bySum[3], byDiff[3]]; // tl, tr, br, bl
}

/* Find every card-shaped quad in a photo of loose cards and warp each to an
   upright crop. This needs gaps between cards: touching cards merge into one
   contour under the dilate and nothing is found. Cards in binder pockets
   always touch, which is why binder pages do not work here and belong in the
   CSV import instead. */
async function cropCards(canvas) {
  await loadOpenCV();
  const W = 420, H = 588; // 63x88 at 6.6px/mm
  const src = cv.imread(canvas);
  const gray = new cv.Mat(), blur = new cv.Mat(), edge = new cv.Mat();
  const contours = new cv.MatVector(), hier = new cv.Mat();
  const out = [];

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    cv.Canny(blur, edge, 35, 110);
    const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
    cv.dilate(edge, edge, k);
    k.delete();
    cv.findContours(edge, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const imgArea = src.cols * src.rows;

    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area < imgArea * 0.012 || area > imgArea * 0.75) { c.delete(); continue; }

      const approx = new cv.Mat();
      cv.approxPolyDP(c, approx, 0.02 * cv.arcLength(c, true), true);
      if (approx.rows !== 4) { approx.delete(); c.delete(); continue; }

      const pts = [];
      for (let j = 0; j < 4; j++) pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
      const [tl, tr, br, bl] = orderCorners(pts);

      const wTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
      const hLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y);
      const ratio = Math.min(wTop, hLeft) / Math.max(wTop, hLeft);
      if (ratio < 0.60 || ratio > 0.84) { approx.delete(); c.delete(); continue; }

      // Portrait target, so rotate the source corner order if the card sits landscape.
      const ordered = wTop > hLeft ? [tr, br, bl, tl] : [tl, tr, br, bl];
      const from = cv.matFromArray(4, 1, cv.CV_32FC2, ordered.flatMap(p => [p.x, p.y]));
      const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);
      const M = cv.getPerspectiveTransform(from, to);
      const dst = new cv.Mat();
      cv.warpPerspective(src, dst, M, new cv.Size(W, H));

      const cnv = el('canvas');
      cnv.width = W; cnv.height = H;
      cv.imshow(cnv, dst);
      out.push({ canvas: cnv, y: tl.y, x: tl.x });

      from.delete(); to.delete(); M.delete(); dst.delete(); approx.delete(); c.delete();
    }
  } finally {
    src.delete(); gray.delete(); blur.delete(); edge.delete(); contours.delete(); hier.delete();
  }

  // Reading order: top to bottom, then left to right.
  out.sort((a, b) => (Math.abs(a.y - b.y) > H * 0.4 ? a.y - b.y : a.x - b.x));
  return out.map(o => o.canvas);
}

/* ------------------------------------------------------------ scan flow */

/* One read attempt, retried rotated when the photo is landscape. */
async function readCard(canvas) {
  let read = await identify(canvasToB64(canvas));
  if (!read.name && !read.number && canvas.width > canvas.height) {
    read = await identify(canvasToB64(rotateCanvas(canvas, 90)));
    read.rotated = true;
  }
  return read;
}

/* Turn one crop into a review row. Kept separate from the batch loop so a
   single row can be retried from the review screen without rescanning. */
async function readOne(canvas) {
  const preview = canvas.toDataURL('image/jpeg', 0.6);
  try {
    const read = await readCard(canvas);
    if (!read.name && !read.number) {
      return {
        kind: 'single', name: 'Not recognised', image: preview, canvas,
        matched: false, priceUsd: 0, confidence: 0,
        error: 'The scanner read the photo but found no card in it.'
      };
    }
    const card = await resolve(read);
    const price = card ? priceOf(card, read.variant) : null;
    return {
      kind: 'single',
      cardId: card?.id || null,
      name: card?.name || read.name || 'Unknown card',
      setName: card?.set?.name || read.setHint || '',
      number: card?.number || read.number || '',
      printedTotal: card?.set?.printedTotal || read.printedTotal || '',
      rarity: card?.rarity || '',
      image: card?.images?.small || preview,
      canvas,
      variant: read.variant || 'normal',
      printing: price?.printing || '',
      priceUsd: price?.usd || 0,
      priceSource: 'tcgplayer',
      confidence: read.confidence ?? 0,
      matched: !!card
    };
  } catch (e) {
    // Keep the real message. "Could not read" on its own gives no way to tell
    // a missing Worker from a bad secret from an unclear photo.
    return {
      kind: 'single', name: 'Could not read', image: preview, canvas,
      matched: false, priceUsd: 0, error: e.message
    };
  }
}

async function processCrops(canvases, statusEl) {
  const results = [];
  let done = 0;
  const step = () => { statusEl.textContent = `Identifying ${++done} of ${canvases.length}`; };

  const queue = canvases.map((c, i) => async () => {
    results[i] = await readOne(c);
    step();
  });

  // Three at a time keeps it fast without hammering the endpoint.
  const lanes = Array.from({ length: 3 }, async () => {
    while (queue.length) await queue.shift()();
  });
  await Promise.all(lanes);
  return results.filter(Boolean);
}

/* ----------------------------------------------------------- csv import */

/* Proper CSV reader: Collectr quotes any field containing a comma, and prices
   above a thousand always do. */
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const csvObjects = text => {
  const rows = parseCSV(text).filter(r => r.some(f => f !== ''));
  if (!rows.length) return [];
  const head = rows[0].map(h => h.replace(/^\ufeff/, '').trim());
  return rows.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
};

const num = s => {
  const n = parseFloat(String(s ?? '').replace(/[",\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/* Collectr calls the foil treatment "Variance" and mixes two ideas into it:
   the actual foil type, and the print era. Only the foil type drives which
   TCGplayer price applies, so era is kept separately for display. */
const VARIANCE = {
  'Normal': { variant: 'normal' },
  'Holofoil': { variant: 'holo' },
  'Reverse Holofoil': { variant: 'reverse' },
  '1st Edition': { variant: 'firstEd', era: '1st Edition' },
  'Unlimited': { variant: 'normal', era: 'Unlimited' }
};

/* Collector numbers arrive in six shapes: 046/189, 081, 40, SWSH260, RC5,
   XY40. Only the slashed form carries a printed total. */
function splitNumber(raw) {
  const s = String(raw || '').trim();
  if (!s) return { number: '', printedTotal: '' };
  const slash = s.split('/');
  const number = slash[0].trim();
  return {
    number: /^\d+$/.test(number) ? (number.replace(/^0+/, '') || '0') : number,
    printedTotal: slash[1] ? slash[1].trim().replace(/^0+/, '') : ''
  };
}

const CONDITION_MAP = {
  'Near Mint': 'NM', 'Lightly Played': 'LP', 'Moderately Played': 'MP',
  'Heavily Played': 'HP', 'Damaged': 'DMG'
};

/* Turn a Collectr export into rows this app understands, and say plainly what
   was dropped. A watchlist entry is a card he does not own; importing it would
   inflate the collection by its full market price. */
function readCollectr(text) {
  const raw = csvObjects(text);
  const kept = [], skipped = [];

  // Collectr stamps the export date into the price header, so the column name
  // differs on every export. Find it once by prefix.
  const priceCol = Object.keys(raw[0] || {}).find(k => k.startsWith('Market Price')) || '';

  for (const r of raw) {
    const name = r['Product Name'] || '';
    if (!name) continue;

    if (r['Watchlist'] === 'true') { skipped.push({ name, why: 'watchlist, not owned' }); continue; }
    const qty = Math.round(num(r['Quantity']));
    if (qty < 1) { skipped.push({ name, why: 'no quantity' }); continue; }

    const { number, printedTotal } = splitNumber(r['Card Number']);
    const sealed = !number;
    const v = VARIANCE[r['Variance']] || { variant: 'normal' };
    const gradeRaw = r['Grade'] || '';
    const grade = (gradeRaw && gradeRaw !== 'Ungraded') ? gradeRaw : '';
    const date = Date.parse(r['Date Added'] || '') || Date.now();

    kept.push({
      kind: sealed ? 'sealed' : 'single',
      cardId: null,
      name,
      setName: r['Set'] || '',
      number, printedTotal,
      image: '',
      variant: v.variant,
      era: v.era || '',
      rarity: r['Rarity'] || '',
      grade,
      condition: CONDITION_MAP[r['Card Condition']] || 'NM',
      qty,
      tradeQty: 0,
      priceUsd: num(r[priceCol]),
      costUsd: num(r['Average Cost Paid']),
      notes: r['Notes'] || '',
      // Sealed and graded prices come from Collectr and stay frozen. Raw
      // singles get repriced from TCGplayer during the import itself.
      priceSource: (sealed || grade) ? 'collectr' : 'tcgplayer',
      addedAt: date,
      priceUpdated: date
    });
  }
  return { kept, skipped };
}

/* Resolve every single against the catalog for artwork and a stable id.
   Graded rows are included so they get an id and can stack, but their price
   is left alone: a graded figure is not a raw market price. Sealed passes
   through untouched, since the catalog holds no sealed product. */
async function enrichImport(rows, onProgress) {
  const targets = rows.filter(r => r.kind === 'single');
  let done = 0, matched = 0, failed = 0;
  for (const r of targets) {
    try {
      const card = await resolve(r, true);
      if (card) {
        matched++;
        r.cardId = card.id;
        r.name = card.name || r.name;
        r.setName = card.set?.name || r.setName;
        r.number = card.number || r.number;
        r.printedTotal = card.set?.printedTotal || r.printedTotal;
        r.image = card.images?.small || '';
        r.rarity = card.rarity || r.rarity;
        if (!r.grade) {
          const p = priceOf(card, r.variant);
          if (p) { r.priceUsd = p.usd; r.printing = p.printing; r.priceUpdated = Date.now(); }
        }
      }
    } catch {
      // The lookup itself broke rather than coming back empty. Keep the
      // Collectr figure and count it, so the finish message can tell the
      // difference between "not in the catalog" and "try again".
      failed++;
    }
    onProgress(++done, targets.length);
  }
  return { matched, failed, total: targets.length };
}

/* Merge rows into the collection, stacking onto anything that matches. */
async function commitRows(rows) {
  const existing = await DB.all();
  const byKey = new Map();
  for (const r of existing) { const k = stackKey(r); if (k) byKey.set(k, r); }
  let added = 0, stacked = 0;

  for (const r of rows) {
    const key = stackKey(r);
    const hit = key ? byKey.get(key) : null;
    if (hit) {
      hit.qty = (hit.qty || 1) + (r.qty || 1);
      if (r.priceUsd) { hit.priceUsd = r.priceUsd; hit.priceUpdated = Date.now(); }
      await DB.put(hit);
      stacked++;
    } else {
      const rec = { ...r };
      delete rec.matched; delete rec.confidence; delete rec.error;
      delete rec.canvas; delete rec.existingQty;   // not serialisable / not state
      rec.id = await DB.put(rec);
      const k = stackKey(rec);
      if (k) byKey.set(k, rec);
      added++;
    }
  }
  return { added, stacked };
}

/* ------------------------------------------------------------ snapshots */

/* A collection is worth watching over time, not just today. Every price
   refresh records one point, at most one a day, so the value line builds
   itself without anyone having to remember to log anything. */
const SNAPS_KEY = 'snaps';
const loadSnaps = () => { try { return JSON.parse(localStorage.getItem(SNAPS_KEY) || '[]'); } catch { return []; } };

function recordSnapshot(totalUsd) {
  const snaps = loadSnaps();
  const day = new Date().toISOString().slice(0, 10);
  const last = snaps[snaps.length - 1];
  if (last && last.day === day) last.usd = totalUsd;
  else snaps.push({ day, at: Date.now(), usd: totalUsd });
  while (snaps.length > 400) snaps.shift();
  try { localStorage.setItem(SNAPS_KEY, JSON.stringify(snaps)); } catch {}
}

/* Simple value line. No axes: the shape and the endpoints are the message. */
function sparkline(snaps) {
  if (snaps.length < 2) return '';
  const vals = snaps.map(s => s.usd);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = (hi - lo) || 1;
  const pts = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * 100;
    const y = 22 - ((v - lo) / span) * 20;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const rising = vals[vals.length - 1] >= vals[0];
  return `<svg viewBox="0 0 100 24" preserveAspectRatio="none" class="w-full h-8" aria-hidden="true">
    <polyline points="${pts}" fill="none" stroke="rgb(var(--c-${rising ? 'gold' : 'maroon'}))" stroke-width="1.5"
      vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

function changeLine(snaps) {
  if (snaps.length < 2) return '';
  const first = snaps[0].usd, last = snaps[snaps.length - 1].usd;
  if (!first) return '';
  const diff = last - first;
  const pct = (diff / first) * 100;
  const up = diff >= 0;
  const since = new Date(snaps[0].at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `<p class="text-[11px] tabular ${up ? 'text-gold' : 'text-maroon'}">
    ${up ? '+' : '\u2212'}${money(Math.abs(diff))} (${up ? '+' : '\u2212'}${Math.abs(pct).toFixed(1)}%) since ${esc(since)}</p>`;
}

/* Portfolio summary. What is it worth, what is it made of, what is the best
   thing in it. The three questions anyone asks about a collection. */
function summaryCard(cards) {
  const box = el('div', 'bg-ink2 rounded p-3 mb-4 fade-up');
  const val = g => g.reduce((s, c) => s + valueOf(c) * (c.qty || 1), 0);
  const sealed = cards.filter(c => c.kind === 'sealed');
  const graded = cards.filter(c => c.grade);
  const raw = cards.filter(c => c.kind !== 'sealed' && !c.grade);
  const total = val(cards) || 1;
  const copies = cards.reduce((s, c) => s + (c.qty || 1), 0);
  const top = [...cards].sort((a, b) => valueOf(b) - valueOf(a))[0];
  const snaps = loadSnaps();

  const seg = (g, cls, label) => {
    const pct = val(g) / total * 100;
    return pct < 0.5 ? '' : `<div class="${cls} h-full" style="width:${pct.toFixed(1)}%" title="${label} ${pct.toFixed(0)}%"></div>`;
  };

  box.innerHTML = `
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="text-[10px] uppercase tracking-[0.16em] text-muted">Portfolio</p>
        <p class="font-display text-2xl text-gold tabular leading-tight">${money(val(cards))}</p>
        <p class="text-[11px] text-muted tabular">${alt(val(cards))} \u00b7 ${copies} items</p>
        ${changeLine(snaps)}
      </div>
      ${snaps.length > 1 ? `<div class="w-24 shrink-0">${sparkline(snaps)}</div>` : ''}
    </div>

    <div class="flex h-1.5 rounded overflow-hidden mt-3 bg-ink3">
      ${seg(sealed, 'bg-maroon', 'Sealed')}${seg(raw, 'bg-gold', 'Singles')}${seg(graded, 'bg-sand', 'Graded')}
    </div>
    <div class="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[10px] text-muted">
      ${sealed.length ? `<span><span class="inline-block w-2 h-2 rounded-sm bg-maroon align-middle"></span> Sealed ${money(val(sealed))}</span>` : ''}
      ${raw.length ? `<span><span class="inline-block w-2 h-2 rounded-sm bg-gold align-middle"></span> Singles ${money(val(raw))}</span>` : ''}
      ${graded.length ? `<span><span class="inline-block w-2 h-2 rounded-sm bg-sand align-middle"></span> Graded ${money(val(graded))}</span>` : ''}
    </div>

    ${top ? `<div class="flex items-center gap-2 mt-3 pt-3 border-t border-maroonD">
      <span class="text-[10px] uppercase tracking-[0.16em] text-muted shrink-0">Best card</span>
      <span class="text-[12px] truncate flex-1">${esc(top.name)}</span>
      <span class="text-gold font-display tabular shrink-0">${money(valueOf(top))}</span>
    </div>` : ''}`;

  if (top) box.querySelector('.border-t')?.addEventListener('click', () => openSheet(top));
  return box;
}

/* ----------------------------------------------------------------- views */

let TAB = 'collection';
let PENDING = [];
let IMPORT = null;
let FILTER = { q: '', kind: 'all', sort: 'updated', set: '', rarity: '', view: 'large' };
let SHEET = null;   // card open in the detail sheet, if any

/* Large: three across, artwork forward. List: full details in a row.
   Mini: six or eight across, artwork only, for scanning a big collection by
   eye. Tapping a card in any of them opens the detail sheet. */
const VIEWS = [
  ['large', '\u25a6', 'Large icons'],
  ['list',  '\u25a4', 'Details'],
  ['mini',  '\u25a9', 'Small icons']
];

async function render() {
  const v = $('#view');
  v.innerHTML = '';
  document.querySelectorAll('.tab').forEach(b => {
    const on = b.dataset.tab === TAB;
    b.className = 'tab py-3 flex flex-col items-center gap-1 ' + (on ? 'text-gold' : 'text-muted');
  });
  if (TAB === 'collection') await viewCollection(v);
  if (TAB === 'scan') await viewScan(v);
  if (TAB === 'trade') await viewTrade(v);
  if (TAB === 'settings') await viewSettings(v);
  await updateTotals();
  if (SHEET && TAB !== 'collection') { SHEET = null; renderSheet(); }
}

async function updateTotals() {
  const cards = await DB.all();
  const total = cards.reduce((s, c) => s + valueOf(c) * (c.qty || 1), 0);
  $('#totalValue').textContent = money(total);
  $('#totalUsd').textContent = alt(total);
}

/* Tapping the headline value flips the currency. Faster than going to
   Settings for something you want to check both ways. */
function wireHeader() {
  const box = $('#totalBox');
  if (!box) return;
  box.onclick = () => {
    CFG.currency = CFG.currency === 'USD' ? 'QAR' : 'USD';
    saveCfg();
    render();
  };
}

/* ---- collection ---- */

function applyFilter(cards) {
  const q = FILTER.q.trim().toLowerCase();
  let out = cards.filter(c => {
    if (FILTER.kind === 'singles' && c.kind === 'sealed') return false;
    if (FILTER.kind === 'sealed' && c.kind !== 'sealed') return false;
    if (FILTER.kind === 'trade' && tradeOf(c) < 1) return false;
    if (FILTER.set && (c.setName || '') !== FILTER.set) return false;
    if (FILTER.rarity && (c.rarity || '') !== FILTER.rarity) return false;
    if (!q) return true;
    const hay = [c.name, c.setName, c.number, c.printedTotal, c.rarity,
                 c.grade, c.variant, c.era].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });
  const sorts = {
    updated: (a, b) => (b.priceUpdated || b.addedAt || 0) - (a.priceUpdated || a.addedAt || 0),
    added:   (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
    value:   (a, b) => valueOf(b) * (b.qty || 1) - valueOf(a) * (a.qty || 1),
    name:    (a, b) => a.name.localeCompare(b.name)
  };
  return out.sort(sorts[FILTER.sort] || sorts.updated);
}

async function viewCollection(v) {
  const cards = await DB.all();

  if (!cards.length) {
    v.appendChild(el('div', 'text-center py-20 fade-up', `
      <p class="font-display text-xl mb-2">Nothing logged yet</p>
      <p class="text-sm text-muted mb-6 max-w-xs mx-auto">Open a pack, take a photo, and every card lands here with its market price. Already tracking elsewhere? Import a CSV from Settings.</p>
      <button id="goScan" class="bg-maroon px-6 py-3 rounded font-display tracking-wide">Scan your first card</button>`));
    $('#goScan').onclick = () => go('scan');
    return;
  }

  // Filter options come from what he actually owns, so no empty choices.
  const sets = [...new Set(cards.map(c => c.setName).filter(Boolean))].sort();
  const rarities = [...new Set(cards.map(c => c.rarity).filter(Boolean))].sort();
  v.appendChild(summaryCard(cards));

  const KINDS = [['all', 'All'], ['singles', 'Singles'], ['sealed', 'Sealed'], ['trade', 'Trade']];

  const controls = el('div', 'mb-3 fade-up');
  controls.innerHTML = `
    <div class="flex gap-2 mb-2.5">
      <input id="q" value="${esc(FILTER.q)}" placeholder="Name, number, rarity, grade" enterkeyhint="search"
        class="flex-1 min-w-0 bg-ink2 border border-maroonD rounded px-3 py-2.5 text-sm">
      <div class="shrink-0 flex rounded border border-muted/30 overflow-hidden">
        ${VIEWS.map(([v, icon, label]) => `<button data-view="${v}" title="${label}" aria-label="${label}"
          class="vw w-9 text-base leading-none py-2 ${FILTER.view === v ? 'bg-maroon text-bone' : 'text-muted'}">${icon}</button>`).join('')}
      </div>
    </div>

    <div class="flex gap-1.5 mb-2.5">
      ${KINDS.map(([k, label]) => `<button data-kind="${k}"
        class="kind flex-1 text-[10px] uppercase tracking-[0.1em] py-1.5 rounded border ${FILTER.kind === k ? 'bg-maroon border-maroon' : 'border-muted/30 text-muted'}">${label}</button>`).join('')}
    </div>

    <div class="grid grid-cols-2 gap-2 mb-2.5">
      <select id="fset" class="bg-ink2 text-xs rounded px-2 py-1.5 border border-muted/30 min-w-0">
        <option value="">All sets</option>
        ${sets.map(x => `<option value="${esc(x)}"${FILTER.set === x ? ' selected' : ''}>${esc(x)}</option>`).join('')}
      </select>
      <select id="frar" class="bg-ink2 text-xs rounded px-2 py-1.5 border border-muted/30 min-w-0">
        <option value="">All rarities</option>
        ${rarities.map(x => `<option value="${esc(x)}"${FILTER.rarity === x ? ' selected' : ''}>${esc(x)}</option>`).join('')}
      </select>
    </div>

    <div class="flex items-center gap-2">
      <select id="sort" class="bg-ink2 text-xs rounded px-2 py-1.5 border border-muted/30 flex-1 min-w-0">
        <option value="updated"${FILTER.sort === 'updated' ? ' selected' : ''}>Recently updated</option>
        <option value="added"${FILTER.sort === 'added' ? ' selected' : ''}>Recently added</option>
        <option value="value"${FILTER.sort === 'value' ? ' selected' : ''}>Highest value</option>
        <option value="name"${FILTER.sort === 'name' ? ' selected' : ''}>Name</option>
      </select>
      <button id="refresh" class="shrink-0 text-xs uppercase tracking-[0.14em] text-gold border border-gold/40 px-3 py-1.5 rounded">Refresh</button>
    </div>`;
  v.appendChild(controls);

  const unmatched = cards.filter(c => c.kind !== 'sealed' && !c.cardId && !c.noMatch);
  if (unmatched.length) {
    const banner = el('div', 'border border-gold/50 rounded p-3 mt-3 flex items-center gap-3');
    banner.innerHTML = `
      <div class="flex-1 min-w-0">
        <p class="text-[11px] uppercase tracking-[0.14em] text-gold">${unmatched.length} without a catalog match</p>
        <p class="text-[11px] text-muted">No artwork and the price cannot auto-update.</p>
      </div>
      <div class="shrink-0 flex flex-col gap-1.5">
        <button id="retry" class="text-xs uppercase tracking-[0.14em] text-gold border border-gold/40 px-3 py-1.5 rounded">Retry</button>
        <button id="accept" class="text-[10px] uppercase tracking-[0.14em] text-muted border border-muted/30 px-3 py-1 rounded">Accept</button>
      </div>`;
    v.appendChild(banner);
    $('#retry', banner).onclick = e => retryUnmatched(e.currentTarget, unmatched);
    // Some cards genuinely are not in the English catalog, Japanese-only sets
    // being the usual reason. Accepting stops the banner nagging about them
    // forever; they keep their imported price and simply never auto-update.
    $('#accept', banner).onclick = async () => {
      if (!confirm(`Accept ${unmatched.length} card${unmatched.length === 1 ? '' : 's'} as not in the catalog? They keep their current price and stop showing here.`)) return;
      for (const c of unmatched) { c.noMatch = true; await DB.put(c); }
      toast('Accepted. Prices stay as they are.');
      render();
    };
  }

  const count = el('p', 'text-sm text-muted my-3');
  const list = el('div');
  v.append(count, list);

  const paint = () => {
    const shown = applyFilter(cards);
    const copies = shown.reduce((s, c) => s + (c.qty || 1), 0);
    const worth = shown.reduce((s, c) => s + valueOf(c) * (c.qty || 1), 0);
    count.textContent = shown.length
      ? `${copies} item${copies === 1 ? '' : 's'} \u00b7 ${money(worth)}`
      : 'Nothing matches that.';
    const colClass = { 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4' }[CFG.cols] || 'grid-cols-3';
    list.className = FILTER.view === 'large' ? `grid ${colClass} gap-2`
      : FILTER.view === 'mini' ? 'grid grid-cols-6 sm:grid-cols-8 gap-1'
      : '';
    list.innerHTML = '';
    if (!VIEWS.some(([v]) => v === FILTER.view)) FILTER.view = 'large';
    const build = FILTER.view === 'large' ? gridTile : FILTER.view === 'mini' ? miniTile : listRow;
    shown.forEach(c => list.appendChild(build(c)));
  };
  paint();

  // Only the list repaints on a keystroke, so the input keeps focus and the
  // caret does not jump.
  let debounce;
  $('#q', controls).oninput = e => {
    FILTER.q = e.target.value;
    clearTimeout(debounce);
    debounce = setTimeout(paint, 200);
  };
  $('#sort', controls).onchange = e => { FILTER.sort = e.target.value; paint(); };
  $('#fset', controls).onchange = e => { FILTER.set = e.target.value; paint(); };
  $('#frar', controls).onchange = e => { FILTER.rarity = e.target.value; paint(); };
  controls.querySelectorAll('.vw').forEach(b => b.onclick = () => { FILTER.view = b.dataset.view; render(); });
  controls.querySelectorAll('.kind').forEach(b => b.onclick = () => { FILTER.kind = b.dataset.kind; render(); });
  $('#refresh', controls).onclick = e => refreshPrices(e.currentTarget);
}

/* Shared bits between the two layouts. */
const stateLabel = c => c.grade || (c.kind === 'sealed' ? 'Sealed' : c.condition || 'NM');
const subLabel = c => c.kind === 'sealed'
  ? (c.setName || 'Sealed')
  : `${c.setName || ''} ${c.number || ''}${c.printedTotal ? '/' + c.printedTotal : ''}`.trim();

async function setTradeQty(c, n) {
  c.tradeQty = Math.max(0, Math.min(c.qty || 1, n));
  delete c.forTrade;               // superseded by tradeQty
  await DB.put(c);
  render();
  if (SHEET && SHEET.id === c.id) { SHEET = c; renderSheet(); }
}

/* Detail sheet. Reachable from every layout, which is what lets the mini
   view work at all: the artwork alone carries no controls, so tapping has to
   lead somewhere with them. Also the one place a card can be removed
   regardless of which density is active. */
function openSheet(c) {
  SHEET = c;
  history.pushState({ tab: TAB, sheet: 1 }, '', '#' + TAB);
  renderSheet();
}

function closeSheet() {
  SHEET = null;
  renderSheet();
}

function renderSheet() {
  let host = $('#sheet');
  if (!SHEET) { if (host) host.remove(); return; }
  if (!host) { host = el('div'); host.id = 'sheet'; document.body.appendChild(host); }

  const c = SHEET;
  const qty = c.qty || 1;
  const tq = tradeOf(c);
  const sealed = c.kind === 'sealed';
  const frozen = c.priceSource === 'collectr';

  const facts = [
    ['Set', c.setName],
    [sealed ? '' : 'Number', sealed ? '' : `${c.number || '?'}${c.printedTotal ? '/' + c.printedTotal : ''}`],
    ['Rarity', c.rarity],
    [sealed ? 'Type' : 'Condition', sealed ? 'Sealed product' : (c.grade || c.condition || 'NM')],
    ['Printing', c.printing || (sealed ? '' : c.variant)],
    ['Edition', c.era],
    ['Copies', qty > 1 ? String(qty) : ''],
    ['Price source', frozen ? 'Collectr, frozen' : c.cardId ? 'TCGplayer market' : 'Imported, no catalog match']
  ].filter(([k, v]) => k && v);

  host.innerHTML = `
    <div class="fixed inset-0 z-[60] bg-ink/80" id="backdrop"></div>
    <div class="fixed inset-x-0 bottom-0 z-[61] bg-ink2 rounded-t-xl max-h-[85vh] overflow-y-auto safe-b fade-up">
      <div class="serrate"></div>
      <div class="p-4">
        <div class="flex gap-4">
          <div class="w-24 shrink-0 card-ratio rounded overflow-hidden bg-ink">${thumb(c, 'w-full h-full')}</div>
          <div class="flex-1 min-w-0">
            <p class="font-display text-lg leading-tight">${esc(c.name)}</p>
            <p class="text-gold font-display text-2xl tabular mt-1">${money(valueOf(c))}</p>
            <p class="text-[11px] text-muted tabular">${alt(valueOf(c))}${qty > 1 ? ` each \u00b7 ${money(valueOf(c) * qty)} total` : ''}</p>
          </div>
        </div>

        <div class="mt-4 space-y-1.5">
          ${facts.map(([k, v]) => `
            <div class="flex justify-between gap-4 text-[12px]">
              <span class="text-muted shrink-0">${esc(k)}</span>
              <span class="text-right truncate">${esc(v)}</span>
            </div>`).join('')}
        </div>

        <div class="serrate serrate-thin my-4"></div>

        <p class="text-[10px] uppercase tracking-[0.16em] text-muted mb-2">On the trade shelf</p>
        <div class="flex items-center gap-3 mb-4">
          <button id="sh-minus" class="w-10 py-2 rounded border ${tq ? 'border-maroon' : 'border-muted/30 text-muted'}">\u2212</button>
          <span class="flex-1 text-center font-display tabular ${tq ? 'text-gold' : 'text-muted'}">${tq} of ${qty}</span>
          <button id="sh-plus" class="w-10 py-2 rounded border ${tq < qty ? 'border-maroon' : 'border-muted/30 text-muted'}">+</button>
        </div>

        <div class="flex gap-2">
          <button id="sh-close" class="flex-1 py-3 rounded border border-muted/30 text-muted text-sm">Close</button>
          <button id="sh-del" class="flex-1 py-3 rounded border border-maroon text-maroon text-sm">Remove${qty > 1 ? ` all ${qty}` : ''}</button>
        </div>
      </div>
    </div>`;

  const back = () => { if (history.state?.sheet) history.back(); else closeSheet(); };
  $('#backdrop', host).onclick = back;
  $('#sh-close', host).onclick = back;
  $('#sh-minus', host).onclick = async () => { await setTradeQty(c, tq - 1); if (SHEET) renderSheet(); };
  $('#sh-plus', host).onclick  = async () => { await setTradeQty(c, tq + 1); if (SHEET) renderSheet(); };
  $('#sh-del', host).onclick = async () => {
    const msg = qty > 1 ? `Remove all ${qty} copies of ${c.name}?` : `Remove ${c.name} from the collection?`;
    if (!confirm(msg)) return;
    await DB.del(c.id);
    SHEET = null;
    if (history.state?.sheet) history.back(); else { renderSheet(); render(); }
    toast('Removed');
  };
}

async function removeRow(c) {
  const qty = c.qty || 1;
  const msg = qty > 1
    ? `Remove all ${qty} copies of ${c.name}?`
    : `Remove ${c.name} from the collection?`;
  if (confirm(msg)) { await DB.del(c.id); render(); }
}

/* Grid is for browsing: three across, artwork forward, one tap to flag a
   trade. Editing quantities and deleting live in the list layout. */
function gridTile(c) {
  const qty = c.qty || 1;
  const tq = tradeOf(c);
  const t = el('div', `bg-ink2 rounded overflow-hidden fade-up active:opacity-80 ${qty > 1 ? 'stacked' : ''}`);
  t.innerHTML = `
    <div class="relative card-ratio bg-ink3">
      ${thumb(c, 'w-full h-full')}
      ${qty > 1 ? `<span class="absolute top-1 left-1 bg-maroon text-bone text-[10px] font-display px-1.5 py-0.5 rounded tabular">${qty} copies</span>` : ''}
      ${tq ? `<span class="absolute bottom-1 left-1 right-1 bg-gold text-center text-[9px] uppercase tracking-wider py-0.5 rounded" style="color:rgb(var(--c-ink))">${tq > 1 ? tq + ' for trade' : 'For trade'}</span>` : ''}
    </div>
    <div class="p-1.5">
      <p class="text-[11px] leading-tight truncate">${esc(c.name)}</p>
      <p class="text-gold font-display text-sm tabular leading-tight">${money(valueOf(c))}</p>
    </div>`;
  t.onclick = () => openSheet(c);
  return t;
}

/* Six or eight to a row, artwork only. Everything else lives in the sheet. */
function miniTile(c) {
  const qty = c.qty || 1;
  const tq = tradeOf(c);
  const t = el('div', `relative card-ratio rounded overflow-hidden bg-ink3 fade-up active:opacity-70 ${qty > 1 ? 'stacked' : ''}`);
  t.innerHTML = `
    ${thumb(c, 'w-full h-full')}
    ${qty > 1 ? `<span class="absolute top-0 left-0 bg-maroon text-bone text-[9px] px-1 rounded-br tabular">${qty}</span>` : ''}
    ${tq ? `<span class="absolute bottom-0 inset-x-0 h-1.5 bg-gold"></span>` : ''}`;
  t.title = `${c.name} \u00b7 ${money(valueOf(c))}`;
  t.onclick = () => openSheet(c);
  return t;
}

/* List is for managing: full identity, trade stepper, delete. */
function listRow(c) {
  const qty = c.qty || 1;
  const tq = tradeOf(c);
  const frozen = c.priceSource === 'collectr';
  const row = el('div', 'flex gap-3 bg-ink2 rounded p-2.5 mb-2 fade-up');
  row.innerHTML = `
    ${thumb(c, 'w-12 rounded card-ratio shrink-0')}
    <div class="flex-1 min-w-0">
      <p class="font-display text-sm truncate">${esc(c.name)}</p>
      <p class="text-[11px] text-muted truncate">${esc(subLabel(c))}</p>
      <p class="text-[10px] text-muted truncate">${esc(stateLabel(c))}${c.rarity ? ' \u00b7 ' + esc(c.rarity) : ''}${qty > 1 ? ' \u00b7 x' + qty : ''}</p>
      ${frozen ? `<p class="text-[10px] text-sand/60">Collectr price, not auto-updated</p>` : ''}
      <div class="flex items-center gap-1.5 mt-1.5">
        ${qty > 1 ? `
          <button class="tminus w-6 text-sm leading-none py-1 rounded border ${tq ? 'border-maroon' : 'border-muted/30 text-muted'}">\u2212</button>
          <span class="text-[10px] uppercase tracking-[0.1em] tabular ${tq ? 'text-gold' : 'text-muted'} w-16 text-center">${tq ? tq + '/' + qty : 'Keep'}</span>
          <button class="tplus w-6 text-sm leading-none py-1 rounded border ${tq < qty ? 'border-maroon' : 'border-muted/30 text-muted'}">+</button>
        ` : `
          <button class="trade text-[10px] uppercase tracking-[0.1em] px-2 py-1 rounded border ${tq ? 'bg-maroon border-maroon' : 'border-muted/30 text-muted'}">${tq ? 'For trade' : 'Keep'}</button>
        `}
        <button class="del ml-auto text-[10px] px-2 py-1 rounded border border-muted/30 text-muted">\u2715</button>
      </div>
    </div>
    <div class="text-right shrink-0">
      <p class="text-gold font-display tabular">${money(valueOf(c))}</p>
      <p class="text-[10px] text-muted tabular">${alt(valueOf(c))}</p>
    </div>`;

  const q = sel => row.querySelector(sel);
  if (qty > 1) {
    q('.tminus').onclick = () => setTradeQty(c, tq - 1);
    q('.tplus').onclick = () => setTradeQty(c, tq + 1);
  } else {
    q('.trade').onclick = () => setTradeQty(c, tq ? 0 : 1);
  }
  q('.del').onclick = () => removeRow(c);
  row.querySelector('img, div.bg-maroonD\\/40')?.addEventListener('click', () => openSheet(c));
  return row;
}

/* Re-run the catalog lookup for rows that never resolved, so a run of
   transient API failures does not mean clearing and importing all over again.
   Passes fresh=true, because an empty result may already be cached. */
async function retryUnmatched(btn, rows) {
  btn.disabled = true;
  let fixed = 0, n = 0;
  for (const c of rows) {
    btn.textContent = `${++n}/${rows.length}`;
    try {
      const card = await resolve({
        name: c.name, number: c.number, printedTotal: c.printedTotal, setName: c.setName
      }, true);
      if (!card) continue;
      c.cardId = card.id;
      delete c.noMatch;
      c.image = card.images?.small || c.image;
      c.rarity = card.rarity || c.rarity;
      c.printedTotal = card.set?.printedTotal || c.printedTotal;
      if (!c.grade) {
        const p = priceOf(card, c.variant);
        if (p) { c.priceUsd = p.usd; c.printing = p.printing; c.priceUpdated = Date.now(); }
      }
      await DB.put(c);
      fixed++;
    } catch { /* still down, leave it for the next attempt */ }
  }
  btn.disabled = false;
  toast(fixed ? `${fixed} matched` : 'Still no match. Try again later.');
  render();
}

async function refreshPrices(btn) {
  const all = await DB.all();
  const cards = all.filter(canRefresh);
  const held = all.length - cards.length;
  if (!cards.length) {
    toast('Nothing to refresh. Sealed and graded prices stay as imported.');
    return;
  }
  btn.disabled = true;
  let n = 0;
  for (const c of cards) {
    btn.textContent = `Updating ${++n}/${cards.length}`;
    try {
      const hits = await ptcgQuery(`id:"${c.cardId}"`, true);
      const p = priceOf(hits[0], c.variant);
      if (p) { c.priceUsd = p.usd; c.printing = p.printing; c.priceUpdated = Date.now(); await DB.put(c); }
    } catch { /* keep the old price rather than blanking it */ }
  }
  btn.disabled = false;
  const fresh = await DB.all();
  recordSnapshot(fresh.reduce((s, c) => s + valueOf(c) * (c.qty || 1), 0));
  toast(held ? `${cards.length} updated, ${held} held` : `${cards.length} updated`);
  render();
}

/* ---- scan ---- */

async function viewScan(v) {
  if (PENDING.length) return viewReview(v);

  v.innerHTML = `
    <div class="fade-up">
      <p class="text-sm text-muted mb-6">The camera is for new cards. Anything already in a binder should come in through Import in Settings.</p>

      <label class="block bg-maroon rounded p-5 mb-3 active:opacity-90">
        <input type="file" accept="image/*" capture="environment" class="hidden" id="single">
        <div class="flex items-center gap-4">
          <span class="text-3xl">\u25ce</span>
          <div>
            <p class="font-display text-lg leading-tight">Precision</p>
            <p class="text-xs opacity-80">One card, one photo. Highest accuracy.</p>
          </div>
        </div>
      </label>

      <label class="block bg-ink2 border border-maroonD rounded p-5 active:opacity-90">
        <input type="file" accept="image/*" capture="environment" class="hidden" id="bulk">
        <div class="flex items-center gap-4">
          <span class="text-3xl">\u25a6</span>
          <div>
            <p class="font-display text-lg leading-tight">Bulk grid</p>
            <p class="text-xs text-muted">Loose cards spread out, one photo, all at once.</p>
          </div>
        </div>
      </label>

      <div class="serrate serrate-thin my-6"></div>

      <p class="text-xs uppercase tracking-[0.16em] text-muted mb-2">For bulk shots</p>
      <ul class="text-sm text-muted space-y-1.5 list-none">
        <li>Loose cards only. Cards still in binder pockets cannot be separated.</li>
        <li>Dark, plain surface. A closed binder cover works well.</li>
        <li>Leave a finger's gap between cards. Touching cards read as one shape.</li>
        <li>Even light, no flash glare across the foils.</li>
      </ul>

      <p id="status" class="text-center text-sm text-gold mt-8"></p>
    </div>`;

  $('#single').onchange = e => runScan(e.target.files[0], false);
  $('#bulk').onchange = e => runScan(e.target.files[0], true);
}

async function runScan(file, isBulk) {
  if (!file) return;
  const status = $('#status');
  flash();
  try {
    status.textContent = 'Reading photo';
    const canvas = await fileToCanvas(file, isBulk ? 2000 : 1400);

    let crops;
    if (isBulk) {
      status.textContent = 'Finding cards';
      crops = await cropCards(canvas);
      if (!crops.length) {
        status.textContent = '';
        toast('No cards found. Loose cards on a dark surface, with gaps.', 'bad');
        return;
      }
      status.textContent = `Found ${crops.length}`;
    } else {
      crops = [canvas];
    }

    const found = await processCrops(crops, status);

    // Tell him what he already owns while the card is still in his hand,
    // rather than in a toast after saving.
    const owned = await DB.all();
    const byKey = new Map(owned.map(r => [stackKey(r), r]));
    found.forEach(c => {
      const hit = c.cardId ? byKey.get(stackKey({ ...c, condition: c.condition || 'NM' })) : null;
      c.existingQty = hit ? (hit.qty || 1) : 0;
    });

    PENDING = found;
    status.textContent = '';
    render();
  } catch (e) {
    status.textContent = '';
    toast(e.message, 'bad');
  }
}

/* ---- review ---- */

function viewReview(v) {
  const good = PENDING.filter(c => c.matched);
  const bad = PENDING.filter(c => !c.matched);
  const total = PENDING.reduce((s, c) => s + valueOf(c), 0);

  const head = el('div', 'mb-4 fade-up');
  head.innerHTML = `
    <p class="font-display text-xl">${PENDING.length} card${PENDING.length > 1 ? 's' : ''} read</p>
    <p class="text-gold font-display text-2xl tabular">${money(total)}</p>
    <p class="text-xs text-muted">${alt(total)} at market.${bad.length ? ` ${bad.length} could not be identified.` : ' Check anything flagged before saving.'}</p>`;
  v.appendChild(head);

  PENDING.forEach((c, i) => {
    const low = c.matched && (c.confidence ?? 1) < 0.75;
    const failed = !c.matched;
    const row = el('div', `flex gap-3 bg-ink2 rounded p-3 mb-2.5 fade-up ${failed ? 'border border-maroon' : low ? 'border border-gold/50' : ''}`);
    row.innerHTML = `
      ${thumb(c, 'w-14 rounded card-ratio shrink-0 bg-ink')}
      <div class="flex-1 min-w-0">
        <p class="font-display text-sm truncate">${esc(c.name)}</p>
        ${failed ? '' : `<p class="text-[11px] text-muted truncate">${esc(c.setName)} ${esc(c.number)}${c.printedTotal ? '/' + esc(c.printedTotal) : ''} \u00b7 ${esc(c.printing || c.variant)}</p>`}
        ${c.error ? `<p class="text-[11px] text-sand/80 mt-0.5 break-words">${esc(c.error)}</p>` : ''}
        ${low ? `<p class="text-[11px] text-gold mt-0.5">Low confidence, worth a look</p>` : ''}
        ${c.existingQty ? `<p class="text-[11px] text-sand/70 mt-0.5">Already have ${c.existingQty}</p>` : ''}
        <div class="flex items-center gap-2 mt-2">
          ${failed ? `
            <button class="again text-[11px] uppercase tracking-[0.12em] border border-gold/40 text-gold px-2 py-1 rounded">Try again</button>
          ` : `
            <select class="cond bg-ink text-xs rounded px-2 py-1 border border-muted/30">
              ${CONDITIONS.map(k => `<option ${k === (c.condition || 'NM') ? 'selected' : ''}>${k}</option>`).join('')}
            </select>
            <span class="text-gold text-sm font-display tabular">${money(valueOf(c))}</span>
          `}
          <button class="drop ml-auto text-xs text-muted px-2">Remove</button>
        </div>
      </div>`;

    const cond = row.querySelector('.cond');
    if (cond) cond.onchange = e => { PENDING[i].condition = e.target.value; render(); };

    const again = row.querySelector('.again');
    if (again) again.onclick = async () => {
      if (!c.canvas) { toast('No image kept for that one. Rescan it.', 'bad'); return; }
      again.disabled = true;
      again.textContent = 'Reading';
      const fresh = await readOne(c.canvas);
      PENDING[i] = fresh;
      render();
    };

    row.querySelector('.drop').onclick = () => { PENDING.splice(i, 1); render(); };
    v.appendChild(row);
  });

  const actions = el('div', 'flex gap-3 mt-6');
  const label = bad.length && good.length
    ? `Add ${good.length} identified`
    : bad.length ? 'Nothing to add' : 'Add to collection';
  const save = el('button', `flex-1 py-3 rounded font-display tracking-wide ${good.length ? 'bg-maroon' : 'bg-ink2 text-muted'}`, label);
  const cancel = el('button', 'px-5 py-3 rounded border border-muted/30 text-muted text-sm', 'Discard');

  save.onclick = async () => {
    // An unidentified row would save as a nameless entry worth nothing and
    // then sit in the collection forever, so only identified cards go in.
    if (!good.length) { toast('None of these were identified.', 'bad'); return; }
    const rows = good.map(c => ({
      kind: 'single',
      cardId: c.cardId, name: c.name, setName: c.setName, number: c.number,
      printedTotal: c.printedTotal, image: c.image, variant: c.variant,
      rarity: c.rarity || '',
      printing: c.printing, priceUsd: c.priceUsd, priceSource: 'tcgplayer',
      condition: c.condition || 'NM', grade: '', era: '',
      qty: 1, tradeQty: 0, addedAt: Date.now(), priceUpdated: Date.now()
    }));
    const { stacked } = await commitRows(rows);
    toast(`${rows.length} added${stacked ? `, ${stacked} stacked` : ''}${bad.length ? `, ${bad.length} skipped` : ''}`);
    PENDING = [];
    go('collection');
  };
  cancel.onclick = () => { PENDING = []; render(); };
  actions.append(save, cancel);
  v.appendChild(actions);
}

/* ---- trade ---- */

function askPrice(c) {
  return valueOf(c) * CFG.qarRate * (1 + (Number(CFG.premium) || 0) / 100);
}

async function viewTrade(v) {
  const cards = (await DB.all()).filter(c => tradeOf(c) > 0).sort((a, b) => valueOf(b) - valueOf(a));
  const copies = cards.reduce((s, c) => s + tradeOf(c), 0);

  if (!cards.length) {
    v.innerHTML = `<div class="text-center py-20 fade-up">
      <p class="font-display text-xl mb-2">Trade shelf is empty</p>
      <p class="text-sm text-muted max-w-xs mx-auto">Mark a card "For trade" in your collection and it shows up here, ready to post.</p></div>`;
    return;
  }

  const total = cards.reduce((s, c) => s + askPrice(c) * tradeOf(c), 0);
  const head = el('div', 'mb-4 fade-up');
  head.innerHTML = `
    <p class="font-display text-xl">${copies} on the shelf${copies !== cards.length ? ` \u00b7 ${cards.length} listing${cards.length === 1 ? '' : 's'}` : ''}</p>
    <p class="text-gold font-display text-2xl tabular">${Math.round(total).toLocaleString()} QAR</p>
    <p class="text-xs text-muted">Asks include your ${CFG.premium || 0}% local premium.</p>`;
  v.appendChild(head);

  const post = el('button', 'w-full bg-maroon py-3 rounded font-display tracking-wide mb-5', 'Copy list for WhatsApp');
  post.onclick = async () => {
    const lines = cards.map(c => {
      const n = tradeOf(c);
      const id = c.kind === 'sealed'
        ? ''
        : ` ${c.number}${c.printedTotal ? '/' + c.printedTotal : ''}`;
      const foil = c.variant === 'reverse' ? ' (RH)' : c.variant === 'holo' ? ' (Holo)' : '';
      const state = c.grade ? ` [${c.grade}]` : c.kind === 'sealed' ? ' [Sealed]' : ` [${c.condition || 'NM'}]`;
      return `${c.name}${id}${foil}${state}${n > 1 ? ` x${n}` : ''}` +
        ` - ${Math.round(askPrice(c)).toLocaleString()} QAR${n > 1 ? ' each' : ''}`;
    });
    const text = `FOR TRADE / SALE - Doha\n\n${lines.join('\n')}\n\nPrices track TCGplayer market. Open to trades.`;
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied. Paste it in the group chat.');
    } catch {
      prompt('Copy this:', text);
    }
  };
  v.appendChild(post);

  cards.forEach(c => {
    const row = el('div', 'flex items-center gap-3 bg-ink2 rounded p-3 mb-2 fade-up');
    const state = c.grade || (c.kind === 'sealed' ? 'Sealed' : c.condition || 'NM');
    row.innerHTML = `
      ${thumb(c, 'w-11 rounded card-ratio shrink-0')}
      <div class="flex-1 min-w-0">
        <p class="font-display text-sm truncate">${esc(c.name)}</p>
        <p class="text-[11px] text-muted truncate">${esc(c.setName)} \u00b7 ${esc(state)}${tradeOf(c) > 1 ? ' \u00b7 x' + tradeOf(c) : ''}</p>
      </div>
      <div class="text-right shrink-0">
        <p class="text-gold font-display tabular">${Math.round(askPrice(c)).toLocaleString()}</p>
        <p class="text-[10px] text-muted">QAR${tradeOf(c) > 1 ? ' ea' : ''}</p>
      </div>`;
    v.appendChild(row);
  });
}

/* ---- settings ---- */

async function viewSettings(v) {
  if (IMPORT) return viewImport(v);

  const seg = (id, opts, current) => `
    <div class="flex rounded border border-maroonD overflow-hidden">
      ${opts.map(([val, label]) => `<button data-${id}="${val}"
        class="${id} flex-1 text-[11px] uppercase tracking-[0.12em] py-2 ${current == val ? 'bg-maroon text-bone' : 'text-muted'}">${label}</button>`).join('')}
    </div>`;

  v.innerHTML = `
    <div class="fade-up space-y-5">

      <p class="text-xs uppercase tracking-[0.16em] text-muted">Appearance</p>
      ${seg('theme', [['dark', 'Dark'], ['light', 'Light']], CFG.theme)}
      ${seg('curr', [['QAR', 'Riyals'], ['USD', 'Dollars']], CFG.currency)}
      <div>
        <p class="text-[11px] text-muted mb-1.5">Cards per row</p>
        ${seg('cols', [[2, 'Two'], [3, 'Three'], [4, 'Four']], CFG.cols)}
      </div>

      <div class="serrate serrate-thin"></div>

      <p class="text-xs uppercase tracking-[0.16em] text-muted">Collection</p>
      <label class="block w-full bg-maroon py-3 rounded font-display tracking-wide text-center active:opacity-90">
        <input type="file" accept=".csv,text/csv" class="hidden" id="s-import">
        Import a CSV
      </label>
      <p class="text-[11px] text-muted -mt-3">Takes a Collectr export. Watchlist entries are left out, and sealed and graded prices come across as they are.</p>

      <button id="s-export" class="w-full border border-maroonD py-3 rounded text-sm">Save a backup copy</button>
      <p class="text-[11px] text-muted -mt-3">Downloads everything as a spreadsheet. Worth doing now and then, since the collection lives only on this phone.</p>

      ${installPrompt ? `<button id="s-install" class="w-full border border-gold/50 text-gold py-3 rounded text-sm">Add to home screen</button>` : ''}

      <div class="serrate serrate-thin"></div>

      <button id="s-adv" class="w-full flex items-center justify-between py-2 text-xs uppercase tracking-[0.16em] text-muted">
        <span>Technical settings</span><span>${CFG.advanced ? '\u2212' : '+'}</span>
      </button>

      <div id="adv" class="${CFG.advanced ? '' : 'hidden'} space-y-5">
        <p class="text-[11px] text-muted">These control the card scanner and pricing. Nothing here needs changing day to day.</p>

        <div>
          <label class="block text-xs uppercase tracking-[0.16em] text-muted mb-1.5">Scanner endpoint</label>
          <input id="s-url" value="${esc(CFG.workerUrl)}" placeholder="https://your-worker.workers.dev"
            class="w-full bg-ink2 border border-maroonD rounded px-3 py-2.5 text-sm">
        </div>
        <div>
          <label class="block text-xs uppercase tracking-[0.16em] text-muted mb-1.5">Shared secret</label>
          <input id="s-secret" value="${esc(CFG.workerSecret)}" type="password"
            class="w-full bg-ink2 border border-maroonD rounded px-3 py-2.5 text-sm">
        </div>
        <div>
          <label class="block text-xs uppercase tracking-[0.16em] text-muted mb-1.5">pokemontcg.io key</label>
          <input id="s-ptcg" value="${esc(CFG.pokemonKey)}" placeholder="Optional"
            class="w-full bg-ink2 border border-maroonD rounded px-3 py-2.5 text-sm">
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs uppercase tracking-[0.16em] text-muted mb-1.5">USD to QAR</label>
            <input id="s-rate" value="${CFG.qarRate}" inputmode="decimal"
              class="w-full bg-ink2 border border-maroonD rounded px-3 py-2.5 text-sm tabular">
          </div>
          <div>
            <label class="block text-xs uppercase tracking-[0.16em] text-muted mb-1.5">Local premium %</label>
            <input id="s-prem" value="${CFG.premium}" inputmode="decimal"
              class="w-full bg-ink2 border border-maroonD rounded px-3 py-2.5 text-sm tabular">
          </div>
        </div>
        <p class="text-[11px] text-muted">The riyal is pegged at 3.64 to the dollar. The premium is what Doha actually pays over TCGplayer market, applied to trade asks only.</p>

        <button id="s-save" class="w-full bg-maroon py-3 rounded font-display tracking-wide">Save technical settings</button>

        <button id="s-clear" class="w-full border border-maroon text-maroon py-3 rounded text-sm">Delete the whole collection</button>
        <p class="text-[11px] text-muted -mt-3">Cannot be undone. Save a backup first.</p>
      </div>
    </div>`;

  // Appearance changes apply immediately: making someone save a theme is silly.
  v.querySelectorAll('.theme').forEach(b => b.onclick = () => {
    CFG.theme = b.dataset.theme; saveCfg(); applyTheme(); render();
  });
  v.querySelectorAll('.curr').forEach(b => b.onclick = () => {
    CFG.currency = b.dataset.curr; saveCfg(); render();
  });
  v.querySelectorAll('.cols').forEach(b => b.onclick = () => {
    CFG.cols = Number(b.dataset.cols); saveCfg(); render();
  });

  $('#s-adv').onclick = () => { CFG.advanced = !CFG.advanced; saveCfg(); render(); };

  const install = $('#s-install');
  if (install) install.onclick = async () => {
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    render();
  };

  const save = $('#s-save');
  if (save) save.onclick = () => {
    CFG.workerUrl = $('#s-url').value.trim();
    CFG.workerSecret = $('#s-secret').value.trim();
    CFG.pokemonKey = $('#s-ptcg').value.trim();
    CFG.qarRate = parseFloat($('#s-rate').value) || 3.64;
    CFG.premium = parseFloat($('#s-prem').value) || 0;
    saveCfg();
    toast('Saved');
    render();
  };

  const clear = $('#s-clear');
  if (clear) clear.onclick = async () => {
    const n = (await DB.all()).length;
    if (!n) { toast('Collection is already empty.'); return; }
    if (!confirm(`Delete all ${n} rows? Save a backup first if you want a copy.`)) return;
    if (!confirm('Last check. This cannot be undone.')) return;
    await DB.clear();
    toast('Collection cleared');
    render();
  };

  $('#s-import').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const { kept, skipped } = readCollectr(text);
      if (!kept.length) { toast('Nothing importable in that file.', 'bad'); return; }
      const existing = await DB.all();
      IMPORT = { rows: kept, skipped, stage: 'review', done: 0, total: 0, existing: existing.length };
      render();
    } catch (err) {
      toast('Could not read that file: ' + err.message, 'bad');
    }
  };

  $('#s-export').onclick = async () => {
    const cards = await DB.all();
    const head = ['kind', 'name', 'set', 'number', 'printedTotal', 'variant', 'era',
                  'grade', 'condition', 'qty', 'priceUsd', 'priceQar', 'priceSource', 'tradeQty'];
    const rows = cards.map(c => [
      c.kind || 'single', c.name, c.setName, c.number, c.printedTotal, c.variant, c.era || '',
      c.grade || '', c.condition || '', c.qty || 1,
      (c.priceUsd || 0).toFixed(2), Math.round((c.priceUsd || 0) * CFG.qarRate),
      c.priceSource || 'tcgplayer', tradeOf(c)
    ].map(x => `"${String(x ?? '').replace(/"/g, '""')}"`).join(','));
    const blob = new Blob([[head.join(','), ...rows].join('\n')], { type: 'text/csv' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = `al-majmoua-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Backup saved to downloads');
  };
}

/* ---- import review ---- */

function viewImport(v) {
  const { rows, skipped, stage, done, total } = IMPORT;
  const sealed = rows.filter(r => r.kind === 'sealed');
  const graded = rows.filter(r => r.kind === 'single' && r.grade);
  const raw    = rows.filter(r => r.kind === 'single' && !r.grade);
  const worth  = g => g.reduce((s, r) => s + r.priceUsd * r.qty, 0);
  const copies = g => g.reduce((s, r) => s + r.qty, 0);

  const line = (label, g, note) => `
    <div class="flex items-baseline justify-between py-2 border-b border-maroonD/60">
      <div>
        <p class="text-sm">${label}</p>
        ${note ? `<p class="text-[11px] text-muted">${note}</p>` : ''}
      </div>
      <div class="text-right shrink-0 pl-3">
        <p class="text-gold font-display tabular">${money(worth(g))}</p>
        <p class="text-[10px] text-muted tabular">${copies(g)} item${copies(g) === 1 ? '' : 's'}</p>
      </div>
    </div>`;

  const head = el('div', 'fade-up');
  head.innerHTML = `
    <p class="font-display text-xl mb-1">Import review</p>
    <p class="text-sm text-muted mb-4">Nothing is saved until you confirm.</p>
    ${line('Raw singles', raw, 'Repriced from TCGplayer during import')}
    ${line('Sealed product', sealed, 'Collectr price, frozen and not auto-updated')}
    ${line('Graded cards', graded, 'Collectr price, locked out of refresh')}
    <div class="flex items-baseline justify-between py-3">
      <p class="font-display">Total</p>
      <p class="text-gold font-display text-xl tabular">${money(worth(rows))}</p>
    </div>
    ${IMPORT.existing ? `
      <div class="border border-gold/50 rounded p-3 mb-4">
        <p class="text-[11px] uppercase tracking-[0.14em] text-gold mb-1">Collection is not empty</p>
        <p class="text-[11px] text-muted">There are already ${IMPORT.existing} rows. Matching rows will stack and quantities will add up. If you are re-importing the same file, clear the collection in Settings first.</p>
      </div>` : ''}
    ${skipped.length ? `
      <div class="bg-ink2 rounded p-3 mb-4">
        <p class="text-[11px] uppercase tracking-[0.14em] text-gold mb-1.5">${skipped.length} row${skipped.length === 1 ? '' : 's'} left out</p>
        ${skipped.slice(0, 6).map(s => `<p class="text-[11px] text-muted truncate">${esc(s.name)} \u00b7 ${esc(s.why)}</p>`).join('')}
        ${skipped.length > 6 ? `<p class="text-[11px] text-muted">and ${skipped.length - 6} more</p>` : ''}
      </div>` : ''}`;
  v.appendChild(head);

  if (stage === 'running') {
    const pct = total ? Math.round(done / total * 100) : 0;
    const prog = el('div', 'mt-2');
    prog.innerHTML = `
      <div class="h-1.5 bg-ink2 rounded overflow-hidden mb-2">
        <div class="h-full bg-maroon" style="width:${pct}%"></div>
      </div>
      <p class="text-sm text-gold text-center">Matching singles ${done} of ${total}</p>
      <p class="text-[11px] text-muted text-center mt-1">Leave this open. Sealed items need no lookup.</p>`;
    v.appendChild(prog);
    return;
  }

  const actions = el('div', 'flex gap-3 mt-4');
  const run = el('button', 'flex-1 bg-maroon py-3 rounded font-display tracking-wide', `Import ${copies(rows)} items`);
  const cancel = el('button', 'px-5 py-3 rounded border border-muted/30 text-muted text-sm', 'Cancel');
  run.onclick = async () => {
    IMPORT.stage = 'running';
    IMPORT.total = raw.length;
    render();
    const stats = await enrichImport(rows, (d, t) => {
      IMPORT.done = d; IMPORT.total = t;
      const bar = $('#view .bg-maroon[style]');
      const label = $('#view .text-gold.text-center');
      if (bar) bar.style.width = Math.round(d / t * 100) + '%';
      if (label) label.textContent = `Matching singles ${d} of ${t}`;
    });
    const { added, stacked } = await commitRows(rows);
    const fresh = await DB.all();
    recordSnapshot(fresh.reduce((s, c) => s + valueOf(c) * (c.qty || 1), 0));
    IMPORT = null;
    toast(`${added} imported, ${stacked} stacked, ${stats.matched}/${stats.total} matched` +
      (stats.failed ? `, ${stats.failed} lookup${stats.failed === 1 ? '' : 's'} failed` : ''));
    go('collection');
  };
  cancel.onclick = () => { IMPORT = null; render(); };
  actions.append(run, cancel);
  v.appendChild(actions);
}

/* ------------------------------------------------------------------ boot */

/* Android's hardware back button walks history. Without entries it would
   close the app from any tab, so every tab change pushes one. */
const discardPrompt = () =>
  `Discard the ${PENDING.length} card${PENDING.length === 1 ? '' : 's'} you just scanned?`;

function go(tab, push = true) {
  if (TAB === 'scan' && PENDING.length && tab !== 'scan') {
    if (!confirm(discardPrompt())) return;
    PENDING = [];
  }
  if (TAB === 'settings' && IMPORT && tab !== 'settings') {
    if (IMPORT.stage === 'running') { toast('Import is still running.'); return; }
    if (!confirm('Cancel the import?')) return;
    IMPORT = null;
  }
  TAB = tab;
  if (push) history.pushState({ tab }, '', '#' + tab);
  render();
}

document.querySelectorAll('.tab').forEach(b => b.onclick = () => go(b.dataset.tab));

window.addEventListener('popstate', e => {
  // A sheet is the shallowest thing on screen, so back closes it first.
  if (SHEET) { SHEET = null; renderSheet(); return; }
  // Back out of a review discards the scan rather than the app. Restore the
  // entry the back press consumed first, before the confirm, so cancelling
  // leaves history intact and the next press still returns to Collection.
  if (PENDING.length) {
    history.pushState({ tab: 'scan' }, '', '#scan');
    if (!confirm(discardPrompt())) return;
    PENDING = [];
    TAB = 'scan';
    render();
    return;
  }
  // Same treatment for an import that has not been committed.
  if (IMPORT) {
    history.pushState({ tab: 'settings' }, '', '#settings');
    if (IMPORT.stage === 'running') { toast('Import is still running.'); return; }
    if (!confirm('Cancel the import?')) return;
    IMPORT = null;
    TAB = 'settings';
    render();
    return;
  }
  TAB = e.state?.tab || 'collection';
  render();
});

history.replaceState({ tab: 'collection' }, '', '#collection');

/* Chrome grants this readily to installed PWAs. Once granted the collection
   survives storage pressure and only clearing site data removes it. */
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  if (TAB === 'settings') render();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  if (TAB === 'settings') render();
});

applyTheme();
wireHeader();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

render();
