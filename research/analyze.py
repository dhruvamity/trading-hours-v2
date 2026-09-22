"""IST session research for BTCUSDT perp and gold (XAUUSDT perp / XAUUSD spot).

Builds per-weekday, per-30-minute IST slot statistics from 4 years of candles, weights recent
weeks more heavily, classifies each slot into PRIME / SWING ENTRY / SMALL TRADES / NO TRADE /
CLOSED, validates the result out-of-sample, and writes:

  * src/lib/timetable.generated.ts  -> consumed by the terminal UI
  * public/report.html              -> the in-depth research report
  * research/output/*.csv           -> raw slot statistics

Usage: python3 research/analyze.py [--gold-source dukascopy|mt5] [--half-life 52]
"""
from __future__ import annotations

import argparse
import base64
import io
import json
from dataclasses import dataclass
from zoneinfo import ZoneInfo

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from numpy.lib.stride_tricks import sliding_window_view  # noqa: E402

from common import ROOT, path  # noqa: E402

REPO = ROOT.parent
OUT = ROOT / "output"
OUT.mkdir(exist_ok=True)

IST = pd.Timedelta(hours=5, minutes=30)
SLOT_MIN = 30
SLOTS = 24 * 60 // SLOT_MIN
DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
REGIMES = ["summer", "winter"]  # US daylight time in effect / not
NY, LDN = ZoneInfo("America/New_York"), ZoneInfo("Europe/London")
H_INTRA = 12  # 60 min forward horizon on 5m bars
H_SWING = 16  # 240 min forward horizon on 15m bars
WEEKEND_FROM = ("Saturday", 4 * 60)  # after Friday's US session ends: excluded
OOS_MONTHS = 12


# ----------------------------------------------------------------------------------------------
# data
# ----------------------------------------------------------------------------------------------

def load(source: str, symbol: str, tf: str) -> pd.DataFrame:
    return pd.read_parquet(path(source, symbol, tf))


GOLD_HISTORY = {"dukascopy": ("dukascopy", "XAUUSD"), "mt5": ("mt5", "XAUUSD"), "blend": ("binance_spot", "PAXGUSDT")}


def gold_session_mask(idx: pd.DatetimeIndex) -> np.ndarray:
    """True while the gold market is open: Sun 18:00 ET -> Fri 17:00 ET, minus the daily 17:00-18:00 ET break."""
    et = idx.tz_convert(NY)
    dow, hr = et.dayofweek, et.hour
    closed = (hr == 17) | (dow == 5) | ((dow == 4) & (hr >= 17)) | ((dow == 6) & (hr < 18))
    return ~np.asarray(closed)


def gold_session_only(df: pd.DataFrame, tf: str) -> pd.DataFrame:
    """Binance XAUUSDT perp and PAXG trade 24/7; keep intraday bars only while the real gold market is open,
    so every gold feed shares the same session (weekend / daily-break slots come out as CLOSED)."""
    return df[gold_session_mask(df.index)] if tf in ("5m", "15m") else df


def dukascopy_cached_1m() -> pd.DataFrame | None:
    """Whatever Dukascopy days are already cached locally (a partial download)."""
    from fetch_dukascopy import CACHE, day_file
    days = [pd.Timestamp(f.stem, tz="UTC") for f in CACHE.glob("*.bi5") if f.stat().st_size]
    frames = [f for f in map(day_file, sorted(days)) if f is not None]
    return pd.concat(frames).sort_index() if frames else None


def paxg_fine_tick_start(px: pd.DataFrame) -> pd.Timestamp:
    """PAXG traded on a $1 tick until 2025 (half the 5m bars flat, heavy bid-ask bounce).
    Return the first month in which most closes carry cents, i.e. the tick became fine."""
    cents = (np.abs(px["close"] - px["close"].round()) > 1e-9).groupby(px.index.tz_localize(None).to_period("M")).mean()
    return cents[cents > 0.5].index[0].start_time.tz_localize("UTC")


def paxg_quality(px: pd.DataFrame) -> pd.DataFrame:
    q = px.index.tz_localize(None).to_period("Q")
    r = np.log(px["close"]).diff()
    return pd.DataFrame({
        "flat 5m bars %": (px["close"] == px["open"]).groupby(q).mean() * 100,
        "5m return autocorr": r.groupby(q).apply(lambda x: x.autocorr()),
    }).reset_index(names="quarter").assign(quarter=lambda d: d["quarter"].astype(str))


def load_history(source: str, tf: str, info: dict | None = None) -> pd.DataFrame:
    if source != "blend" or tf not in ("5m", "15m"):
        return gold_session_only(load(*GOLD_HISTORY[source], tf), tf)
    # blend: Dukascopy spot where cached, then PAXG only once its tick became fine; gaps stay empty
    from common import resample
    px = gold_session_only(load("binance_spot", "PAXGUSDT", tf), tf)
    fine = paxg_fine_tick_start(px)
    duk = dukascopy_cached_1m()
    parts = []
    if duk is not None:
        d = gold_session_only(resample(duk, tf), tf)
        parts.append(d[d.index < fine])
    parts.append(px[px.index >= fine])
    if info is not None:
        info["paxg_fine_from"] = fine
        info["dukascopy_to"] = parts[0].index[-1] if duk is not None else None
        info["paxg_quality"] = paxg_quality(px)
    return pd.concat(parts)


