#!/usr/bin/env python3
"""
Local server for the stocks P/L site.

- Serves index.html.
- /api/quotes?symbols=AAPL,MSFT  -> live prices from Yahoo Finance (no API key).
  Browsers cannot call Yahoo directly (CORS), so this server fetches on their behalf.

Usage:
  python server.py            # only this computer:  http://127.0.0.1:8000
  python server.py --lan      # also phones on the same Wi-Fi (needs a firewall allow rule)
  python server.py --port 8080
Standard library only, nothing to install.
"""
import argparse
import calendar
import json
import logging
import re
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SYM_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$")
MAX_SYMBOLS = 40
CACHE_SECONDS = 2.0          # many browser tabs polling every 3 s still hit Yahoo at most every 2 s per symbol
# 1-minute bars incl. pre/post market, so we can show the extended-hours move too
YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/{}?interval=1m&range=1d&includePrePost=true"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
# Yahoo's chart often has no pre-market bars (e.g. the day after a holiday), so outside regular
# hours we also ask Nasdaq's public quote API, which has real-time pre/after-hours trades. No key.
NASDAQ = "https://api.nasdaq.com/api/quote/{}/info?assetclass={}"
NASDAQ_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
MONTHS = {m: i for i, m in enumerate("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(), 1)}
NASDAQ_TIME_RE = re.compile(r"([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2}) (AM|PM)")
_asset_class = {}            # symbol -> "stocks" | "etf"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.FileHandler(ROOT / "server.log", encoding="utf-8"), logging.StreamHandler()],
)
log = logging.getLogger("stocks")

_cache = {}                  # symbol -> (fetched_at, data)
_cache_lock = threading.Lock()
_pool = ThreadPoolExecutor(max_workers=8)


def market_state(period, now):
    """Map Yahoo's current trading period to open / pre / post / closed."""
    try:
        for name, state in (("regular", "open"), ("pre", "pre"), ("post", "post")):
            p = period[name]
            if p["start"] <= now < p["end"]:
                return state
    except (KeyError, TypeError):
        pass
    return "closed"


def extended(res, meta):
    """Latest pre/post-market price: the last 1-minute bar that is later than the regular-session price."""
    try:
        ts = res.get("timestamp") or []
        closes = res["indicators"]["quote"][0]["close"]
    except (KeyError, IndexError, TypeError):
        return None
    reg_time = meta.get("regularMarketTime") or 0
    for t, c in zip(reversed(ts), reversed(closes)):
        if c is None:
            continue
        if t <= reg_time + 60:
            return None                      # latest trade is from the regular session
        pre = (meta.get("currentTradingPeriod") or {}).get("pre") or {}
        session = "pre" if pre.get("start", 0) <= t < pre.get("end", 0) else "post"
        return {"price": round(c, 4), "session": session, "time": t}
    return None


def parse_nasdaq_time(txt, gmtoffset):
    """'Nov 27, 2026 6:37 AM ET' -> unix seconds, using the exchange's UTC offset from Yahoo."""
    m = NASDAQ_TIME_RE.search(txt or "")
    if not m or m.group(1) not in MONTHS or not isinstance(gmtoffset, (int, float)):
        return None
    hour = int(m.group(4)) % 12 + (12 if m.group(6) == "PM" else 0)
    t = calendar.timegm((int(m.group(3)), MONTHS[m.group(1)], int(m.group(2)), hour, int(m.group(5)), 0))
    return t - gmtoffset


def nasdaq_ext(sym, gmtoffset, reg_time):
    """Latest pre-market / after-hours trade from Nasdaq, or None."""
    nsym = sym.replace("-", ".")             # Yahoo BRK-B = Nasdaq BRK.B
    classes = [_asset_class[sym]] if sym in _asset_class else ["stocks", "etf"]
    for cls in classes:
        # Nasdaq refuses Python's own HTTP client (403), so use curl.exe (built into Windows 10/11).
        # Arguments are passed as a list (no shell) and the symbol was already validated by SYM_RE.
        cmd = ["curl", "-s", "-f", "-m", "4", "-A", NASDAQ_UA, "-H", "Accept: application/json",
               NASDAQ.format(urllib.parse.quote(nsym), cls)]
        try:
            out = subprocess.run(cmd, capture_output=True, timeout=6, check=True).stdout
            d = json.loads(out).get("data")
        except Exception as e:
            log.warning("Nasdaq failed for %s: %s", sym, e)
            return None
        if not d:
            continue                          # wrong asset class, try the next one
        _asset_class[sym] = cls
        session = {"Pre-Market": "pre", "After-Hours": "post"}.get(d.get("marketStatus"))
        p = d.get("primaryData") or {}
        try:
            price = float(str(p.get("lastSalePrice") or "").replace("$", "").replace(",", ""))
        except ValueError:
            return None
        t = parse_nasdaq_time(p.get("lastTradeTimestamp"), gmtoffset)
        if not session or price <= 0 or not t or t <= reg_time + 60:
            return None
        return {"price": round(price, 4), "session": session, "time": t}
    return None


def fetch_symbol(sym):
    now = time.time()
    with _cache_lock:
        hit = _cache.get(sym)
        if hit and now - hit[0] < CACHE_SECONDS:
            return hit[1]
    url = YAHOO.format(urllib.parse.quote(sym))
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            payload = json.load(r)
        res = (payload.get("chart") or {}).get("result")
        if not res:
            data = {"invalid": True}
        else:
            m = res[0]["meta"]
            price = m.get("regularMarketPrice")
            prev = m.get("chartPreviousClose") or m.get("previousClose")
            market = market_state(m.get("currentTradingPeriod"), now)
            ext = extended(res[0], m)
            if market in ("pre", "post") and price is not None:
                nq = nasdaq_ext(sym, m.get("gmtoffset"), m.get("regularMarketTime") or 0)
                if nq and (not ext or nq["time"] >= ext["time"]):
                    ext = nq                  # use whichever trade is newer
            data = {
                "price": price,
                "prevClose": prev,
                "time": m.get("regularMarketTime"),
                "name": m.get("longName") or m.get("shortName"),
                "exchange": m.get("fullExchangeName") or m.get("exchangeName"),
                "market": market,
                "ext": ext,
            }
            if price is None:
                data = {"invalid": True}
    except urllib.error.HTTPError as e:
        data = {"invalid": True} if e.code == 404 else {"error": "upstream %s" % e.code}
        if e.code != 404:
            log.warning("Yahoo HTTP %s for %s", e.code, sym)
    except Exception as e:  # network down, timeout, bad JSON
        log.warning("Fetch failed for %s: %s", sym, e)
        data = {"error": "unavailable"}
    if "error" not in data:
        with _cache_lock:
            _cache[sym] = (now, data)
    return data


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, fmt, *args):
        if not self.path.startswith("/api/"):
            log.info("%s %s", self.address_string(), fmt % args)

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/quotes":
            q = urllib.parse.parse_qs(parsed.query).get("symbols", [""])[0]
            syms = [s for s in dict.fromkeys(x.strip().upper() for x in q.split(",")) if s]
            syms = [s for s in syms if SYM_RE.match(s)][:MAX_SYMBOLS]
            results = dict(zip(syms, _pool.map(fetch_symbol, syms)))
            market = next((v["market"] for v in results.values() if "market" in v), None)
            return self.send_json(200, {"serverTime": time.time(), "market": market, "quotes": results})
        # Serve only the site itself, never other files in this folder (e.g. server.log).
        if parsed.path in ("/", "/index.html"):
            self.path = "/index.html"
            return super().do_GET()
        self.send_error(404)


def lan_ip():
    """IP of the network card used for the internet (UDP 'connect' sends no packets)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser(description="Stocks P/L local server")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--lan", action="store_true", help="listen on all interfaces so phones on the same Wi-Fi can connect")
    args = ap.parse_args()
    host = "0.0.0.0" if args.lan else "127.0.0.1"
    srv = ThreadingHTTPServer((host, args.port), Handler)
    log.info("Serving on http://127.0.0.1:%d  (Ctrl+C to stop)", args.port)
    if args.lan:
        ip = lan_ip()
        bar = "=" * 56
        print("\n%s\n  On your phone (same Wi-Fi) open:\n\n      http://%s:%d\n%s\n" % (bar, ip or "<this-PC-IP>", args.port, bar), flush=True)
        log.info("LAN mode on, phone URL http://%s:%d", ip, args.port)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log.info("Stopped")


if __name__ == "__main__":
    main()
