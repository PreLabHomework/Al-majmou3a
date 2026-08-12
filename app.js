/* Al Majmoua - Pokemon collection tracker for the Doha market
   Local-first PWA. Collection lives in IndexedDB on the device. */

/* ---------------------------------------------------------------- config */

const DEFAULTS = {
  workerUrl: '',        // your Cloudflare Worker endpoint
  workerSecret: '',     // shared secret, must match the Worker
  pokemonKey: '',       // pokemontcg.io free key (optional but recommended)
  qarRate: 3.64,        // riyal is pegged to USD, so this is a constant
  premium: 0            // local market premium %, applied to trade asks only
};

const CFG = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('cfg') || '{}'));
const saveCfg = () => localStorage.setItem('cfg', JSON.stringify(CFG));

const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'];

/* Rough TCGplayer convention, not gospel. Adjust once you see what condition
   actually costs in Doha. */
const COND_MULT = { NM: 1, LP: 0.85, MP: 0.7, HP: 0.5, DMG: 0.3 };
const valueOf = c => (c.priceUsd || 0) * (COND_MULT[c.condition] ?? 1);

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
const usd = n => '$' + (Number(n) || 0).toFixed(2);
const qar = n => Math.round((Number(n) || 0) * CFG.qarRate).toLocaleString() + ' QAR';

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
  if (!CFG.workerUrl) throw new Error('No scanner endpoint set. Open Settings.');
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
  if (!r.ok) throw new Error('Scanner returned ' + r.status);
  const data = await r.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const clean = text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); }
  catch { throw new Error('Could not read that card'); }
}

/* --------------------------------------------------------------- catalog */

const PTCG = 'https://api.pokemontcg.io/v2/cards';

/* Catalog data is static, so it caches for 30 days. Prices are not, so a
   refresh passes fresh=true to skip the read and overwrite the entry. */
async function ptcgQuery(q, fresh = false) {
  const key = 'q:' + q;
  if (!fresh) {
    const hit = await DB.cacheGet(key);
    if (hit && Date.now() - hit.at < 30 * 864e5) return hit.value;
  }

  const headers = CFG.pokemonKey ? { 'X-Api-Key': CFG.pokemonKey } : {};
  const r = await fetch(`${PTCG}?q=${encodeURIComponent(q)}&pageSize=12`, { headers });
  if (!r.ok) throw new Error('Card database returned ' + r.status);
  const out = (await r.json()).data || [];
  await DB.cacheSet(key, out);
  return out;
}

/* Resolve a vision reading to a real catalog card.
   Collector number plus printed total is close to a unique key, so try that first. */
async function resolve(read) {
  const num = String(read.number || '').replace(/^0+/, '');
  const total = String(read.printedTotal || '');
  let hits = [];

  if (num && total) hits = await ptcgQuery(`number:"${num}" set.printedTotal:${total}`);
  if (!hits.length && num && read.name) hits = await ptcgQuery(`number:"${num}" name:"${read.name}"`);
  if (!hits.length && read.name) hits = await ptcgQuery(`name:"${read.name}"`);
  if (!hits.length) return null;

  if (hits.length > 1 && read.name) {
    const want = read.name.toLowerCase();
    hits.sort((a, b) => {
      const s = c => (c.name || '').toLowerCase() === want ? 0
        : (c.name || '').toLowerCase().includes(want) ? 1 : 2;
      return s(a) - s(b);
    });
  }
  return hits[0];
}

