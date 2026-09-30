"""Does the market stall in the days before big US news?  (5m / 15m / 1h / 4h / 1d)

  python3 research/pre_news.py      # after fetch_1m.py; writes research/output/pre_news_*.pkl

For every FOMC, CPI, NFP and PCE release (Sep 2023 ->), the 72 hours before and 24 hours after are
compared with the SAME weekday and New York clock time on up to 8 recent "clean" weeks: weeks with none
of those releases from 72h before to 24h after that moment. So weekends, sessions and time of day
are matched and 1.0 = a normal week.

Per window and timeframe:
  activity  = average absolute bar move (how much it moves per 5m/15m/1h/4h bar), vs clean weeks
  range     = high - low of the whole window, vs clean weeks
  trend     = efficiency ratio of 1h bars (1 = one-way, 0 = back and forth), minus clean weeks
Daily candles: the day before (D-1) and two days before (D-2): range / 20-day average range vs clean
weeks, share of inside days, and body / range (small body = indecision).
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from calendar_us import ET, build
from common import ROOT
from events import STUDY_START, load_btc, load_gold, one_per_minute, to_min

OUT = ROOT / "output"
BIG = ["FOMC", "CPI", "NFP", "PCE"]
TFS = {"5m": "5min", "15m": "15min", "1h": "1h", "4h": "4h"}
WINDOWS = {"D-3": (-72, -48), "D-2": (-48, -24), "D-1": (-24, 0), "last 6h": (-6, 0), "next 24h": (0, 24)}
N_BASE = 8
MAX_WEEKS_BACK = 30


class TF:
    def __init__(self, m1: pd.DataFrame, rule: str):
        r = m1.resample(rule, label="left", closed="left").agg(
            {"open": "first", "high": "max", "low": "min", "close": "last"}).dropna()
        self.t = r.index.values.astype("datetime64[m]").astype(np.int64)
        self.o, self.h, self.l, self.c = (r[k].to_numpy() for k in ("open", "high", "low", "close"))

    def stats(self, a: int, b: int):
        i, j = np.searchsorted(self.t, [a, b])
        if j - i < 3:
            return None
        prev = np.concatenate([[self.o[i]], self.c[i:j - 1]])
        moves = np.abs(self.c[i:j] - prev)
        ref = self.o[i]
        path = moves.sum()
        return dict(act=moves.mean() / ref, rng=(self.h[i:j].max() - self.l[i:j].min()) / ref,
                    er=abs(self.c[j - 1] - self.o[i]) / path if path > 0 else 0.0)


def clean_weeks(t: pd.Timestamp, busy: np.ndarray) -> list[int]:
    """Same weekday + NY clock time, 1..30 weeks back, with no big release from -72h to +24h."""
    local = t.tz_convert(ET)
    out = []
    for k in range(1, MAX_WEEKS_BACK + 1):
        d = (local - pd.Timedelta(weeks=k)).date()
        cand = to_min(pd.Timestamp.combine(d, local.time()).tz_localize(ET))
        lo, hi = np.searchsorted(busy, [cand - 72 * 60, cand + 24 * 60])
        if hi == lo:
            out.append(cand)
            if len(out) == N_BASE:
                break
    return out


def daily_bars(m1: pd.DataFrame) -> pd.DataFrame:
    """Trading days that roll at 22:00 UTC (~17:00-18:00 New York, gold's daily break)."""
    d = m1.resample("24h", offset="22h", label="left", closed="left").agg(
        {"open": "first", "high": "max", "low": "min", "close": "last"}).dropna()
    d["range"] = d.high - d.low
    d["atr20"] = d["range"].shift(3).rolling(20).mean()  # ends 3 days earlier, so D-2..D0 never feed it
    d["rel_range"] = d["range"] / d["atr20"]
    d["body"] = (d.close - d.open).abs() / d["range"].replace(0, np.nan)
    d["inside"] = (d.high <= d.high.shift(1)) & (d.low >= d.low.shift(1))
    return d


def study(m1: pd.DataFrame, events: pd.DataFrame, inst: str):
    tfs = {k: TF(m1, v) for k, v in TFS.items()}
    days = daily_bars(m1)
    day_start = days.index.values.astype("datetime64[m]").astype(np.int64)
    busy = np.sort(np.array([to_min(x) for x in events[events.kind.isin(BIG)].time]))
    busy_days = set()
    for x in events[events.kind.isin(BIG)].time:
        i = np.searchsorted(day_start, to_min(x), side="right") - 1
        busy_days.update({i - 2, i - 1, i})  # D-2, D-1, D0 of any big release are not "normal days"

    rows, prof_rows = [], []
    hours = np.arange(-72, 24)
    for ev in events[(events.time >= STUDY_START) & events.kind.isin(BIG)].itertuples():
        t0 = to_min(ev.time)
        base = clean_weeks(ev.time, busy)
        if len(base) < 4:
            continue
        row = dict(instrument=inst, kind=ev.kind, time=ev.time, n_base=len(base))
        for w, (a, b) in WINDOWS.items():
            for tf_name, tf in tfs.items():
                e = tf.stats(t0 + a * 60, t0 + b * 60)  # None when the window holds < 3 bars (e.g. 4h bars in 6h)
                bs = [x for x in (tf.stats(x + a * 60, x + b * 60) for x in base) if x is not None]
                if e is None or len(bs) < 3:
                    row[f"{w}|{tf_name}|act"] = np.nan
                    continue
                row[f"{w}|{tf_name}|act"] = e["act"] / np.median([x["act"] for x in bs])
                if tf_name == "1h":
                    row[f"{w}|rng"] = e["rng"] / np.median([x["rng"] for x in bs])
                    row[f"{w}|er"] = e["er"] - np.median([x["er"] for x in bs])
        if np.isnan(row.get("D-1|1h|act", np.nan)):
            continue  # no data for the key window (gaps)
        # daily candles
        i = np.searchsorted(day_start, t0, side="right") - 1
        base_days = [np.searchsorted(day_start, x, side="right") - 1 for x in base]
        for lag in (1, 2):
            e_i = i - lag
            b_i = [x - lag for x in base_days if x - lag >= 0 and (x - lag) not in busy_days]
            if e_i < 0 or len(b_i) < 3:
                continue
            e_row, b_rows = days.iloc[e_i], days.iloc[b_i]
            row[f"D-{lag}|1d|rel_range"] = e_row.rel_range / b_rows.rel_range.median()
            row[f"D-{lag}|1d|inside"] = float(e_row.inside)
            row[f"D-{lag}|1d|inside_base"] = b_rows.inside.mean()
            row[f"D-{lag}|1d|body"] = e_row.body - b_rows.body.median()
        rows.append(row)
        # hour-by-hour footprint (1h bar range vs the same hour in the clean weeks)
        h1 = tfs["1h"]
        prof = []
        for hh in hours:
            e = h1.stats(t0 + hh * 60, t0 + (hh + 1) * 60 + 1)
            bs = [h1.stats(x + hh * 60, x + (hh + 1) * 60 + 1) for x in base]
            bs = [x["rng"] for x in bs if x is not None]
            prof.append(e["rng"] / np.median(bs) if e is not None and bs and np.median(bs) > 0 else np.nan)
        prof_rows.append(dict(instrument=inst, kind=ev.kind, profile=prof))
    return pd.DataFrame(rows), pd.DataFrame(prof_rows)


def sign_p(k: int, n: int) -> float:
    """Two-sided sign test: chance of a split at least this lopsided if quiet/busy were 50/50."""
    if n == 0:
        return 1.0
    tail = sum(math.comb(n, i) for i in range(0, min(k, n - k) + 1)) / 2 ** n
    return min(1.0, 2 * tail)


def summarise(df: pd.DataFrame) -> pd.DataFrame:
    out = []
    groups = [(inst, k, g) for (inst, k), g in df.groupby(["instrument", "kind"])]
    groups += [(inst, "BIG3", g[g.kind.isin(["FOMC", "CPI", "NFP"])]) for inst, g in df.groupby("instrument")]
    for inst, kind, g in groups:
        r = dict(instrument=inst, kind=kind, n=len(g))
        for w in WINDOWS:
            for tf in TFS:
                col = f"{w}|{tf}|act"
                r[f"{w} {tf}"] = g[col].median()
            valid = g[f"{w}|1h|act"].dropna()
            quiet = int((valid < 1).sum())
            r[f"{w} quieter%"] = quiet / len(valid) if len(valid) else np.nan
            r[f"{w} p"] = sign_p(quiet, len(valid))
            r[f"{w} range"] = g[f"{w}|rng"].median()
            r[f"{w} trend"] = g[f"{w}|er"].median()
        for lag in (1, 2):
            if f"D-{lag}|1d|rel_range" in g:
                r[f"D-{lag} 1d range"] = g[f"D-{lag}|1d|rel_range"].median()
                r[f"D-{lag} 1d inside%"] = g[f"D-{lag}|1d|inside"].mean()
                r[f"D-{lag} 1d inside base%"] = g[f"D-{lag}|1d|inside_base"].mean()
                r[f"D-{lag} 1d body"] = g[f"D-{lag}|1d|body"].median()
        out.append(r)
    return pd.DataFrame(out)


def verdict(r) -> str:
    """Plain sentence for the days before this release (uses 1h activity, daily range and inside days)."""
    act = lambda w: np.nanmean([r[f"{w} 5m"], r[f"{w} 15m"], r[f"{w} 1h"]])  # noqa: E731 - intraday activity
    d1, d2 = act("D-1"), act("D-2")
    day = r.get("D-1 1d range", np.nan)
    inside, inside_base = r.get("D-1 1d inside%", np.nan), r.get("D-1 1d inside base%", np.nan)
    quiet_days = [w for w, v in (("2 days before", d2), ("the day before", d1)) if v <= 0.95]
    busy_days = [w for w, v in (("2 days before", d2), ("the day before", d1)) if v >= 1.08]
    stall = (d1 <= 0.95 or day <= 0.9) and r["D-1 quieter%"] >= 0.5
    verb = lambda days: " and ".join(days) + (" are" if len(days) > 1 else " is")  # noqa: E731
    if stall:
        extra = f", inside days {inside / inside_base:.0f}× as often" if inside_base and inside >= 1.5 * inside_base else ""
        return (f"Stalls: {verb(quiet_days or ['the day before'])} quieter than normal "
                f"(daily range {day:.2f}×{extra}). Smaller targets, fewer trades.")
    if busy_days:
        return f"No stall: {verb(busy_days)} busier than normal ({max(d1, d2):.2f}×); other data lands that week."
    return "No stall: the days before look like a normal week."


def main():
    events = one_per_minute(build())
    frames, profs = [], []
    for inst, loader in (("GOLD", load_gold), ("BTC", load_btc)):
        df, pf = study(loader(), events, inst)
        print(f"{inst}: {len(df)} releases measured", flush=True)
        frames.append(df)
        profs.append(pf)
    per = pd.concat(frames, ignore_index=True)
    prof = pd.concat(profs, ignore_index=True)
    per.to_pickle(OUT / "pre_news_per_event.pkl")
    prof.to_pickle(OUT / "pre_news_profiles.pkl")
    summ = summarise(per)
    summ["verdict"] = summ.apply(verdict, axis=1)
    summ.to_pickle(OUT / "pre_news_summary.pkl")
    print(summ[["instrument", "kind", "verdict"]].to_string())
    with pd.option_context("display.width", 250, "display.max_columns", 80, "display.max_rows", 200):
        print(summ.set_index(["instrument", "kind"]).T.round(2).to_string())


if __name__ == "__main__":
    main()
