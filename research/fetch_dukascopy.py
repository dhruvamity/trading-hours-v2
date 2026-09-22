"""Download multi-year spot gold (XAUUSD) 1-minute candles from Dukascopy's public datafeed,
then resample to the research timeframes.

Binance's XAUUSDT perp only exists since 2025-12-11, so this is the multi-year gold history.
(MetaTrader5's Python library is Windows-only; see fetch_mt5.py for that alternative.)

Usage: python3 research/fetch_dukascopy.py
"""
import lzma
import struct
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import pandas as pd

from common import DATA, START, TIMEFRAMES, path, resample

SYMBOL = "XAUUSD"
SCALE = 1000.0  # Dukascopy stores XAUUSD prices as integer * 1000
CACHE = DATA / "dukascopy_raw"
CACHE.mkdir(exist_ok=True)
FAILED: list[pd.Timestamp] = []


def day_file(day: pd.Timestamp) -> pd.DataFrame | None:
    cached = CACHE / f"{day:%Y%m%d}.bi5"
    if not cached.exists():
        url = (f"https://datafeed.dukascopy.com/datafeed/{SYMBOL}/"
               f"{day.year}/{day.month - 1:02d}/{day.day:02d}/BID_candles_min_1.bi5")
        for attempt in range(8):
            try:
                with urllib.request.urlopen(url, timeout=90) as r:
                    body = r.read()
                tmp = cached.with_suffix(".part")
                tmp.write_bytes(body)
                tmp.replace(cached)
                break
            except urllib.error.HTTPError as exc:
                if exc.code == 404:
                    cached.write_bytes(b"")
                    break
                # 429 = rate limited: back off hard
                time.sleep(30 * (attempt + 1) if exc.code == 429 else 2 ** attempt)
            except Exception:  # noqa: BLE001 - network retry
                time.sleep(2 ** attempt)
    if not cached.exists():
        FAILED.append(day)
        return None
    raw = cached.read_bytes()
    if not raw:
        return None
    data = lzma.decompress(raw)
    recs = [struct.unpack(">5if", data[i:i + 24]) for i in range(0, len(data), 24)]
    df = pd.DataFrame(recs, columns=["sec", "open", "close", "low", "high", "volume"])
    # Dukascopy fills closed-market minutes with flat zero-volume candles; drop them.
    df = df[df["volume"] > 0]
    if df.empty:
        return None
    df["time"] = day + pd.to_timedelta(df["sec"], unit="s")
    df[["open", "high", "low", "close"]] /= SCALE
    return df.set_index("time")[["open", "high", "low", "close", "volume"]]


if __name__ == "__main__":
    days = pd.date_range(START, pd.Timestamp.now(tz="UTC").normalize() - pd.Timedelta(days=1), freq="D")
    days = days[days.dayofweek != 5]  # gold is shut all of Saturday (UTC)
    with ThreadPoolExecutor(4) as pool:
        frames = [f for f in pool.map(day_file, days) if f is not None]
    if FAILED:
        raise SystemExit(f"{len(FAILED)} days failed to download (e.g. {FAILED[:3]}); re-run to resume")
    m1 = pd.concat(frames).sort_index()
    m1 = m1[~m1.index.duplicated()]
    print(f"dukascopy {SYMBOL} 1m: {len(m1)} bars {m1.index[0]} -> {m1.index[-1]}")
    for tf in TIMEFRAMES:
        out = resample(m1, tf)
        out.to_parquet(path("dukascopy", SYMBOL, tf))
        print(f"dukascopy {SYMBOL} {tf}: {len(out):>7} bars")