/* Pick the price that matches the printing we think we have. */
function priceOf(card, variant) {
  const p = card?.tcgplayer?.prices;
  if (!p) return null;
  const order = variant === 'reverse'
    ? ['reverseHolofoil', 'holofoil', 'normal', '1stEditionHolofoil']
    : variant === 'holo'
      ? ['holofoil', 'reverseHolofoil', 'normal', '1stEditionHolofoil']
      : ['normal', 'holofoil', 'reverseHolofoil', '1stEditionHolofoil'];
  for (const k of order) {
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

/* Find every card-shaped quad in a grid photo and warp each to an upright crop. */
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

async function processCrops(canvases, statusEl) {
  const results = [];
  let done = 0;
  const step = () => { statusEl.textContent = `Identifying ${++done} of ${canvases.length}`; };

  const queue = canvases.map((c, i) => async () => {
    try {
      const read = await identify(canvasToB64(c));
      if (!read.name && !read.number) { step(); return; }
      const card = await resolve(read);
      const price = card ? priceOf(card, read.variant) : null;
      results[i] = {
        cardId: card?.id || null,
        name: card?.name || read.name || 'Unknown card',
        setName: card?.set?.name || read.setHint || '',
        number: card?.number || read.number || '',
        printedTotal: card?.set?.printedTotal || read.printedTotal || '',
        image: card?.images?.small || c.toDataURL('image/jpeg', 0.6),
        variant: read.variant || 'normal',
        printing: price?.printing || '',
        priceUsd: price?.usd || 0,
        confidence: read.confidence ?? 0,
        matched: !!card
      };
    } catch (e) {
      results[i] = { name: 'Could not read', error: e.message, image: c.toDataURL('image/jpeg', 0.6), matched: false, priceUsd: 0 };
    }
    step();
  });

  // Three at a time keeps it fast without hammering the endpoint.
  const lanes = Array.from({ length: 3 }, async () => {
    while (queue.length) await queue.shift()();
  });
  await Promise.all(lanes);
  return results.filter(Boolean);
}

/* ----------------------------------------------------------------- views */

let TAB = 'collection';
let PENDING = [];

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
  if (TAB === 'settings') viewSettings(v);
  await updateTotals();
}

async function updateTotals() {
  const cards = await DB.all();
  const total = cards.reduce((s, c) => s + valueOf(c) * (c.qty || 1), 0);
  $('#totalValue').textContent = qar(total);
  $('#totalUsd').textContent = usd(total);
}

/* ---- collection ---- */

async function viewCollection(v) {
  const cards = (await DB.all()).sort((a, b) => b.addedAt - a.addedAt);

  if (!cards.length) {
    v.appendChild(el('div', 'text-center py-20 fade-up', `
      <p class="font-display text-xl mb-2">Nothing logged yet</p>
      <p class="text-sm text-muted mb-6 max-w-xs mx-auto">Open a pack, take a photo, and every card lands here with its market price.</p>
      <button id="goScan" class="bg-maroon px-6 py-3 rounded font-display tracking-wide">Scan your first card</button>`));
    $('#goScan').onclick = () => go('scan');
    return;
  }

  const bar = el('div', 'flex items-center justify-between mb-4');
  bar.appendChild(el('p', 'text-sm text-muted', `${cards.length} card${cards.length > 1 ? 's' : ''} logged`));
  const refresh = el('button', 'text-xs uppercase tracking-[0.14em] text-gold border border-gold/40 px-3 py-1.5 rounded', 'Refresh prices');
  refresh.onclick = () => refreshPrices(refresh);
  bar.appendChild(refresh);
  v.appendChild(bar);

  const grid = el('div', 'grid grid-cols-2 gap-3');
  cards.forEach(c => grid.appendChild(cardTile(c)));
  v.appendChild(grid);
}

function cardTile(c) {
  const t = el('div', 'bg-ink2 rounded overflow-hidden fade-up');
  t.innerHTML = `
    <div class="card-ratio bg-maroonD/40">
      <img src="${esc(c.image)}" alt="${esc(c.name)}" class="w-full h-full object-cover" loading="lazy">
    </div>
    <div class="p-2.5">
      <p class="font-display text-sm leading-tight truncate">${esc(c.name)}</p>
      <p class="text-[11px] text-muted truncate">${esc(c.setName)} ${c.number ? esc(c.number) : ''}${c.printedTotal ? '/' + esc(c.printedTotal) : ''}</p>
      <p class="text-gold font-display text-base tabular mt-1.5">${qar(valueOf(c))}</p>
      <p class="text-[10px] text-muted tabular">${usd(valueOf(c))} · ${esc(c.condition || 'NM')}${c.qty > 1 ? ' · x' + c.qty : ''}</p>
      <div class="flex gap-1.5 mt-2">
        <button class="trade flex-1 text-[10px] uppercase tracking-[0.1em] py-1.5 rounded border ${c.forTrade ? 'bg-maroon border-maroon' : 'border-muted/30 text-muted'}">${c.forTrade ? 'For trade' : 'Keep'}</button>
        <button class="del text-[10px] px-2 py-1.5 rounded border border-muted/30 text-muted">✕</button>
      </div>
    </div>`;
  t.querySelector('.trade').onclick = async () => { c.forTrade = !c.forTrade; await DB.put(c); render(); };
  t.querySelector('.del').onclick = async () => {
    if (confirm(`Remove ${c.name} from the collection?`)) { await DB.del(c.id); render(); }
  };
  return t;
}

async function refreshPrices(btn) {
  const cards = (await DB.all()).filter(c => c.cardId);
  btn.disabled = true;
  let n = 0;
  for (const c of cards) {
    btn.textContent = `Updating ${++n}/${cards.length}`;
    try {
      const hits = await ptcgQuery(`id:"${c.cardId}"`, true);
      const p = priceOf(hits[0], c.variant);
      if (p) { c.priceUsd = p.usd; c.priceUpdated = Date.now(); await DB.put(c); }
    } catch { /* keep the old price rather than blanking it */ }
  }
  btn.disabled = false;
  toast('Prices updated');
  render();
}

/* ---- scan ---- */

async function viewScan(v) {
  if (PENDING.length) return viewReview(v);

  v.innerHTML = `
    <div class="fade-up">
      <p class="text-sm text-muted mb-6">Two ways in. Use precision for anything you care about, bulk for everything else.</p>

      <label class="block bg-maroon rounded p-5 mb-3 active:opacity-90">
        <input type="file" accept="image/*" capture="environment" class="hidden" id="single">
        <div class="flex items-center gap-4">
          <span class="text-3xl">◎</span>
          <div>
            <p class="font-display text-lg leading-tight">Precision</p>
            <p class="text-xs opacity-80">One card, one photo. Highest accuracy.</p>
          </div>
        </div>
      </label>

      <label class="block bg-ink2 border border-maroonD rounded p-5 active:opacity-90">
        <input type="file" accept="image/*" capture="environment" class="hidden" id="bulk">
        <div class="flex items-center gap-4">
          <span class="text-3xl">▦</span>
          <div>
            <p class="font-display text-lg leading-tight">Bulk grid</p>
            <p class="text-xs text-muted">Lay the pack out, one photo, all cards at once.</p>
          </div>
        </div>
      </label>

      <div class="serrate serrate-thin my-6"></div>

      <p class="text-xs uppercase tracking-[0.16em] text-muted mb-2">For bulk shots</p>
      <ul class="text-sm text-muted space-y-1.5 list-none">
        <li>Dark, plain surface. A closed binder works.</li>
        <li>Cards not touching, roughly square to the frame.</li>
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
        toast('No cards found. Try a darker background with more gaps.', 'bad');
        return;
      }
      status.textContent = `Found ${crops.length}`;
    } else {
      crops = [canvas];
    }

    PENDING = await processCrops(crops, status);
    status.textContent = '';
    render();
  } catch (e) {
    status.textContent = '';
    toast(e.message, 'bad');
  }
}

/* ---- review ---- */

function viewReview(v) {
  const total = PENDING.reduce((s, c) => s + valueOf(c), 0);

  const head = el('div', 'mb-4 fade-up');
  head.innerHTML = `
    <p class="font-display text-xl">${PENDING.length} card${PENDING.length > 1 ? 's' : ''} read</p>
    <p class="text-gold font-display text-2xl tabular">${qar(total)}</p>
    <p class="text-xs text-muted">${usd(total)} at market. Check anything flagged before saving.</p>`;
  v.appendChild(head);

  PENDING.forEach((c, i) => {
    const low = !c.matched || (c.confidence ?? 1) < 0.75;
    const row = el('div', `flex gap-3 bg-ink2 rounded p-3 mb-2.5 fade-up ${low ? 'border border-gold/50' : ''}`);
    row.innerHTML = `
      <img src="${esc(c.image)}" class="w-14 rounded object-cover card-ratio bg-maroonD/40" alt="">
      <div class="flex-1 min-w-0">
        <p class="font-display text-sm truncate">${esc(c.name)}</p>
        <p class="text-[11px] text-muted truncate">${esc(c.setName)} ${esc(c.number)}${c.printedTotal ? '/' + esc(c.printedTotal) : ''} · ${esc(c.printing || c.variant)}</p>
        ${low ? `<p class="text-[11px] text-gold mt-0.5">${c.matched ? 'Low confidence, worth a look' : 'No catalog match'}</p>` : ''}
        <div class="flex items-center gap-2 mt-2">
          <select class="cond bg-ink text-xs rounded px-2 py-1 border border-muted/30">
            ${CONDITIONS.map(k => `<option ${k === (c.condition || 'NM') ? 'selected' : ''}>${k}</option>`).join('')}
          </select>
          <span class="text-gold text-sm font-display tabular">${qar(valueOf(c))}</span>
          <button class="drop ml-auto text-xs text-muted px-2">Remove</button>
        </div>
      </div>`;
    row.querySelector('.cond').onchange = e => { PENDING[i].condition = e.target.value; render(); };
    row.querySelector('.drop').onclick = () => { PENDING.splice(i, 1); render(); };
    v.appendChild(row);
  });

  const actions = el('div', 'flex gap-3 mt-6');
  const save = el('button', 'flex-1 bg-maroon py-3 rounded font-display tracking-wide', 'Add to collection');
  const cancel = el('button', 'px-5 py-3 rounded border border-muted/30 text-muted text-sm', 'Discard');
  save.onclick = async () => {
    for (const c of PENDING) {
      await DB.put({
        cardId: c.cardId, name: c.name, setName: c.setName, number: c.number,
        printedTotal: c.printedTotal, image: c.image, variant: c.variant,
        printing: c.printing, priceUsd: c.priceUsd, condition: c.condition || 'NM',
        qty: 1, forTrade: false, addedAt: Date.now(), priceUpdated: Date.now()
      });
    }
    toast(`${PENDING.length} added`);
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
  const cards = (await DB.all()).filter(c => c.forTrade).sort((a, b) => b.priceUsd - a.priceUsd);

  if (!cards.length) {
    v.innerHTML = `<div class="text-center py-20 fade-up">
      <p class="font-display text-xl mb-2">Trade shelf is empty</p>
      <p class="text-sm text-muted max-w-xs mx-auto">Mark a card "For trade" in your collection and it shows up here, ready to post.</p></div>`;
    return;
  }

  const total = cards.reduce((s, c) => s + askPrice(c), 0);
  const head = el('div', 'mb-4 fade-up');
  head.innerHTML = `
    <p class="font-display text-xl">${cards.length} on the shelf</p>
    <p class="text-gold font-display text-2xl tabular">${Math.round(total).toLocaleString()} QAR</p>
    <p class="text-xs text-muted">Asks include your ${CFG.premium || 0}% local premium.</p>`;
  v.appendChild(head);

  const post = el('button', 'w-full bg-maroon py-3 rounded font-display tracking-wide mb-5', 'Copy list for WhatsApp');
  post.onclick = async () => {
    const lines = cards.map(c =>
      `${c.name} ${c.number}${c.printedTotal ? '/' + c.printedTotal : ''}` +
      `${c.variant === 'reverse' ? ' (RH)' : c.variant === 'holo' ? ' (Holo)' : ''}` +
      ` [${c.condition || 'NM'}] - ${Math.round(askPrice(c)).toLocaleString()} QAR`);
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
    row.innerHTML = `
      <img src="${esc(c.image)}" class="w-11 rounded object-cover card-ratio" alt="">
      <div class="flex-1 min-w-0">
        <p class="font-display text-sm truncate">${esc(c.name)}</p>
        <p class="text-[11px] text-muted truncate">${esc(c.setName)} · ${esc(c.condition || 'NM')}</p>
      </div>
      <div class="text-right">
        <p class="text-gold font-display tabular">${Math.round(askPrice(c)).toLocaleString()}</p>
        <p class="text-[10px] text-muted">QAR</p>
      </div>`;
    v.appendChild(row);
  });
}

/* ---- settings ---- */

function viewSettings(v) {
  v.innerHTML = `
    <div class="fade-up space-y-5">
      <div>
        <label class="block text-xs uppercase tracking-[0.16em] text-muted mb-1.5">Scanner endpoint</label>
        <input id="s-url" value="${esc(CFG.workerUrl)}" placeholder="https://your-worker.workers.dev"
          class="w-full bg-ink2 border border-maroonD rounded px-3 py-2.5 text-sm">
        <p class="text-[11px] text-muted mt-1">Your Cloudflare Worker. It holds the API key so the app does not have to.</p>
      </div>
      <div>
        <label class="block text-xs uppercase tracking-[0.16em] text-muted mb-1.5">Shared secret</label>
        <input id="s-secret" value="${esc(CFG.workerSecret)}" type="password"
          class="w-full bg-ink2 border border-maroonD rounded px-3 py-2.5 text-sm">
      </div>
      <div>
        <label class="block text-xs uppercase tracking-[0.16em] text-muted mb-1.5">pokemontcg.io key</label>
        <input id="s-ptcg" value="${esc(CFG.pokemonKey)}" placeholder="Optional, raises the daily limit"
          class="w-full bg-ink2 border border-maroonD rounded px-3 py-2.5 text-sm">
      </div>

      <div class="serrate serrate-thin"></div>

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
      <p class="text-[11px] text-muted">The riyal is pegged at 3.64 to the dollar, so that rate rarely moves. The premium is what Doha actually pays over TCGplayer market.</p>

      <button id="s-save" class="w-full bg-maroon py-3 rounded font-display tracking-wide">Save settings</button>

      <div class="serrate serrate-thin"></div>

      ${installPrompt ? `<button id="s-install" class="w-full bg-maroonD py-3 rounded font-display tracking-wide">Install to home screen</button>` : ''}

      <button id="s-export" class="w-full border border-muted/30 text-muted py-3 rounded text-sm">Export collection as CSV</button>
    </div>`;

  const install = $('#s-install');
  if (install) install.onclick = async () => {
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    render();
  };

  $('#s-save').onclick = () => {
    CFG.workerUrl = $('#s-url').value.trim();
    CFG.workerSecret = $('#s-secret').value.trim();
    CFG.pokemonKey = $('#s-ptcg').value.trim();
    CFG.qarRate = parseFloat($('#s-rate').value) || 3.64;
    CFG.premium = parseFloat($('#s-prem').value) || 0;
    saveCfg();
    toast('Saved');
    render();
  };

  $('#s-export').onclick = async () => {
    const cards = await DB.all();
    const head = ['name', 'set', 'number', 'printedTotal', 'variant', 'condition', 'qty', 'priceUsd', 'priceQar', 'forTrade'];
    const rows = cards.map(c => [
      c.name, c.setName, c.number, c.printedTotal, c.variant, c.condition, c.qty,
      (c.priceUsd || 0).toFixed(2), Math.round((c.priceUsd || 0) * CFG.qarRate), c.forTrade ? 'yes' : 'no'
    ].map(x => `"${String(x ?? '').replace(/"/g, '""')}"`).join(','));
    const blob = new Blob([[head.join(','), ...rows].join('\n')], { type: 'text/csv' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = `collection-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
}

/* ------------------------------------------------------------------ boot */

/* Android's hardware back button walks history. Without entries it would
   close the app from any tab, so every tab change pushes one. */
function go(tab, push = true) {
  if (TAB === 'scan' && PENDING.length && tab !== 'scan') {
    if (!confirm('Leave without saving the scanned cards?')) return;
    PENDING = [];
  }
  TAB = tab;
  if (push) history.pushState({ tab }, '', '#' + tab);
  render();
}

document.querySelectorAll('.tab').forEach(b => b.onclick = () => go(b.dataset.tab));

window.addEventListener('popstate', e => {
  // Back out of a review discards the scan rather than the app. The back
  // press already consumed an entry, so put one back or the next press
  // closes the app from the Scan tab instead of returning to Collection.
  if (PENDING.length) {
    PENDING = [];
    TAB = 'scan';
    history.pushState({ tab: 'scan' }, '', '#scan');
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

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

render();