def gold_frames(source: str) -> tuple[dict[str, pd.DataFrame], dict]:
    """Long-history gold feed spliced with Binance XAUUSDT perp from its listing onwards."""
    frames, info = {}, {"source": source}
    perp_5m = load("binance", "XAUUSDT", "5m")
    splice = perp_5m.index[0] + pd.Timedelta(days=7)  # skip the listing week
    info["splice"] = splice
    for tf in ["5m", "15m", "1d"]:
        hist = load_history(source, tf, info)
        perp = gold_session_only(load("binance", "XAUUSDT", tf), tf)
        frames[tf] = pd.concat([hist[hist.index < splice], perp[perp.index >= splice]])
        info[f"hist_{tf}"] = hist
        info[f"perp_{tf}"] = perp
    return frames, info


def atr_reference(daily: pd.DataFrame) -> pd.Series:
    """20-day mean true range of weekday sessions, lagged one day (no look-ahead)."""
    d = daily[daily.index.dayofweek < 5].copy()
    prev = d["close"].shift()
    tr = pd.concat([d["high"] - d["low"], (d["high"] - prev).abs(), (d["low"] - prev).abs()], axis=1).max(axis=1)
    atr = tr.rolling(20, min_periods=10).mean().shift()
    full = atr.reindex(pd.date_range(atr.index[0], daily.index[-1] + pd.Timedelta(days=1), freq="D", tz="UTC"))
    return full.ffill()


def grid(df: pd.DataFrame, freq: str) -> pd.DataFrame:
    idx = pd.date_range(df.index[0].floor("D"), df.index[-1].ceil("D"), freq=freq, tz="UTC")
    return df.reindex(idx)


# ----------------------------------------------------------------------------------------------
# per-slot, per-date observations
# ----------------------------------------------------------------------------------------------

def forward(g: pd.DataFrame, h: int):
    o, hi, lo, c = (g[k].to_numpy() for k in ("open", "high", "low", "close"))
    n = len(g) - h + 1
    hw, lw, cw = (sliding_window_view(a, h)[:n] for a in (hi, lo, c))
    valid = (~np.isnan(cw)).sum(1)
    o0 = o[:n]
    last = pd.DataFrame(cw).ffill(axis=1).to_numpy()[:, -1]
    up = np.nanmax(hw, 1) - o0
    dn = o0 - np.nanmin(lw, 1)
    net = last - o0
    steps = np.abs(np.diff(cw, axis=1))
    path_len = np.nansum(steps, 1) + np.abs(cw[:, 0] - o0)
    return dict(up=up, dn=dn, net=net, path=path_len, valid=valid / h, o0=o0)


