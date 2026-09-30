"""Download 1-minute Binance candles for the news-event study (research/events.py).

  python3 research/fetch_1m.py        # incremental: only fetches bars newer than what is on disk

BTCUSDT perp, XAUUSDT perp (listed 2025-12-11) and spot PAXGUSDT (tokenised gold,
the multi-year gold proxy before the perp existed). ~3 years, ~5 min on first run.
"""
import time
from concurrent.futures import ThreadPoolExecutor

import pandas as pd

from common import path
from fetch_binance import FUTURES, SPOT, get

START_1M = pd.Timestamp("2023-06-01", tz="UTC")
JOBS = [("binance", "BTCUSDT", FUTURES, 1500), ("binance", "XAUUSDT", FUTURES, 1500),
        ("binance_spot", "PAXGUSDT", SPOT, 1000)]


def fetch(source: str, symbol: str, api: str, limit: int) -> pd.DataFrame:
    file = path(source, symbol, "1m")
    old = pd.read_parquet(file) if file.exists() else None
    start = int(((old.index[-1] + pd.Timedelta(minutes=1)) if old is not None else START_1M).timestamp() * 1000)
    end = int(time.time() * 1000)
    rows = []
    while start < end:
        batch = get(f"{api}?symbol={symbol}&interval=1m&startTime={start}&endTime={end - 1}&limit={limit}")
        if not batch:
            break
        rows.extend(batch)
        start = batch[-1][0] + 60_000
        time.sleep(0.3 if api == FUTURES else 0.1)
    df = pd.DataFrame(rows).iloc[:, :6] if rows else pd.DataFrame(columns=range(6))
    df.columns = ["time", "open", "high", "low", "close", "volume"]
    df["time"] = pd.to_datetime(df["time"], unit="ms", utc=True)
    df = df.set_index("time").astype(float).iloc[:-1]  # drop the still-forming bar
    if old is not None:
        df = pd.concat([old, df])
    df = df[~df.index.duplicated(keep="last")].sort_index()
    df.to_parquet(file)
    print(f"{source} {symbol} 1m: {len(df):>8} bars  {df.index[0]} -> {df.index[-1]}", flush=True)
    return df


if __name__ == "__main__":
    with ThreadPoolExecutor(len(JOBS)) as pool:
        list(pool.map(lambda j: fetch(*j), JOBS))
