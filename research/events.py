"""News-event study: how gold and BTC behave around US macro releases.

  python3 research/fetch_1m.py     # 1-minute candles (incremental)
  python3 research/events.py       # -> research/output/events_*.csv, src/lib/events.generated.ts

For every event (calendar_us.py) and instrument, 1-minute bars are measured against a
baseline: the same New York clock time on the previous 20 quiet weekdays (no tier-1/2
event within 4h). All sizes are ratios to that baseline, so 1.0 = a normal day.

Per event type it reports, in plain terms:
  * pre-news:   is the market quieter / choppier in the hours before the release?
  * spike:      how big the first 5 / 15 minutes are vs normal
  * whipsaw:    how often the first 30 min wicks both ways (hits +k and -k, k = half a
                normal 30-min range) vs the same test on quiet days
  * settle:     minutes after the release until 15-min range is back under 1.5x normal
  * follow:     after the first 15 / 30 minutes, how often the next 2h continue that direction
  * trade test: enter after 15 min in the direction of the first move, stop beyond the
                first-15-min extreme, exit at 2R or T+2h (win rate, average R)
  * day:        trendiness (efficiency ratio) of the rest of the day vs normal days
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

from calendar_us import EVENT_TYPES, ET, build
from common import DATA, ROOT

OUT = ROOT / "output"
OUT.mkdir(exist_ok=True)
TS_OUT = ROOT.parent / "src" / "lib" / "events.generated.ts"

STUDY_START = pd.Timestamp("2023-09-01", tz="UTC")
BASELINE_DAYS = 20
PROFILE_BINS = list(range(-180, 361, 15))  # 15-min buckets relative to the release


# ─── data ────────────────────────────────────────────────────────────────────
def load_gold() -> pd.DataFrame:
    """PAXG spot 1m until the XAUUSDT perp listed, then the perp. Weekends dropped."""
    paxg = pd.read_parquet(DATA / "binance_spot_PAXGUSDT_1m.parquet")
    perp = pd.read_parquet(DATA / "binance_XAUUSDT_1m.parquet")
    switch = perp.index[0] + pd.Timedelta(days=7)
    df = pd.concat([paxg[paxg.index < switch], perp[perp.index >= switch]])
    return df[df.index.dayofweek < 5]


def load_btc() -> pd.DataFrame:
    return pd.read_parquet(DATA / "binance_BTCUSDT_1m.parquet")


class Bars:
    """Minute-indexed numpy view with O(log n) window slicing."""

    def __init__(self, df: pd.DataFrame):
        df = df[df.index >= STUDY_START - pd.Timedelta(days=45)]
        self.t = df.index.values.astype("datetime64[m]").astype(np.int64)
        self.o, self.h, self.l, self.c = (df[k].to_numpy() for k in ("open", "high", "low", "close"))

    def window(self, start_min: int, end_min: int):
        i, j = np.searchsorted(self.t, [start_min, end_min])
        if j - i < 0.8 * (end_min - start_min):  # missing data (gaps, closed market)
            return None
        return slice(i, j)

    def stats(self, t0: int, a: int, b: int):
        """range (as fraction of price), efficiency ratio, net move for minutes [t0+a, t0+b)."""
        s = self.window(t0 + a, t0 + b)
        if s is None:
            return None
        hi, lo, c = self.h[s].max(), self.l[s].min(), self.c[s]
        # ~24 samples per window so trendiness is comparable between 15-min and 4-hour windows
        step = max(1, (b - a) // 24)
        sampled = c[step - 1::step] if len(c) >= step else c
        path = np.abs(np.diff(sampled)).sum() + abs(sampled[0] - self.o[s][0])
        ref = self.o[s][0]
        return dict(rng=(hi - lo) / ref, er=abs(c[-1] - self.o[s][0]) / path if path > 0 else 0.0,
                    move=(c[-1] - self.o[s][0]) / ref, hi=hi, lo=lo, open=self.o[s][0], close=c[-1])

    def price_at(self, t: int):
        i = np.searchsorted(self.t, t)
        return self.o[i] if i < len(self.t) and self.t[i] - t < 3 else None


def to_min(ts: pd.Timestamp) -> int:
    return int(ts.tz_convert("UTC").tz_localize(None).to_datetime64().astype("datetime64[m]").astype(np.int64))


# ─── per-event measurement ───────────────────────────────────────────────────
WINDOWS = {"pre330_30": (-330, -30), "pre120_60": (-120, -60), "pre60_30": (-60, -30), "pre30": (-30, 0), "first5": (0, 5),
           "first15": (0, 15), "first30": (0, 30), "m15_60": (15, 60), "m60_120": (60, 120),
           "m120_240": (120, 240), "m240_480": (240, 480)}


def whipsaw(bars: Bars, t0: int, k: float) -> bool | None:
    s = bars.window(t0, t0 + 30)
    p = bars.price_at(t0)
    if s is None or p is None:
        return None
    return (bars.h[s].max() - p) / p >= k and (p - bars.l[s].min()) / p >= k


def trade_after(bars: Bars, t0: int, wait: int, horizon: int = 120, target_r: float = 2.0):
    """Enter at t0+wait in the direction of the first `wait` minutes; stop beyond that range."""
    first = bars.stats(t0, 0, wait)
    s = bars.window(t0 + wait, t0 + horizon)
    if first is None or s is None:
        return None
    direction = 1 if first["close"] > first["open"] else -1
    entry = first["close"]
    stop = first["lo"] if direction == 1 else first["hi"]
    risk = abs(entry - stop)
    if risk <= 0:
        return None
    target = entry + direction * target_r * risk
    for hi, lo in zip(bars.h[s], bars.l[s]):
        if (direction == 1 and lo <= stop) or (direction == -1 and hi >= stop):
            return -1.0
        if (direction == 1 and hi >= target) or (direction == -1 and lo <= target):
            return target_r
    return direction * (bars.c[s][-1] - entry) / risk


def measure(bars: Bars, t0: int) -> dict | None:
    out = {}
    for name, (a, b) in WINDOWS.items():
        st = bars.stats(t0, a, b)
        if st is None:
            return None
        out[name] = st
    return out


def quiet_baseline_times(t: pd.Timestamp, busy: np.ndarray) -> list[int]:
    """Same NY clock time (as UTC minutes) on the previous quiet weekdays."""
    local = t.tz_convert(ET)
    res, d = [], local.date()
    for _ in range(60):
        d = d - pd.Timedelta(days=1).to_pytimedelta()
        if d.weekday() >= 5:
            continue
        cand = to_min(pd.Timestamp.combine(d, local.time()).tz_localize(ET))
        i = np.searchsorted(busy, cand)
        near = [busy[j] for j in (i - 1, i) if 0 <= j < len(busy)]
        if all(abs(cand - b) > 4 * 60 for b in near):
            res.append(cand)
            if len(res) == BASELINE_DAYS:
                break
    return res


def study(bars: Bars, events: pd.DataFrame, instrument: str) -> pd.DataFrame:
    busy = np.sort(np.array([to_min(ts) for ts in events[(events.tier <= 2) | (events.kind == "CLAIMS")].time]))

    rows = []
    for ev in events[(events.time >= STUDY_START)].itertuples():
        t0 = to_min(ev.time)
        m = measure(bars, t0)
        if m is None:
            continue
        base_times = quiet_baseline_times(ev.time, busy)
        base = [measure(bars, b) for b in base_times]
        base = [b for b in base if b is not None]
        if len(base) < 8:
            continue
        row = dict(instrument=instrument, kind=ev.kind, time=ev.time)
        for w in WINDOWS:
            med_rng = np.median([b[w]["rng"] for b in base])
            row[f"{w}_rr"] = m[w]["rng"] / med_rng if med_rng > 0 else np.nan
            row[f"{w}_er"] = m[w]["er"]
            row[f"{w}_er_base"] = np.median([b[w]["er"] for b in base])
        k = 0.5 * np.median([b["first30"]["rng"] for b in base])
        row["whipsaw"] = whipsaw(bars, t0, k)
        bw = [whipsaw(bars, b, k) for b in base_times]
        row["whipsaw_base"] = np.mean([x for x in bw if x is not None]) if bw else np.nan
        d15 = np.sign(m["first15"]["move"])
        d30 = np.sign(m["first30"]["move"])
        after15 = bars.stats(t0, 15, 135)
        after30 = bars.stats(t0, 30, 150)
        row["follow15"] = bool(after15 and np.sign(after15["move"]) == d15 and d15 != 0)
        row["follow30"] = bool(after30 and np.sign(after30["move"]) == d30 and d30 != 0)
        row["trade15_r"] = trade_after(bars, t0, 15)
        row["trade30_r"] = trade_after(bars, t0, 30, horizon=150)
        # footprint: 15-min range ratio per bucket
        for a in PROFILE_BINS[:-1]:
            st = bars.stats(t0, a, a + 15)
            bs = [bars.stats(b, a, a + 15) for b in base_times[:12]]
            bs = [x["rng"] for x in bs if x is not None]
            row[f"p{a}"] = st["rng"] / np.median(bs) if st and bs and np.median(bs) > 0 else np.nan
        rows.append(row)
    return pd.DataFrame(rows)


def settle_minute(profile: pd.Series, threshold: float = 1.5) -> int:
    """First bucket at/after the release from which the median range stays under threshold."""
    post = [(int(k[1:]), v) for k, v in profile.items() if int(k[1:]) >= 0]
    for i, (minute, _) in enumerate(post):
        if all(v < threshold for _, v in post[i:i + 2]):
            return minute
    return post[-1][0]


def danger_start(profile: pd.Series, threshold: float = 1.3) -> int:
    pre = [(int(k[1:]), v) for k, v in profile.items() if int(k[1:]) < 0]
    start = 0
    for minute, v in reversed(pre):
        if v >= threshold:
            start = minute
        else:
            break
    return start


def summarise(df: pd.DataFrame) -> pd.DataFrame:
    prof_cols = [c for c in df.columns if c.startswith("p") and c[1:].lstrip("-").isdigit()]
    rows = []
    for (inst, kind), g in df.groupby(["instrument", "kind"]):
        prof = g[prof_cols].median()
        t15 = g["trade15_r"].dropna()
        t30 = g["trade30_r"].dropna()
        rows.append(dict(
            instrument=inst, kind=kind, name=EVENT_TYPES[kind][0], tier=EVENT_TYPES[kind][1], n=len(g),
            pre_session_range=g["pre330_30_rr"].median(),
            pre_session_chop=(g["pre330_30_er"] - g["pre330_30_er_base"]).median(),
            pre60_range=g["pre60_30_rr"].median(), pre30_range=g["pre30_rr"].median(),
            pre120_chop=(g["pre120_60_er"] - g["pre120_60_er_base"]).median(),
            first5_range=g["first5_rr"].median(), first15_range=g["first15_rr"].median(),
            first30_range=g["first30_rr"].median(),
            whipsaw=g["whipsaw"].mean(), whipsaw_base=g["whipsaw_base"].mean(),
            settle_min=settle_minute(prof), danger_from_min=danger_start(prof),
            follow15=g["follow15"].mean(), follow30=g["follow30"].mean(),
            trade15_win=(t15 > 0).mean(), trade15_avg_r=t15.mean(),
            trade15_t=t15.mean() / (t15.std(ddof=1) / math.sqrt(len(t15))) if len(t15) > 2 and t15.std() > 0 else 0.0,
            trade30_win=(t30 > 0).mean(), trade30_avg_r=t30.mean(),
            rest_of_day_er=g["m240_480_er"].median(), rest_of_day_er_base=g["m240_480_er_base"].median(),
            m120_240_range=g["m120_240_rr"].median(),
            profile=[round(float(v), 2) if not math.isnan(v) else None for v in prof.values],
        ))
    return pd.DataFrame(rows)


def advice(r) -> str:
    """One plain sentence per event type, from the numbers."""
    if r.n < 8:
        return "Too few events to judge — treat like a medium release."
    big = r.first15_range >= 2.0
    whip = r.whipsaw >= r.whipsaw_base + 0.15 and r.first15_range >= 1.6
    # only call it a pattern when the test result is ~2 standard errors from zero
    follows = r.trade15_avg_r >= 0.15 and r.follow15 >= 0.55 and r.trade15_t >= 2
    fades = r.trade15_avg_r <= -0.1 and r.trade15_t <= -2
    if not big and not whip:
        return "Small effect. A short pause around the release is enough."
    if follows:
        return "Skip the spike, then trade WITH the first 15-min direction — it has tended to continue."
    if fades:
        return "Skip it. The first move has often reversed — chasing it loses."
    if whip:
        return "Skip it. Wicks both ways are common and the first move is a coin flip."
    if not big:
        return "Moderate. Pause around the release; the first move is not a signal."
    return "Big but directionless. Stand aside until the range calms down."


def ts_literal(v):
    if isinstance(v, float) and math.isnan(v):
        return None
    if isinstance(v, (np.floating, float)):
        return round(float(v), 3)
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.bool_,)):
        return bool(v)
    return v


def pre_news_block(pre: pd.DataFrame | None) -> dict:
    """Days-before-release behaviour from pre_news.py, keyed like EVENT_PROFILES."""
    out: dict = {"GOLD": {}, "BTC": {}}
    if pre is None:
        return out
    avg = lambda r, w: float(np.nanmean([r[f"{w} 5m"], r[f"{w} 15m"], r[f"{w} 1h"]]))  # noqa: E731
    for _, r in pre[pre.kind != "BIG3"].iterrows():
        out[r.instrument][r.kind] = {
            "n": int(r.n), "d2": round(avg(r, "D-2"), 3), "d1": round(avg(r, "D-1"), 3),
            "d1Daily": ts_literal(r.get("D-1 1d range", np.nan)), "insideD1": ts_literal(r.get("D-1 1d inside%", np.nan)),
            "insideBase": ts_literal(r.get("D-1 1d inside base%", np.nan)), "next24": round(float(r["next 24h 1h"]), 3),
            "quietShareD1": round(float(r["D-1 quieter%"]), 3), "stall": r.verdict.startswith("Stalls"),
            "verdict": r.verdict,
        }
    return out


def write_ts(summary: pd.DataFrame, events: pd.DataFrame, data_through: pd.Timestamp, pre: pd.DataFrame | None = None):
    kinds = list(EVENT_TYPES)
    profiles: dict = {"GOLD": {}, "BTC": {}}
    for r in summary.itertuples():
        profiles[r.instrument][r.kind] = {
            "kind": r.kind, "name": r.name, "tier": int(r.tier), "n": int(r.n),
            "blockBefore": int(-r.danger_from_min), "blockAfter": int(r.settle_min),
            "preSessionRange": ts_literal(r.pre_session_range), "preSessionChop": ts_literal(r.pre_session_chop),
            "first5Range": ts_literal(r.first5_range), "first15Range": ts_literal(r.first15_range),
            "whipsaw": ts_literal(r.whipsaw), "whipsawBase": ts_literal(r.whipsaw_base),
            "follow15": ts_literal(r.follow15), "follow30": ts_literal(r.follow30),
            "trade15Win": ts_literal(r.trade15_win), "trade15AvgR": ts_literal(r.trade15_avg_r),
            "trade30Win": ts_literal(r.trade30_win), "trade30AvgR": ts_literal(r.trade30_avg_r),
            "restOfDayEr": ts_literal(r.rest_of_day_er), "restOfDayErBase": ts_literal(r.rest_of_day_er_base),
            "advice": advice(r),
            "profile": r.profile,
        }
    cal_from = pd.Timestamp.now(tz="UTC") - pd.Timedelta(days=14)
    cal = [{"time": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "kind": k, "name": n, "tier": int(tr)}
           for t, k, n, tr in events.loc[events.time >= cal_from, ["time", "kind", "name", "tier"]].itertuples(index=False)]
    meta = {
        "generated": pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%d"),
        "dataThrough": data_through.strftime("%Y-%m-%d"),
        "studyFrom": STUDY_START.strftime("%Y-%m-%d"),
        "calendarThrough": events.time.max().strftime("%Y-%m-%d"),
        "baselineDays": BASELINE_DAYS,
        "profileBins": PROFILE_BINS[:-1],
        "goldSource": "Binance PAXGUSDT spot 1m until the XAUUSDT perp listed (Dec 2025), then XAUUSDT 1m",
    }
    kind_union = " | ".join(f'"{k}"' for k in kinds)
    body = f"""// Generated by research/events.py — do not edit by hand.
