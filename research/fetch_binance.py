"""Download Binance klines for all research timeframes.

  python3 research/fetch_binance.py            # USD-M perps: BTCUSDT, XAUUSDT
  python3 research/fetch_binance.py --paxg     # spot PAXGUSDT (tokenised gold, multi-year gold proxy)
"""
import json
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import pandas as pd

from common import START, TIMEFRAMES, path

FUTURES = "https://fapi.binance.com/fapi/v1/klines"
SPOT = "https://api.binance.com/api/v3/klines"


def get(url: str):
    for attempt in range(6):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                return json.load(r)
        except Exception as exc:  # noqa: BLE001 - network retry
            wait = 2 ** attempt
            print(f"  retry in {wait}s: {exc}")
            time.sleep(wait)
    raise RuntimeError(url)


def fetch_range(symbol: str, tf: str, api: str, start: int, end: int) -> list:
    rows = []
    while start < end:
        batch = get(f"{api}?symbol={symbol}&interval={tf}&startTime={start}&endTime={end - 1}&limit=1500")
        if not batch:
            break
        rows.extend(batch)
        start = batch[-1][0] + 1
        time.sleep(0.12)
    return rows


def fetch(symbol: str, tf: str, api: str = FUTURES) -> pd.DataFrame:
    """Fetch in ~yearly chunks concurrently (the 5m series is hundreds of pages)."""
    start = int(START.timestamp() * 1000)
    end = int(time.time() * 1000)
    edges = list(range(start, end, 365 * 86_400_000)) + [end]
    with ThreadPoolExecutor(len(edges) - 1) as pool:
        parts = pool.map(lambda ab: fetch_range(symbol, tf, api, *ab), zip(edges[:-1], edges[1:]))
    rows = [row for part in parts for row in part]
    print(f"  {symbol} {tf}: {len(rows)} bars fetched", flush=True)
    df = pd.DataFrame(rows).iloc[:, :6]
    df.columns = ["time", "open", "high", "low", "close", "volume"]
    df["time"] = pd.to_datetime(df["time"], unit="ms", utc=True)
    df = df.drop_duplicates("time").sort_values("time").set_index("time").astype(float)
    # drop the still-forming last bar
    return df.iloc[:-1]


if __name__ == "__main__":
    spot = "--paxg" in sys.argv
    def job(args):
        sym, tf = args
        df = fetch(sym, tf, SPOT if spot else FUTURES)
        df.to_parquet(path("binance_spot" if spot else "binance", sym, tf))
        return sym, tf, df

    jobs = [(sym, tf) for sym in (["PAXGUSDT"] if spot else ["BTCUSDT", "XAUUSDT"]) for tf in TIMEFRAMES]
    with ThreadPoolExecutor(4) as pool:
        for sym, tf, df in pool.map(job, jobs):
            print(f"binance {'spot ' if spot else ''}{sym} {tf}: {len(df):>7} bars  {df.index[0]} -> {df.index[-1]}")
