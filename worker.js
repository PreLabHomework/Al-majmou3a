/* Cloudflare Worker: keeps the Anthropic API key off your dad's phone.
   Deploy with `wrangler deploy`, then set two secrets:
     wrangler secret put ANTHROPIC_API_KEY
     wrangler secret put APP_SECRET
   Set ALLOWED_ORIGIN in wrangler.toml to your GitHub Pages URL. */

const MODEL_ALLOWLIST = ['claude-haiku-4-5-20251001'];

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || '*';
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Content-Type, X-App-Secret',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Max-Age': '86400'
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405, cors);

    if (request.headers.get('X-App-Secret') !== env.APP_SECRET)
      return json({ error: 'Bad secret' }, 401, cors);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'Bad JSON' }, 400, cors); }

    // Only let the app ask for what it is supposed to ask for.
    if (!MODEL_ALLOWLIST.includes(body.model)) return json({ error: 'Model not allowed' }, 400, cors);
    body.max_tokens = Math.min(body.max_tokens || 400, 600);

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });

    const text = await r.text();
    return new Response(text, {
      status: r.status,
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
}
