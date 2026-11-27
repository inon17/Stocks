// Vercel serverless function: GET /api/quotes?symbols=AAPL,MSFT
// Same JSON shape as server.py, so index.html works both locally and on Vercel.
// Browsers cannot call Yahoo directly (CORS), so this function fetches on their behalf. No API key.

const SYM_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const MAX_SYMBOLS = 40;
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';
// 1-minute bars incl. pre/post market, so we can show the extended-hours move too
const QUERY = '?interval=1m&range=1d&includePrePost=true';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

function marketState(period, now) {
  try {
    for (const [name, state] of [['regular', 'open'], ['pre', 'pre'], ['post', 'post']]) {
      const p = period[name];
      if (p.start <= now && now < p.end) return state;
    }
  } catch (_) { /* missing period info */ }
  return 'closed';
}

// Latest pre/post-market price: the last 1-minute bar that is later than the regular-session price.
function extended(r, m) {
  const ts = r.timestamp || [];
  const closes = (((r.indicators || {}).quote || [])[0] || {}).close || [];
  const regTime = m.regularMarketTime || 0;
  for (let i = ts.length - 1; i >= 0; i--) {
    const c = closes[i];
    if (c == null) continue;
    if (ts[i] <= regTime + 60) return null;          // latest trade is from the regular session
    const pre = (m.currentTradingPeriod || {}).pre || {};
    const session = pre.start <= ts[i] && ts[i] < pre.end ? 'pre' : 'post';
    return { price: Math.round(c * 1e4) / 1e4, session, time: ts[i] };
  }
  return null;
}

async function fetchSymbol(sym, now) {
  try {
    const r = await fetch(YAHOO + encodeURIComponent(sym) + QUERY, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (r.status === 404) return { invalid: true };
    if (!r.ok) { console.warn('Yahoo HTTP', r.status, 'for', sym); return { error: 'upstream ' + r.status }; }
    const res = ((await r.json()).chart || {}).result;
    if (!res || !res.length) return { invalid: true };
    const m = res[0].meta || {};
    if (m.regularMarketPrice == null) return { invalid: true };
    return {
      price: m.regularMarketPrice,
      prevClose: m.chartPreviousClose ?? m.previousClose ?? null,
      time: m.regularMarketTime ?? null,
      name: m.longName || m.shortName || null,
      exchange: m.fullExchangeName || m.exchangeName || null,
      market: marketState(m.currentTradingPeriod, now),
      ext: extended(res[0], m),
    };
  } catch (e) {
    console.warn('Fetch failed for', sym, String(e));
    return { error: 'unavailable' };
  }
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const raw = (url.searchParams.get('symbols') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const syms = [...new Set(raw)].filter(s => SYM_RE.test(s)).slice(0, MAX_SYMBOLS);
  const now = Date.now() / 1000;
  const results = await Promise.all(syms.map(s => fetchSymbol(s, now)));
  const quotes = Object.fromEntries(syms.map((s, i) => [s, results[i]]));
  const withMarket = results.find(q => q.market);
  const body = JSON.stringify({ serverTime: now, market: withMarket ? withMarket.market : null, quotes });
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // Vercel's CDN may reuse an answer for 2 s: fewer calls to Yahoo, still fresh for 3 s polling.
  res.setHeader('Cache-Control', 'public, s-maxage=2, stale-while-revalidate=1');
  res.end(body);
}

module.exports = handler;
