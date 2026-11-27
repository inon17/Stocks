// Vercel serverless function: GET /api/quotes?symbols=AAPL,MSFT
// Same JSON shape as server.py, so index.html works both locally and on Vercel.
// Browsers cannot call Yahoo directly (CORS), so this function fetches on their behalf. No API key.

const SYM_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const MAX_SYMBOLS = 40;
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';
// 1-minute bars incl. pre/post market, so we can show the extended-hours move too
const QUERY = '?interval=1m&range=1d&includePrePost=true';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
// Yahoo's chart often has no pre-market bars (e.g. the day after a holiday), so outside regular
// hours we also ask Nasdaq's public quote API, which has real-time pre/after-hours trades. No key.
const NASDAQ = 'https://api.nasdaq.com/api/quote/';
const NASDAQ_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const assetClass = new Map();   // symbol -> 'stocks' | 'etf' (remembered while the function stays warm)

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

// "Nov 27, 2026 6:37 AM ET" -> unix seconds, using the exchange's UTC offset from Yahoo (gmtoffset).
function parseNasdaqTime(txt, gmtoffset) {
  const m = /([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2}) (AM|PM)/.exec(txt || '');
  if (!m || !(m[1] in MONTHS) || !Number.isFinite(gmtoffset)) return null;
  const h = (+m[4] % 12) + (m[6] === 'PM' ? 12 : 0);
  return Date.UTC(+m[3], MONTHS[m[1]], +m[2], h, +m[5]) / 1000 - gmtoffset;
}

// Latest pre-market / after-hours trade from Nasdaq, or null.
async function nasdaqExt(sym, gmtoffset, regTime) {
  const nsym = sym.replace('-', '.');           // Yahoo BRK-B = Nasdaq BRK.B
  const classes = assetClass.has(sym) ? [assetClass.get(sym)] : ['stocks', 'etf'];
  for (const cls of classes) {
    try {
      const r = await fetch(NASDAQ + encodeURIComponent(nsym) + '/info?assetclass=' + cls, {
        headers: { 'User-Agent': NASDAQ_UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(4000),
      });
      if (!r.ok) return null;
      const d = (await r.json()).data;
      if (!d) continue;                          // wrong asset class, try the next one
      assetClass.set(sym, cls);
      const session = d.marketStatus === 'Pre-Market' ? 'pre' : d.marketStatus === 'After-Hours' ? 'post' : null;
      const p = d.primaryData || {};
      const price = parseFloat(String(p.lastSalePrice || '').replace(/[$,]/g, ''));
      const time = parseNasdaqTime(p.lastTradeTimestamp, gmtoffset);
      if (!session || !(price > 0) || !time || time <= regTime + 60) return null;
      return { price: Math.round(price * 1e4) / 1e4, session, time };
    } catch (e) {
      console.warn('Nasdaq failed for', sym, String(e));
      return null;
    }
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
    const market = marketState(m.currentTradingPeriod, now);
    let ext = extended(res[0], m);
    if (market === 'pre' || market === 'post') {
      const nq = await nasdaqExt(sym, m.gmtoffset, m.regularMarketTime || 0);
      if (nq && (!ext || nq.time >= ext.time)) ext = nq;   // use whichever trade is newer
    }
    return {
      price: m.regularMarketPrice,
      prevClose: m.chartPreviousClose ?? m.previousClose ?? null,
      time: m.regularMarketTime ?? null,
      name: m.longName || m.shortName || null,
      exchange: m.fullExchangeName || m.exchangeName || null,
      market,
      ext,
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