export type EventKind = {kind_union};
export type ProfileAsset = "GOLD" | "BTC";
export type CalendarEvent = {{ time: string; kind: EventKind; name: string; tier: number }};
export type EventProfile = {{
  kind: EventKind;
  name: string;
  tier: number;
  /** events measured */
  n: number;
  /** minutes before the release the market is already abnormal (stand aside from here) */
  blockBefore: number;
  /** minutes after the release until 15-min range is back under 1.5x normal */
  blockAfter: number;
  /** ranges are ratios to the same NY clock time on quiet days (1 = normal) */
  preSessionRange: number | null;
  /** efficiency-ratio difference of the 5h before the release vs normal (negative = choppier) */
  preSessionChop: number | null;
  first5Range: number | null;
  first15Range: number | null;
  /** share of events whose first 30 min wicked both ways; whipsawBase = same test on quiet days */
  whipsaw: number | null;
  whipsawBase: number | null;
  follow15: number | null;
  follow30: number | null;
  trade15Win: number | null;
  trade15AvgR: number;
  trade30Win: number | null;
  trade30AvgR: number | null;
  restOfDayEr: number | null;
  restOfDayErBase: number | null;
  advice: string;
  /** 15-min range ratios from -180 to +345 minutes around the release */
  profile: (number | null)[];
}};