def observations(m5: pd.DataFrame, m15: pd.DataFrame, daily: pd.DataFrame) -> pd.DataFrame:
    g5, g15 = grid(m5, "5min"), grid(m15, "15min")
    f5, f15 = forward(g5, H_INTRA), forward(g15, H_SWING)
    slot_range = forward(g5, SLOT_MIN // 5)
    t5 = g5.index[: len(f5["up"])]
    start_mask = (t5.minute % SLOT_MIN) == 0
    t = t5[start_mask]
    pick = lambda d: {k: v[: len(start_mask)][start_mask] for k, v in d.items()}  # noqa: E731
    a, sr = pick(f5), pick(slot_range)

    # swing horizon from the 15m grid
    pos15 = g15.index.get_indexer(t)
    ok15 = (pos15 >= 0) & (pos15 < len(f15["up"]))
    sw = {k: np.where(ok15, v[np.clip(pos15, 0, len(v) - 1)], np.nan) for k, v in f15.items()}

    # previous 30 minutes (momentum follow-through)
    c5 = g5["close"].to_numpy()
    o5 = g5["open"].to_numpy()
    i5 = np.flatnonzero(start_mask)
    prev_net = np.where(i5 >= 6, c5[i5 - 1] - o5[np.maximum(i5 - 6, 0)], np.nan)

    atr = atr_reference(daily).reindex(t.floor("D")).to_numpy()
    vol = g5["volume"].fillna(0).to_numpy()
    vol_slot = sliding_window_view(vol, SLOT_MIN // 5)[: len(t5)][start_mask].sum(1)

    df = pd.DataFrame({
        "t": t,
        "atr": atr,
        "cov": a["valid"],
        "slot_cov": sr["valid"],
        "range30": (sr["up"] + sr["dn"]) / atr,
        "range60": (a["up"] + a["dn"]) / atr,
        "disp60": np.abs(a["net"]) / atr,
        "net60": a["net"] / atr,
        "movepct": np.abs(a["net"]) / a["o0"] * 100,
        "er60": np.abs(a["net"]) / a["path"],
        "clar60": np.abs(a["up"] - a["dn"]) / (a["up"] + a["dn"]),
        "disp240": np.abs(sw["net"]) / atr,
        "er240": np.abs(sw["net"]) / sw["path"],
        "cov240": sw["valid"],
        "ft": np.where(np.isnan(prev_net) | (prev_net == 0) | (a["net"] == 0), np.nan,
                       (np.sign(prev_net) == np.sign(a["net"])).astype(float)),
        "vol": vol_slot,
    })
    ist = df["t"] + IST
    df["date"] = ist.dt.normalize().dt.tz_localize(None)
    df["day"] = ist.dt.dayofweek.map(dict(enumerate(DAYS)))
    df["slot"] = (ist.dt.hour * 60 + ist.dt.minute) // SLOT_MIN
    ny = df["t"].dt.tz_convert(NY).map(lambda x: bool(x.dst()))
    ldn = df["t"].dt.tz_convert(LDN).map(lambda x: bool(x.dst()))
    df["regime"] = np.where(ny, "summer", "winter")
    df["dst_mismatch"] = ny != ldn
    df.loc[df["slot_cov"] < 0.5, ["range30"]] = np.nan
    bad = (df["cov"] < 0.8) | df["atr"].isna()
    df.loc[bad, ["range60", "disp60", "net60", "movepct", "er60", "clar60", "ft"]] = np.nan
    df.loc[df["cov240"] < 0.8, ["disp240", "er240"]] = np.nan
    # daily volume share (relative participation)
    df["vol_share"] = df["vol"] / df.groupby("date")["vol"].transform("sum")
    return df


# ----------------------------------------------------------------------------------------------
# aggregation
# ----------------------------------------------------------------------------------------------

METRICS = ["range30", "range60", "disp60", "movepct", "er60", "clar60", "disp240", "er240", "ft", "vol_share", "net60"]


def winsorize(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    for m in ["range30", "range60", "disp60", "movepct", "disp240"]:
        hi = df[m].quantile(0.99)
        df[m] = df[m].clip(upper=hi)
    return df


def weekly_weights(dates: pd.Series, end: pd.Timestamp, half_life: float) -> pd.Series:
    age_weeks = (end - dates).dt.days / 7.0
    return 0.5 ** (age_weeks / half_life)


def aggregate(obs: pd.DataFrame, end: pd.Timestamp, half_life: float) -> pd.DataFrame:
    df = obs[(obs["date"] <= end) & ~obs["dst_mismatch"]].copy()
    df["w"] = weekly_weights(df["date"], end, half_life)
    # within-day relative rank of displacement -> consistency
    df["rank"] = df.groupby("date")["disp60"].rank(pct=True)
    df["beats"] = (df["rank"] > 0.5).astype(float).where(df["rank"].notna())
    rows = []
    for (regime, day, slot), g in df.groupby(["regime", "day", "slot"]):
        rec = {"regime": regime, "day": day, "slot": slot}
        w = g["w"]
        rec["coverage"] = float(np.average(g["slot_cov"].fillna(0), weights=w))
        for m in METRICS + ["beats"]:
            v = g[m]
            ok = v.notna()
            rec[m] = float(np.average(v[ok], weights=w[ok])) if ok.sum() >= 5 else np.nan
        ok = g["net60"].notna()
        if ok.sum() >= 5:
            ww = w[ok] / w[ok].sum()
            mean = float((ww * g["net60"][ok]).sum())
            var = float((ww * (g["net60"][ok] - mean) ** 2).sum())
            neff = w[ok].sum() ** 2 / (w[ok] ** 2).sum()
            rec["bias_t"] = mean / np.sqrt(var / neff) if var > 0 else 0.0
            rec["p_up"] = float((ww * (g["net60"][ok] > 0)).sum())
        rec["n"] = int(ok.sum())
        rec["neff"] = float(w[ok].sum() ** 2 / (w[ok] ** 2).sum()) if ok.any() else 0.0
        rows.append(rec)
    return pd.DataFrame(rows)


# ----------------------------------------------------------------------------------------------
# classification
# ----------------------------------------------------------------------------------------------

@dataclass
class Params:
    no_trade_pct: float = 0.42     # intraday score below this pool percentile -> NO TRADE
    prime_pct: float = 0.85        # score at/above this percentile ...
    prime_consistency: float = 0.55  # ... and beats the day's median this often -> PRIME
    swing_pct: float = 0.93        # swing score percentile -> SWING ENTRY candidate


def in_scope(day: str, slot: int) -> bool:
    if day == "Sunday":
        return False
    if day == WEEKEND_FROM[0]:
        return slot * SLOT_MIN < WEEKEND_FROM[1]
    return True


def score_table(agg: pd.DataFrame) -> pd.DataFrame:
    df = agg.copy()
    df["order"] = df["day"].map(DAYS.index) * SLOTS + df["slot"]
    df = df.sort_values(["regime", "order"])
    out = []
    for regime, g in df.groupby("regime"):
        g = g.set_index("order").reindex(range(7 * SLOTS))
        g["regime"] = regime
        g["day"] = [DAYS[i // SLOTS] for i in g.index]
        g["slot"] = [i % SLOTS for i in g.index]
        g["scope"] = [in_scope(d, s) for d, s in zip(g["day"], g["slot"])]
        g["closed"] = g["coverage"].fillna(0) < 0.5
        pool = g[g["scope"] & ~g["closed"]]
        med = {m: pool[m].median() for m in ["disp60", "er60", "clar60", "disp240", "er240", "range30"]}
        # quality (descriptive only): trend efficiency and one-sidedness of the next hour.
        # Out-of-sample tests show it does not persist by time of day, so it does not drive the score.
        g["quality"] = 0.5 * g["er60"] / med["er60"] + 0.5 * g["clar60"] / med["clar60"]
        # intraday score: net directional displacement of the next hour vs a typical slot (persistent)
        g["score_raw"] = g["disp60"] / med["disp60"]
        # swing score: 4h displacement with a light tilt towards 4h trend efficiency (weakly persistent)
        g["swing_raw"] = (g["disp240"] / med["disp240"]) * np.sqrt(g["er240"] / med["er240"])
        g["activity"] = g["range30"] / med["range30"]
        for col in ["score_raw", "swing_raw", "quality"]:
            v = g[col].where(g["scope"] & ~g["closed"])
            # circular [1,2,1] smoothing that ignores closed / out-of-scope slots
            num = v.fillna(0)
            den = v.notna().astype(float)
            k = lambda s: 0.25 * np.roll(s, 1) + 0.5 * s + 0.25 * np.roll(s, -1)  # noqa: E731
            g[col.replace("_raw", "")] = np.where(v.notna(), k(num.to_numpy()) / np.maximum(k(den.to_numpy()), 1e-9), np.nan)
        out.append(g.reset_index())
    return pd.concat(out, ignore_index=True)


def classify(scores: pd.DataFrame, p: Params) -> pd.DataFrame:
    df = scores.copy()
    df["status"] = "NO TRADE"
    for regime, g in df.groupby("regime"):
        live = g["scope"] & ~g["closed"]
        s = g.loc[live, "score"]
        lo, hi = s.quantile(p.no_trade_pct), s.quantile(p.prime_pct)
        sw_hi = g.loc[live, "swing"].quantile(p.swing_pct)
        act_med = g.loc[live, "activity"].median()
        st = pd.Series("SMALL TRADES", index=g.index)
        st[(g["score"] < lo) | g["score"].isna()] = "NO TRADE"  # NaN: the next hour runs into a market close
        prime = (g["score"] >= hi) & (g["beats"] >= p.prime_consistency)
        st[prime] = "PRIME"
        swing = (g["swing"] >= sw_hi) & (g["activity"] >= act_med) & (g["er240"] >= g.loc[live, "er240"].median())
        st[swing] = "SWING ENTRY"
        st[g["closed"]] = "CLOSED"
        st[~g["scope"] & ~g["closed"]] = "NO TRADE"
        df.loc[g.index, "status"] = st
        df.loc[g.index, "lo"], df.loc[g.index, "hi"] = lo, hi
    return clean_islands(df)


def clean_islands(df: pd.DataFrame) -> pd.DataFrame:
    """Merge 30-minute fragments so windows are practical to follow."""
    df = df.copy()
    for regime, g in df.groupby("regime"):
        st = g["status"].to_list()
        sc = g["score"].to_numpy()
        lo = g["lo"].iloc[0]
        n = len(st)
        for _ in range(3):
            for i in range(n):
                prev, nxt = st[i - 1], st[(i + 1) % n]
                if st[i] == "SMALL TRADES" and prev in ("NO TRADE", "CLOSED") and nxt in ("NO TRADE", "CLOSED"):
                    # lone 30m trade window inside dead time: keep only if clearly above the cut
                    if not (sc[i] >= lo * 1.15):
                        st[i] = "NO TRADE"
                if st[i] == "NO TRADE" and g["scope"].iloc[i] and prev not in ("NO TRADE", "CLOSED") and nxt not in ("NO TRADE", "CLOSED"):
                    st[i] = "SMALL TRADES"  # a single dead half-hour between trade windows
        df.loc[g.index, "status"] = st
    return df


# ----------------------------------------------------------------------------------------------
# windows
# ----------------------------------------------------------------------------------------------

def hhmm(slot: int) -> str:
    m = slot * SLOT_MIN
    return f"{m // 60:02d}:{m % 60:02d}"


def windows(cls: pd.DataFrame, regime: str, day: str) -> list[dict]:
    g = cls[(cls["regime"] == regime) & (cls["day"] == day)].sort_values("slot")
    out = []
    for _, r in g.iterrows():
        weekend = not r["scope"] and not r["closed"]
        status = r["status"]
        if out and out[-1]["status"] == status and out[-1]["weekend"] == weekend:
            out[-1]["end"] = hhmm(r["slot"] + 1)
            out[-1]["rows"].append(r)
        else:
            out.append({"start": hhmm(r["slot"]), "end": hhmm(r["slot"] + 1), "status": status, "weekend": weekend, "rows": [r]})
    res = []
    for w in out:
        rows = pd.DataFrame(w["rows"])
        live = rows[rows["scope"] & ~rows["closed"]]
        stat = lambda c: None if live.empty or live[c].isna().all() else round(float(live[c].mean()), 3)  # noqa: E731
        res.append({
            "start": w["start"], "end": w["end"] if w["end"] != "24:00" else "24:00", "status": w["status"],
            "score": stat("score"), "move": stat("disp60"), "movePct": stat("movepct"), "efficiency": stat("er60"),
            "followThrough": stat("ft"), "consistency": stat("beats"),
            "note": note_for(w, live),
        })
    return res


def note_for(w: dict, live: pd.DataFrame) -> str:
    if w["status"] == "CLOSED":
        return "Gold market shut (weekend / daily break) - perp trades thin, gap risk"
    if w["weekend"]:
        return "Weekend - excluded from the plan"
    if live.empty:
        return ""
    s = live["score"].mean()
    if w["status"] == "NO TRADE":
        return f"Quiet: hourly move only {s:.2f}x typical - noise and fees dominate"
    if w["status"] == "PRIME":
        return f"Largest reliable moves of the day ({s:.2f}x typical)"
    if w["status"] == "SWING ENTRY":
        return "Biggest 4h displacement starts here - best spot to open a swing"
    return f"Tradeable at reduced size ({s:.2f}x typical)"


# ----------------------------------------------------------------------------------------------
# validation
# ----------------------------------------------------------------------------------------------

def validate(obs: pd.DataFrame, end: pd.Timestamp, half_life: float, p: Params) -> tuple[pd.DataFrame, float]:
    """Train on data before `end - 12 months`, score the frozen timetable on the last 12 months."""
    cut = end - pd.DateOffset(months=OOS_MONTHS)
    train = classify(score_table(aggregate(obs, cut, half_life)), p)
    test = obs[(obs["date"] > cut) & (obs["date"] <= end)]
    test = test.merge(train[["regime", "day", "slot", "status"]], on=["regime", "day", "slot"], how="left")
    test = test[test["day"].map(lambda d: d != "Sunday") & test["status"].ne("CLOSED")]
    test = test[[in_scope(d, s) for d, s in zip(test["day"], test["slot"])]]
    res = test.groupby("status").agg(
        slots=("disp60", "count"), move=("disp60", "mean"), move_pct=("movepct", "mean"), range=("range60", "mean"),
        efficiency=("er60", "mean"), clarity=("clar60", "mean"), follow_through=("ft", "mean"),
    )
    # rank correlation between train-period slot scores and realized test-period displacement
    tr_scores = train[train["scope"] & ~train["closed"]][["regime", "day", "slot", "score"]]
    te = test.groupby(["regime", "day", "slot"])["disp60"].mean().reset_index()
    m = tr_scores.merge(te, on=["regime", "day", "slot"]).dropna()
    rho = m["score"].rank().corr(m["disp60"].rank())
    order = ["PRIME", "SWING ENTRY", "SMALL TRADES", "NO TRADE"]
    return res.reindex([o for o in order if o in res.index]), float(rho)


def persistence_study(obs: pd.DataFrame) -> pd.DataFrame:
    """Which slot metrics carry over from the training years to the unseen last 12 months?"""
    df = obs[~obs["dst_mismatch"] & obs["day"].isin(DAYS[:5])]
    cut = df["date"].max() - pd.DateOffset(months=OOS_MONTHS)
    tr, te = df[df["date"] <= cut], df[df["date"] > cut]
    names = {"disp60": "60m net move (score)", "range60": "60m range", "disp240": "4h net move (swing)",
             "er60": "60m efficiency ratio", "clar60": "60m clarity (one-way vs whipsaw)", "er240": "4h efficiency ratio",
             "ft": "momentum follow-through"}
    rows = []
    for c, label in names.items():
        a = tr.groupby(["regime", "day", "slot"])[c].mean()
        b = te.groupby(["regime", "day", "slot"])[c].mean()
        pa = tr.groupby(["regime", "slot"])[c].mean()
        pb = te.groupby(["regime", "slot"])[c].mean()
        rows.append({"metric": label, "per weekday-slot": a.rank().corr(b.rank()), "pooled across weekdays": pa.rank().corr(pb.rank())})
    return pd.DataFrame(rows)


def halflife_study(obs: pd.DataFrame) -> pd.DataFrame:
    """Rolling-origin test: which recency half-life best predicts the next quarter's slot moves?"""
    df = obs[~obs["dst_mismatch"] & obs["day"].isin(DAYS[:5]) & obs["disp60"].notna()]
    end = df["date"].max()
    rows = []
    for hl in [8, 13, 26, 52, 104, None]:
        cors = []
        for q in range(6):
            cut = end - pd.DateOffset(months=3 * (q + 1))
            tr = df[df["date"] <= cut]
            te = df[(df["date"] > cut) & (df["date"] <= cut + pd.DateOffset(months=3))]
            w = 1.0 if hl is None else 0.5 ** ((cut - tr["date"]).dt.days / 7 / hl)
            key = [tr["regime"], tr["day"], tr["slot"]]
            pred = (tr["disp60"] * w).groupby(key).sum() / (tr["disp60"] * 0 + w).groupby(key).sum()
            real = te.groupby(["regime", "day", "slot"])["disp60"].mean()
            j = pd.concat([pred.rename("p"), real.rename("t")], axis=1).dropna()
            cors.append(j["p"].rank().corr(j["t"].rank()))
        rows.append({"half-life": "none (equal weight)" if hl is None else f"{hl} weeks", "next-quarter rank corr": float(np.mean(cors))})
    return pd.DataFrame(rows)


def year_stability(obs: pd.DataFrame) -> pd.DataFrame:
    """Correlation of each year's (day, slot) displacement profile with the most recent year."""
    df = obs[~obs["dst_mismatch"]].copy()
    df = df[[in_scope(d, s) for d, s in zip(df["day"], df["slot"])]]
    end = df["date"].max()
    df["yr"] = ((end - df["date"]).dt.days // 365).clip(upper=3)
    prof = df.groupby(["yr", "regime", "day", "slot"])["disp60"].mean().unstack(["regime", "day", "slot"])
    base = prof.loc[0]
    rows = []
    for yr in prof.index:
        r = prof.loc[yr].corr(base, method="spearman")
        rows.append({"period": "last 12 months" if yr == 0 else f"{yr}-{yr + 1} years ago", "rank_corr_vs_last_12m": round(r, 3)})
    return pd.DataFrame(rows)


# ----------------------------------------------------------------------------------------------
# charts & report
# ----------------------------------------------------------------------------------------------

BG, FG, MUTED, GRID = "#15181d", "#d7dbe2", "#8a919c", "#2a2f37"
STATUS_COLOR = {"PRIME": "#5fb58a", "SWING ENTRY": "#6f9fd8", "SMALL TRADES": "#c9a95c", "NO TRADE": "#c26a62", "CLOSED": "#4a4f58"}


def fig_png(fig) -> str:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=110, facecolor=BG, bbox_inches="tight")
    plt.close(fig)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def style(ax):
    ax.set_facecolor(BG)
    for s in ax.spines.values():
        s.set_color(GRID)
    ax.tick_params(colors=MUTED, labelsize=8)
    ax.title.set_color(FG)


def heatmap(cls: pd.DataFrame, regime: str, col: str, title: str, cmap="viridis") -> str:
    days = DAYS[:6]
    g = cls[cls["regime"] == regime]
    mat = np.full((len(days), SLOTS), np.nan)
    for i, d in enumerate(days):
        r = g[g["day"] == d].sort_values("slot")
        vals = r[col].to_numpy(dtype=float, copy=True)
        vals[~(r["scope"].to_numpy() & ~r["closed"].to_numpy())] = np.nan
        mat[i] = vals
    fig, ax = plt.subplots(figsize=(12, 2.6))
    fig.patch.set_facecolor(BG)
    cm = plt.get_cmap(cmap).copy()
    cm.set_bad(GRID)
    im = ax.imshow(mat, aspect="auto", cmap=cm, interpolation="nearest")
    ax.set_yticks(range(len(days)), [d[:3] for d in days])
    ax.set_xticks(range(0, SLOTS, 4), [hhmm(s) for s in range(0, SLOTS, 4)])
    ax.set_title(title, fontsize=10, loc="left", color=FG)
    style(ax)
    cb = fig.colorbar(im, ax=ax, pad=0.01)
    cb.ax.tick_params(colors=MUTED, labelsize=7)
    return fig_png(fig)


def schedule_chart(cls: pd.DataFrame, regime: str, title: str) -> str:
    days = DAYS[:6]
    g = cls[cls["regime"] == regime]
    fig, ax = plt.subplots(figsize=(12, 2.8))
    fig.patch.set_facecolor(BG)
    for i, d in enumerate(days):
        r = g[g["day"] == d].sort_values("slot")
        for _, row in r.iterrows():
            c = STATUS_COLOR[row["status"]]
            if not row["scope"] and not row["closed"]:
                c = GRID
            ax.barh(i, 1, left=row["slot"], color=c, height=0.8, edgecolor=BG, linewidth=0.3)
    ax.set_yticks(range(len(days)), [d[:3] for d in days])
    ax.invert_yaxis()
    ax.set_xticks(range(0, SLOTS + 1, 4), [hhmm(s) if s < SLOTS else "24:00" for s in range(0, SLOTS + 1, 4)])
    ax.set_xlim(0, SLOTS)
    ax.set_title(title, fontsize=10, loc="left", color=FG)
    style(ax)
    handles = [plt.Rectangle((0, 0), 1, 1, color=v) for v in STATUS_COLOR.values()]
    leg = ax.legend(handles, STATUS_COLOR.keys(), ncol=5, fontsize=7, loc="upper center", bbox_to_anchor=(0.5, -0.18), frameon=False)
    for t in leg.get_texts():
        t.set_color(MUTED)
    return fig_png(fig)


def profile_chart(cls: pd.DataFrame, regime: str, day: str) -> str:
    g = cls[(cls["regime"] == regime) & (cls["day"] == day)].sort_values("slot")
    fig, ax = plt.subplots(figsize=(12, 1.9))
    fig.patch.set_facecolor(BG)
    x = g["slot"].to_numpy()
    colors = [STATUS_COLOR[s] if sc and not c else GRID for s, sc, c in zip(g["status"], g["scope"], g["closed"])]
    ax.bar(x + 0.5, g["score"].fillna(0), width=0.9, color=colors)
    ax.plot(x + 0.5, g["swing"].fillna(np.nan), color="#6f9fd8", lw=1, alpha=0.8, label="swing (4h) score")
    ax.axhline(1, color=MUTED, lw=0.6, ls=":")
    ax.set_xlim(0, SLOTS)
    ax.set_xticks(range(0, SLOTS + 1, 4), [hhmm(s) if s < SLOTS else "24:00" for s in range(0, SLOTS + 1, 4)])
    style(ax)
    ax.set_ylabel("score (1 = typical)", color=MUTED, fontsize=7)
    return fig_png(fig)


def gold_crosscheck(info: dict) -> list[dict]:
    """Validate the long gold history against the XAUUSDT perp (and PAXG against Dukascopy spot)."""
    out = []
    if info["source"] != "blend":
        out.append(dict(pair=f"{info['source']} history vs XAUUSDT perp", **compare_feeds(info["hist_5m"], info["perp_5m"], info["perp_5m"].index[0] + pd.Timedelta(days=7))))
    else:
        from common import resample
        px = gold_session_only(load("binance_spot", "PAXGUSDT", "5m"), "5m")
        fine = info["paxg_fine_from"]
        out.append(dict(pair="PAXG fine-tick vs XAUUSDT perp (used)", **compare_feeds(px[px.index >= fine], info["perp_5m"], info["perp_5m"].index[0] + pd.Timedelta(days=7))))
        duk = dukascopy_cached_1m()
        if duk is not None:
            d5 = resample(duk, "5m")
            out.append(dict(pair="PAXG $1-tick vs Dukascopy spot (why old PAXG is excluded)", **compare_feeds(px[px.index < fine], d5, d5.index[0])))
    return out


def compare_feeds(hist: pd.DataFrame, perp: pd.DataFrame, start: pd.Timestamp) -> dict:
    end = min(perp.index[-1], hist.index[-1])
    common_idx = hist.index.intersection(perp.index)
    common_idx = common_idx[(common_idx >= start) & (common_idx <= end)]
    hist, perp = hist.loc[common_idx], perp.loc[common_idx]
    res = {"from": str(start.date()), "to": str(end.date()), "bars": len(common_idx)}
    both = pd.concat({"perp": perp["close"], "spot": hist["close"]}, axis=1).dropna()
    r = np.log(both).diff().dropna()
    res["ret_corr_5m"] = round(float(r["perp"].corr(r["spot"])), 3)
    res["mean_basis_pct"] = round(float(((both["perp"] / both["spot"]) - 1).mean() * 100), 3)
    prof = {}
    for k, df in [("perp", perp), ("spot", hist)]:
        d = df
        rng = (d["high"] - d["low"]) / d["close"]
        ist = d.index + IST
        prof[k] = rng.groupby([ist.dayofweek, (ist.hour * 60 + ist.minute) // SLOT_MIN]).mean()
    both_p = pd.concat(prof, axis=1).dropna()
    res["slot_profile_rank_corr"] = round(float(both_p["perp"].rank().corr(both_p["spot"].rank())), 3)
    # 5m range ratio: does the history feed move as much as the reference?
    res["range_ratio"] = round(float(((hist["high"] - hist["low"]) / hist["close"]).mean() / ((perp["high"] - perp["low"]) / perp["close"]).mean()), 3)
    return res


def gold_gap_note(info: dict) -> str:
    if info["source"] != "blend":
        return ""
    duk_to = info.get("dukascopy_to")
    start = (duk_to + pd.Timedelta(days=1)).date() if duk_to is not None else "2022-09-01"
    return f"{start} to {(info['paxg_fine_from'] - pd.Timedelta(days=1)).date()}"


def coverage_rows(sources: list[tuple[str, str, str]]) -> list[dict]:
    rows = []
    for src, sym, label in sources:
        for tf in ["5m", "15m", "1h", "4h", "1d", "1w"]:
            try:
                df = load(src, sym, tf)
            except FileNotFoundError:
                continue
            rows.append({"feed": label, "tf": tf, "bars": len(df), "from": str(df.index[0].date()), "to": str(df.index[-1].date())})
    return rows


def weekly_context(symbol_src: tuple[str, str]) -> pd.DataFrame:
    """Share of the weekly range printed on each IST weekday (1w + 1h timeframes)."""
    h = load(*symbol_src, "1h")
    w = load(*symbol_src, "1w")
    ist = h.index + IST
    h = h.assign(day=ist.dayofweek, week=(h.index.tz_localize(None).to_period("W-SUN").start_time))
    day_rng = h.groupby(["week", "day"]).agg(hi=("high", "max"), lo=("low", "min"))
    wk = w.copy()
    wk.index = wk.index.tz_localize(None)
    rows = []
    for (week, day), r in day_rng.iterrows():
        if week not in wk.index:
            continue
        wr = wk.loc[week, "high"] - wk.loc[week, "low"]
        if wr <= 0:
            continue
        rows.append({"day": DAYS[day], "share": (r["hi"] - r["lo"]) / wr,
                     "made_high": r["hi"] >= wk.loc[week, "high"], "made_low": r["lo"] <= wk.loc[week, "low"]})
    df = pd.DataFrame(rows)
    return df.groupby("day").agg(range_share=("share", "mean"), weekly_high=("made_high", "mean"),
                                 weekly_low=("made_low", "mean")).reindex(DAYS).dropna()


# ----------------------------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------------------------

def run_instrument(name: str, m5, m15, daily, end, half_life, p):
    obs = winsorize(observations(m5, m15, daily))
    obs = obs[obs["date"] <= end]
    agg = aggregate(obs, end, half_life)
    cls = classify(score_table(agg), p)
    val, rho = validate(obs, end, half_life, p)
    stab = year_stability(obs)
    studies = {"persistence": persistence_study(obs), "halflife": halflife_study(obs)}
    cls.to_csv(OUT / f"{name}_slots.csv", index=False)
    return obs, cls, val, rho, stab, studies


def to_ts(results: dict, meta: dict) -> str:
    sched = {}
    for inst, r in results.items():
        sched[inst] = {}
        for regime in REGIMES:
            sched[inst][regime] = {}
            for day in DAYS:
                cls = r["cls"]
                prof = cls[(cls["regime"] == regime) & (cls["day"] == day)].sort_values("slot")
                profile = [None if (np.isnan(v) or not sc or c) else round(float(v), 2)
                           for v, sc, c in zip(prof["score"], prof["scope"], prof["closed"])]
                sched[inst][regime][day] = {"windows": windows(cls, regime, day), "profile": profile}
    body = json.dumps(sched, indent=1, default=lambda o: None)
    return f"""// AUTO-GENERATED by research/analyze.py on {meta['generated']} - do not edit by hand.
// Re-run: python3 research/fetch_binance.py && python3 research/fetch_dukascopy.py && python3 research/analyze.py
import type {{ Schedules, ResearchMeta }} from "./timetable";

export const RESEARCH_META: ResearchMeta = {json.dumps(meta, indent=1)};

export const SCHEDULES: Schedules = {body};
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gold-source", default=None, choices=list(GOLD_HISTORY),
                    help="long gold history (default: dukascopy if fully downloaded, else blend)")
    ap.add_argument("--half-life", type=float, default=52.0, help="recency weighting half-life in weeks")
    args = ap.parse_args()
    p = Params()
    if args.gold_source is None:
        args.gold_source = "dukascopy" if path("dukascopy", "XAUUSD", "5m").exists() else "blend"
    print("gold history source:", args.gold_source)

    btc = {tf: load("binance", "BTCUSDT", tf) for tf in ["5m", "15m", "1d"]}
    gold, ginfo = gold_frames(args.gold_source)
    end = min(btc["5m"].index[-1], gold["5m"].index[-1]).tz_convert(None).normalize() - pd.Timedelta(days=1)

    results = {}
    for inst, fr in [("BTCUSDT", btc), ("XAUUSDT", gold)]:
        obs, cls, val, rho, stab, studies = run_instrument(inst, fr["5m"], fr["15m"], fr["1d"], end, args.half_life, p)
        results[inst] = dict(obs=obs, cls=cls, val=val, rho=rho, stab=stab, studies=studies)
        print(f"\n== {inst} ==  OOS rank corr {rho:.3f}")
        print(val.round(3).to_string())
        print(stab.to_string(index=False))
        print(studies["persistence"].round(3).to_string(index=False))
        print(studies["halflife"].round(3).to_string(index=False))

    cross = gold_crosscheck(ginfo)
    print("\ngold cross-check", cross)
    meta = {
        "generated": pd.Timestamp.now(tz="Asia/Kolkata").strftime("%Y-%m-%d %H:%M IST"),
        "dataThrough": str(end.date()),
        "halfLifeWeeks": args.half_life,
        "btcFrom": str(btc["5m"].index[0].date()),
        "goldFrom": str(gold["5m"].index[0].date()),
        "goldSplice": str(ginfo["splice"].date()),
        "goldHistorySource": args.gold_source,
        "goldGaps": gold_gap_note(ginfo),
        "oosRankCorr": {k: round(v["rho"], 3) for k, v in results.items()},
    }
    (REPO / "src/lib/timetable.generated.ts").write_text(to_ts(results, meta))

    from report import build_report  # local module
    coverage = coverage_rows([("binance", "BTCUSDT", "Binance BTCUSDT perp"), ("binance", "XAUUSDT", "Binance XAUUSDT perp"),
                              (*GOLD_HISTORY[args.gold_source], f"{args.gold_source} gold history" if args.gold_source != "blend" else "Binance PAXGUSDT spot")])
    if args.gold_source == "blend" and ginfo.get("dukascopy_to") is not None:
        d = ginfo["hist_5m"]
        d = d[d.index <= ginfo["dukascopy_to"]]
        coverage.append({"feed": "Dukascopy XAUUSD spot (cached days)", "tf": "1m -> 5m/15m", "bars": len(d),
                         "from": str(d.index[0].date()), "to": str(d.index[-1].date())})
    html = build_report(results, meta, cross, p, args, coverage, ginfo,
                        {"BTCUSDT": weekly_context(("binance", "BTCUSDT")),
                         "XAUUSDT": weekly_context(GOLD_HISTORY[args.gold_source])},
                        dict(heatmap=heatmap, schedule_chart=schedule_chart, profile_chart=profile_chart, windows=windows))
    (REPO / "public/report.html").write_text(html)
    print("\nwrote src/lib/timetable.generated.ts and public/report.html")


if __name__ == "__main__":
    main()
