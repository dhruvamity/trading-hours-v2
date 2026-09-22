"""OPTIONAL: pull multi-year XAUUSD candles from a MetaTrader 5 terminal.

The `MetaTrader5` package only runs on Windows next to an installed, logged-in MT5 terminal,
so the research defaults to Dukascopy (fetch_dukascopy.py). Run this on Windows to cross-check
with your own broker's feed, then copy research/data/mt5_*.parquet back here and re-run
analyze.py with --gold-source mt5.

Note: MT5 bar times are in *broker server time* (usually UTC+2 / UTC+3 with DST).
Set SERVER_UTC_OFFSET_HOURS below to match your broker so bars are shifted to UTC.
"""
from datetime import datetime, timezone

import pandas as pd

from common import START, path

import MetaTrader5 as mt5  # noqa: E402  (Windows-only)

SYMBOL = "XAUUSD"  # some brokers use XAUUSD.m, GOLD, etc.
SERVER_UTC_OFFSET_HOURS = None  # None = infer from the broker's current tick time

TF_MAP = {"5m": mt5.TIMEFRAME_M5, "15m": mt5.TIMEFRAME_M15, "1h": mt5.TIMEFRAME_H1,
          "4h": mt5.TIMEFRAME_H4, "1d": mt5.TIMEFRAME_D1, "1w": mt5.TIMEFRAME_W1}

if not mt5.initialize():
    raise SystemExit(f"MT5 initialize failed: {mt5.last_error()}")
mt5.symbol_select(SYMBOL, True)

offset = SERVER_UTC_OFFSET_HOURS
if offset is None:
    tick = mt5.symbol_info_tick(SYMBOL)
    offset = round((tick.time - datetime.now(timezone.utc).timestamp()) / 3600)
    print(f"inferred broker offset: UTC{offset:+d}")

for tf, code in TF_MAP.items():
    rates = mt5.copy_rates_range(SYMBOL, code, START.to_pydatetime(), datetime.now(timezone.utc))
    df = pd.DataFrame(rates)
    df["time"] = pd.to_datetime(df["time"], unit="s", utc=True) - pd.Timedelta(hours=offset)
    df = df.rename(columns={"tick_volume": "volume"}).set_index("time")[["open", "high", "low", "close", "volume"]]
    df.to_parquet(path("mt5", SYMBOL, tf))
    print(f"mt5 {SYMBOL} {tf}: {len(df)} bars {df.index[0]} -> {df.index[-1]}")

mt5.shutdown()
