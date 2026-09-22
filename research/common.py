"""Shared helpers for the session research pipeline."""
import ssl
import urllib.request
from pathlib import Path

import certifi

import pandas as pd

# python.org builds ship without CA certs; use certifi's bundle for all urllib calls.
urllib.request.install_opener(urllib.request.build_opener(
    urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=certifi.where()))))

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)

START = pd.Timestamp("2022-09-01", tz="UTC")  # ~4 years of history
TIMEFRAMES = ["5m", "15m", "1h", "4h", "1d", "1w"]
PANDAS_RULE = {"5m": "5min", "15m": "15min", "1h": "1h", "4h": "4h", "1d": "1D", "1w": "W-MON"}


def path(source: str, symbol: str, tf: str) -> Path:
    return DATA / f"{source}_{symbol}_{tf}.parquet"


def resample(df: pd.DataFrame, tf: str) -> pd.DataFrame:
    """Resample an OHLCV frame indexed by UTC open time. Weekly bars open Monday 00:00 UTC."""
    rule = PANDAS_RULE[tf]
    kw = {"label": "left", "closed": "left"}
    out = df.resample(rule, **kw).agg(
        {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}
    )
    if tf == "1w":
        out = df.resample("W-SUN", **kw).agg(
            {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}
        )
        out.index = out.index + pd.Timedelta(days=1)  # label = Monday
    return out.dropna(subset=["open"])