export const EVENTS_META = {json.dumps(meta, indent=2)} as const;

export const EVENT_PROFILES: Record<ProfileAsset, Partial<Record<EventKind, EventProfile>>> = {json.dumps(profiles, indent=1, default=ts_literal)};

/** How the 1-3 days BEFORE a big release behave (research/pre_news.py). Ratios: 1 = a clean week. */
export type PreNews = {{
  n: number;
  /** average 5m/15m/1h activity, 2 days before and the day before */
  d2: number;
  d1: number;
  /** day-before daily range vs clean weeks */
  d1Daily: number | null;
  /** share of inside days the day before, and in clean weeks */
  insideD1: number | null;
  insideBase: number | null;
  /** 1h activity in the 24h after the release */
  next24: number;
  quietShareD1: number;
  stall: boolean;
  verdict: string;
}};

export const PRE_NEWS: Record<ProfileAsset, Partial<Record<EventKind, PreNews>>> = {json.dumps(pre_news_block(pre), indent=1)};

export const EVENT_CALENDAR: CalendarEvent[] = {json.dumps(cal, indent=0)};
"""
    TS_OUT.write_text(body)
    print(f"wrote {TS_OUT.relative_to(ROOT.parent)} ({len(cal)} calendar events)")


PRIORITY = ["FOMC", "CPI", "NFP", "JACKSON", "PCE", "GDP", "PPI", "RETAIL", "ISM_MFG", "ISM_SERV", "JOLTS",
            "QUARTER_END", "CLAIMS", "NVDA", "MONTH_END"]


def one_per_minute(events: pd.DataFrame) -> pd.DataFrame:
    """Releases sharing a timestamp (e.g. claims on CPI day) are measured once, under the biggest one."""
    ranked = events.assign(_p=events.kind.map(PRIORITY.index)).sort_values(["time", "_p"])
    return ranked.drop_duplicates("time").drop(columns="_p")


def render_only():
    """Rebuild the TS file and HTML page from the saved study (no candle crunching)."""
    all_events = build()
    per_event = pd.read_pickle(OUT / "events_per_event.pkl")
    summary = summarise(per_event)
    summary["advice"] = summary.apply(advice, axis=1)
    data_through = min(pd.read_parquet(DATA / "binance_XAUUSDT_1m.parquet", columns=["close"]).index[-1],
                       pd.read_parquet(DATA / "binance_BTCUSDT_1m.parquet", columns=["close"]).index[-1])
    pre, pre_prof = load_pre_news()
    write_ts(summary, all_events, data_through, pre)
    from news_report import write_news_html
    write_news_html(summary, per_event, data_through, pre, pre_prof)


def load_pre_news():
    """Outputs of pre_news.py, if it has been run."""
    s, p = OUT / "pre_news_summary.pkl", OUT / "pre_news_profiles.pkl"
    return (pd.read_pickle(s) if s.exists() else None), (pd.read_pickle(p) if p.exists() else None)


def main():
    all_events = build()
    all_events.to_csv(OUT / "events_calendar.csv", index=False)
    events = one_per_minute(all_events)
    frames, data_through = [], None
    for inst, loader in (("GOLD", load_gold), ("BTC", load_btc)):
        df = loader()
        data_through = df.index[-1] if data_through is None else min(data_through, df.index[-1])
        bars = Bars(df)
        per_event = study(bars, events, inst)
        print(f"{inst}: {len(per_event)} events measured", flush=True)
        frames.append(per_event)
    per_event = pd.concat(frames, ignore_index=True)
    per_event.to_pickle(OUT / "events_per_event.pkl")
    summary = summarise(per_event)
    summary["advice"] = summary.apply(advice, axis=1)
    summary.drop(columns="profile").to_csv(OUT / "events_summary.csv", index=False)
    summary.to_pickle(OUT / "events_summary.pkl")
    with pd.option_context("display.width", 250, "display.max_columns", 40):
        print(summary.drop(columns=["profile", "advice"]).round(2).to_string())
        print(summary[["instrument", "kind", "advice"]].to_string())
    pre, pre_prof = load_pre_news()
    write_ts(summary, all_events, data_through, pre)
    from news_report import write_news_html
    write_news_html(summary, per_event, data_through, pre, pre_prof)


if __name__ == "__main__":
    import sys

    render_only() if "--render" in sys.argv else main()
