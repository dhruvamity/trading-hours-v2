"""Day filter research for gold (XAUUSDT perp, 1-minute candles).

Question: can a trader know BEFORE a session whether to trade it, scalp it 1:1, or skip it?

Everything is measured in the trader's own units: R = the stop distance (0.19% of price, about $8),
target = 2R, holding window = 3 hours. Two things are tested separately:

  * movement  - how far price travels in the next 3 hours, in R
  * chop      - whether that movement comes in clean legs or in whipsaws

Result: movement is forecastable. The same clock time over the previous 20 sessions gives the
level; how active today / the last 2 hours / yesterday were against that norm adjusts it, and the
adjustment matters most when the market is far from its norm. Chop is not forecastable: no trailing
chop measure predicts the next hours' chop. So the filter forecasts movement, and maps it to
TRADE / 1:1 ONLY / NO TRADE through what price actually offered, walk-forward, at each forecast level.

Writes:
  * src/lib/day-filter.generated.ts          -> model, lookup tables and backtest for /filter
  * research/output/day_filter_fixture.json  -> bars + expected numbers for the TS parity check

Usage: python3 research/fetch_1m.py && python3 research/day_filter.py
"""
from __future__ import annotations

import json
import math
import re
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view
from scipy.stats import spearmanr

from common import ROOT, path

REPO = ROOT.parent
OUT = ROOT / "output"
OUT.mkdir(exist_ok=True)
NY, IST = ZoneInfo("America/New_York"), ZoneInfo("Asia/Kolkata")

STOP_PCT = 0.19            # the playbook stop in % of price: $8 with gold near $4,200
THETAS = [0.12, 0.145, 0.19, 0.24, 0.30]   # stop sizes studied, % of price ($5 to $12.60)
STOP_TABLES = {6: 0.145, 8: 0.19, 10: 0.24}   # backtest tables shown on the page, by stop in $
FEE_PCT = 0.017            # round-trip fee in % of notional
SESSION_MIN = 1380         # one gold session: 18:00 -> 17:00 New York
SLOTS = SESSION_MIN // 5   # 5-minute bars per session
HZN = 36                   # forward window: 36 bars = 3 hours
MIN_HZN = 24               # near the close a shorter window is allowed, down to 2 hours
W2H = 24                   # "last 2 hours" activity window
SMOOTH = 2                 # the same-clock norm is averaged over +-2 slots (10 minutes)
BASE_DAYS, MIN_BASE = 20, 10
Q_CLIP = round(math.log(3.5), 6)   # activity ratios are capped at 3.5x / 0.29x
STEP = 6                   # research grid: one decision point every 30 minutes
EVE_IST = (17 * 60, 24 * 60)   # the playbook's entry window
EVE_POINTS = 9             # decision points 17:00, 17:30 ... 21:00 IST (each looks 3 hours ahead)
WALK_START, WALK_EVERY = 60, 20   # walk-forward: first fit after 60 sessions, refit every 20
SIX_MONTHS = 126           # sessions in the "last six months" reference
QUANTILES = [5, 10, 25, 50, 75, 90, 95]
F_GRID = [1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 10]   # forecast 3h range (R) at which lookups are stored
F_EDGES = [0, 1.75, 2.25, 2.75, 3.25, 3.75, 4.25, 4.75, 5.5, 6.5, 7.5, 9, 1e9]
# Verdict rules, on what price offered in walk-forward history at this forecast level:
P_DEAD = 0.60   # NO TRADE  when a 1R move came within the hour from fewer than 60% of entry points
P_FULL = 0.72   # TRADE     when a 2R move came within 3 hours from at least 72% of entry points
P_FAST = 0.25   # "fast"    when 1R above AND 1R below both traded within the hour for 25%+ of entry points


# ----------------------------------------------------------------------------------------------
# sessions
# ----------------------------------------------------------------------------------------------

def session_mask(idx: pd.DatetimeIndex) -> np.ndarray:
    """True while the gold market is open: Sun 18:00 ET -> Fri 17:00 ET, minus the daily 17:00-18:00 ET break."""
    et = idx.tz_convert(NY)
    dow, hr = et.dayofweek, et.hour
    closed = (hr == 17) | (dow == 5) | ((dow == 4) & (hr >= 17)) | ((dow == 6) & (hr < 18))
    return ~np.asarray(closed)


def session_clock(idx: pd.DatetimeIndex) -> tuple[pd.DatetimeIndex, np.ndarray]:
    """(session label day, minute of the session). A session opens at 18:00 New York and is labelled
    by the date it ends on, so the label matches the IST calendar day for all but its last hours."""
    shifted = idx.tz_convert(NY).tz_localize(None) + pd.Timedelta(hours=6)
    return shifted.normalize(), np.asarray(shifted.hour * 60 + shifted.minute)


def to_matrix(values: np.ndarray, day_pos: np.ndarray, col: np.ndarray, n_days: int, width: int) -> np.ndarray:
    out = np.full((n_days, width), np.nan)
    out[day_pos, col] = values
    return out


class Sessions:
    """Candles laid out as [session, slot] matrices of 5-minute bars (NaN = no bar)."""

    def __init__(self, days: pd.DatetimeIndex, O: np.ndarray, H: np.ndarray, L: np.ndarray, C: np.ndarray):
        self.days, self.O, self.H, self.L, self.C = days, O, H, L, C
        self.complete = ~np.isnan(C).any(axis=1)
        # the session's first minute in IST: 03:30 while New York is on daylight time, 04:30 otherwise
        opens = (days - pd.Timedelta(hours=6)).tz_localize(NY).tz_convert(IST)
        self.open_ist = np.asarray(opens.hour * 60 + opens.minute)
        self.eve_slot = (EVE_IST[0] - self.open_ist) // 5

    @classmethod
    def from_1m(cls, m1: pd.DataFrame) -> "Sessions":
        m = m1[session_mask(m1.index)]
        day, minute = session_clock(m.index)
        days = pd.DatetimeIndex(sorted(set(day)))
        pos, n = days.get_indexer(day), len(days)
        o, h, l, c = (to_matrix(m[k].to_numpy(), pos, minute, n, SESSION_MIN).reshape(n, SLOTS, 5)
                      for k in ("open", "high", "low", "close"))
        return cls(days, o[:, :, 0], h.max(axis=2), l.min(axis=2), c[:, :, 4])   # NaN if any minute is missing

    @classmethod
    def from_5m(cls, m5: pd.DataFrame) -> "Sessions":
        m = m5[session_mask(m5.index)]
        day, minute = session_clock(m.index)
        days = pd.DatetimeIndex(sorted(set(day)))
        pos, n = days.get_indexer(day), len(days)
        return cls(days, *(to_matrix(m[k].to_numpy(), pos, minute // 5, n, SLOTS) for k in ("open", "high", "low", "close")))


# ----------------------------------------------------------------------------------------------
# activity and forward range on 5-minute bars (mirrored in src/lib/day-filter.ts)
# ----------------------------------------------------------------------------------------------

def cum_sq(O: np.ndarray, C: np.ndarray) -> np.ndarray:
    """[session, slot 0..SLOTS] running sum of squared 5m log returns since the session open."""
    prev = np.concatenate([O[:, :1], C[:, :-1]], axis=1)
    r2 = np.log(C / prev) ** 2
    return np.concatenate([np.zeros((len(C), 1)), np.cumsum(r2, axis=1)], axis=1)


def rv_2h(cs: np.ndarray) -> np.ndarray:
    lag = np.concatenate([np.repeat(cs[:, :1], W2H, axis=1), cs[:, :-W2H]], axis=1)
    return np.sqrt(cs - lag)


def fwd_range(O: np.ndarray, H: np.ndarray, L: np.ndarray, C: np.ndarray) -> np.ndarray:
    """[session, slot] high-low range of the next HZN bars as a fraction of the price at the slot.
    Windows are cut at the session close; NaN when fewer than MIN_HZN bars remain or bars are missing."""
    n = len(C)
    hp = np.concatenate([H, np.full((n, HZN), -np.inf)], axis=1)
    lp = np.concatenate([L, np.full((n, HZN), np.inf)], axis=1)
    hi = sliding_window_view(hp, HZN, axis=1).max(axis=2)[:, :SLOTS]
    lo = sliding_window_view(lp, HZN, axis=1).min(axis=2)[:, :SLOTS]
    p0 = np.concatenate([O[:, :1], C[:, :-1]], axis=1)
    out = (hi - lo) / p0
    out[:, SLOTS - MIN_HZN + 1:] = np.nan
    return out


def prior_median(x: np.ndarray) -> np.ndarray:
    """Per session and column: median of the previous BASE_DAYS sessions (needs MIN_BASE of them)."""
    return pd.DataFrame(x).shift(1).rolling(BASE_DAYS, min_periods=MIN_BASE).median().to_numpy()


def smooth_slots(x: np.ndarray) -> np.ndarray:
    """Average each slot with its +-SMOOTH neighbours (the ones that exist)."""
    return pd.DataFrame(x.T).rolling(2 * SMOOTH + 1, center=True, min_periods=1).mean().to_numpy().T


def clip_log(ratio: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.clip(np.log(ratio), -Q_CLIP, Q_CLIP)


def features(s: Sessions) -> dict[str, np.ndarray]:
    cs = cum_sq(s.O, s.C)
    rd, r2 = np.sqrt(cs), rv_2h(cs)
    F = fwd_range(s.O, s.H, s.L, s.C)
    full = np.where(s.complete, rd[:, SLOTS], np.nan)          # whole-session activity
    y_base = pd.Series(full).shift(2).rolling(BASE_DAYS - 1, min_periods=MIN_BASE).median().to_numpy()
    med = prior_median(F)
    base = np.where(np.isnan(med), np.nan, smooth_slots(med))  # the norm: same clock time, previous 20 sessions
    with np.errstate(divide="ignore", invalid="ignore"):
        qd = clip_log(rd / prior_median(rd))                   # today so far vs the same slice of prior sessions
        q2 = clip_log(r2 / prior_median(r2))                   # last 2 hours vs the same clock window
        qy = clip_log(np.concatenate([[np.nan], full[:-1]]) / y_base)   # yesterday vs the sessions before it
        y = np.log(F / base)
    qd[:, 0] = 0.0   # nothing has traded yet at the open
    q2[:, 0] = 0.0
    return {"qd": qd, "q2": q2, "qy": qy, "F": F, "base": base, "y": y, "cs": cs}


def so_far(s: Sessions) -> dict[str, np.ndarray]:
    """[session, slot 0..SLOTS] range / net move / efficiency from the session open up to each slot."""
    prev = np.concatenate([s.O[:, :1], s.C[:, :-1]], axis=1)
    pad = lambda x: np.concatenate([np.full((len(x), 1), np.nan), x], axis=1)  # noqa: E731
    hi, lo = np.maximum.accumulate(s.H, axis=1), np.minimum.accumulate(s.L, axis=1)
    net = np.abs(s.C - s.O[:, :1])
    with np.errstate(divide="ignore", invalid="ignore"):
        return {"rangePct": pad((hi - lo) / s.O[:, :1] * 100), "netPct": pad(net / s.O[:, :1] * 100),
                "er": pad(net / np.cumsum(np.abs(s.C - prev), axis=1))}


# ----------------------------------------------------------------------------------------------
# what price actually did after each minute (1-minute resolution, on the gap-free 24/7 series)
# ----------------------------------------------------------------------------------------------

def first_true(mask: np.ndarray) -> np.ndarray:
    idx = mask.argmax(axis=1).astype(float)
    idx[~mask.any(axis=1)] = np.inf
    return idx


def passages(m1: pd.DataFrame, theta: float, horizon: int = 180, chunk: int = 20000) -> pd.DataFrame:
    """For an entry at each minute's close: minutes until price first trades 1R / 2R above (tu1, tu2) or
    below (td1, td2) the entry, inf if not within `horizon`; `end` = close-to-close move after `horizon`, in R."""
    c, h, l = (m1[k].to_numpy(dtype=float) for k in ("close", "high", "low"))
    n = len(c)
    out = {k: np.full(n, np.nan) for k in ("tu1", "td1", "tu2", "td2", "end")}
    hw, lw = sliding_window_view(h, horizon), sliding_window_view(l, horizon)
    last = n - horizon - 1
    for a in range(0, last, chunk):
        b = min(a + chunk, last)
        p0 = c[a:b, None]
        r = theta * p0
        up, dn = (hw[a + 1:b + 1] - p0) / r, (p0 - lw[a + 1:b + 1]) / r
        for key, m in (("tu1", up >= 1), ("td1", dn >= 1), ("tu2", up >= 2), ("td2", dn >= 2)):
            out[key][a:b] = first_true(m) + 1
        out["end"][a:b] = (c[a + horizon:b + horizon] - c[a:b]) / r[:, 0]
    return pd.DataFrame(out, index=m1.index)


def continuation(m1: pd.DataFrame, theta: float, h1: int = 120, h2: int = 120, chunk: int = 20000) -> pd.DataFrame:
    """Trend quality at the stop scale. After price first travels 1R from an entry (within h1 minutes), does it
    go on to 2R on that side before coming back to the entry price (within h2 more minutes)?
    cont = 1 / 0, NaN if price never moved 1R or the question was still open; known = minutes until it was settled."""
    c, h, l = (m1[k].to_numpy(dtype=float) for k in ("close", "high", "low"))
    n, hz = len(c), h1 + h2
    cont, known = np.full(n, np.nan), np.full(n, np.nan)
    hw, lw = sliding_window_view(h, hz), sliding_window_view(l, hz)
    k = np.arange(hz)[None, :]
    last = n - hz - 1
    for a in range(0, last, chunk):
        b = min(a + chunk, last)
        p0 = c[a:b, None]
        r = theta * p0
        up, dn = (hw[a + 1:b + 1] - p0) / r, (p0 - lw[a + 1:b + 1]) / r
        tu, td = first_true(up[:, :h1] >= 1), first_true(dn[:, :h1] >= 1)
        t1 = np.minimum(tu, td)
        side = np.where(tu < td, 1, np.where(td < tu, -1, 0))
        fav, adv = np.where(side[:, None] >= 0, up, dn), np.where(side[:, None] >= 0, dn, up)
        window = k < (t1[:, None] + h2 + 1)
        t2 = first_true((fav >= 2) & (k >= t1[:, None]) & window)
        t0 = first_true((adv >= 0) & (k > t1[:, None]) & window)
        settled = np.isfinite(t1) & (side != 0) & (np.isfinite(t2) | np.isfinite(t0))
        cont[a:b] = np.where(settled, (t2 < t0).astype(float), np.nan)
        known[a:b] = np.where(settled, np.minimum(t2, t0) + 1, np.nan)
    return pd.DataFrame({"cont": cont, "known": known}, index=m1.index)


def minute_matrix(frame: pd.DataFrame, s: Sessions) -> dict[str, np.ndarray]:
    frame = frame[session_mask(frame.index)]
    day, minute = session_clock(frame.index)
    pos = s.days.get_indexer(day)
    return {k: to_matrix(frame[k].to_numpy(), pos, minute, len(s.days), SESSION_MIN) for k in frame.columns}


def offered(full: pd.DataFrame, s: Sessions, theta: float) -> dict[str, np.ndarray]:
    """What the next 3 hours offered an entry at each minute, as [session, minute] matrices."""
    fee_r = FEE_PCT / (theta * 100)
    p = passages(full, theta)
    t1, t2 = np.minimum(p.tu1, p.td1), np.minimum(p.tu2, p.td2)
    cols = {
        "reach1": (t1 <= 60).astype(float),                      # price moved 1R one way within the hour
        "reach2": (t2 <= 180).astype(float),                     # price moved 2R one way within 3 hours
        "whip": (np.maximum(p.tu1, p.td1) <= 60).astype(float),  # 1R above AND 1R below both traded within the hour
    }
    # coin-flip entry (average of a long and a short), stop 1R, time stop 180 min, fees included
    for name, tgt_up, tgt_dn, gain in (("p11", p.tu1, p.td1, 1.0), ("p12", p.tu2, p.td2, 2.0)):
        long_r = np.where(tgt_up < p.td1, gain, np.where(np.isfinite(p.td1), -1.0, p.end))
        short_r = np.where(tgt_dn < p.tu1, gain, np.where(np.isfinite(p.tu1), -1.0, -p.end))
        cols[name] = (long_r + short_r) / 2 - fee_r
        cols[name + "_win"] = ((tgt_up < p.td1).astype(float) + (tgt_dn < p.tu1)) / 2
        cols[name + "_open"] = ((~np.isfinite(np.minimum(tgt_up, p.td1))).astype(float) + ~np.isfinite(np.minimum(tgt_dn, p.tu1))) / 2
        cols[name + "_min"] = (np.minimum(np.minimum(tgt_up, p.td1), 180) + np.minimum(np.minimum(tgt_dn, p.tu1), 180)) / 2
    frame = pd.DataFrame(cols, index=full.index)
    frame[p.tu1.isna().to_numpy()] = np.nan
    return minute_matrix(frame, s)


def window_mean(x: np.ndarray, length: int = 180) -> np.ndarray:
    """[session, slot] mean of a per-minute matrix over the `length` minutes from each 5m slot (cut at the close)."""
    cs = np.concatenate([np.zeros((len(x), 1)), np.cumsum(np.nan_to_num(x), axis=1)], axis=1)
    cn = np.concatenate([np.zeros((len(x), 1)), np.cumsum(~np.isnan(x), axis=1)], axis=1)
    a = np.arange(SLOTS) * 5
    b = np.minimum(a + length, SESSION_MIN)
    with np.errstate(invalid="ignore", divide="ignore"):
        return (cs[:, b] - cs[:, a]) / (cn[:, b] - cn[:, a])


# ----------------------------------------------------------------------------------------------
# models
# ----------------------------------------------------------------------------------------------

def ols(X: np.ndarray, y: np.ndarray) -> np.ndarray:
    ok = np.isfinite(X).all(axis=1) & np.isfinite(y)
    return np.linalg.lstsq(X[ok], y[ok], rcond=None)[0]


def response(q: np.ndarray) -> np.ndarray:
    """Design for ln(range / norm) = c + a*q + b*q|q|: small deviations from the norm barely count, big ones do."""
    return np.column_stack([np.ones(len(q)), q, q * np.abs(q)])


def now_rows(f: dict, slots: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """One row per (session, slot) on the research grid: activity vs norm, and what the next 3 hours did."""
    d, k = np.meshgrid(np.arange(len(f["y"])), slots, indexing="ij")
    d, k = d.ravel(), k.ravel()
    return (f["q2"][d, k] + f["qd"][d, k]) / 2, f["y"][d, k], d, k


def tonight_rows(f: dict, s: Sessions) -> pd.DataFrame:
    """One row per (session, decision slot up to 17:00 IST). q blends today so far with yesterday:
    early in the day yesterday carries the weight, by the evening today does."""
    rows = []
    for d in range(len(s.days)):
        ka = int(s.eve_slot[d])
        eve = ka + STEP * np.arange(EVE_POINTS)
        y_eve = np.mean(f["y"][d, eve])              # NaN unless the whole evening is known
        for k in range(0, ka + 1, STEP):
            u = k / ka
            rows.append((d, k, u * f["qd"][d, k] + (1 - u) * f["qy"][d], y_eve, np.median(f["base"][d, eve])))
    return pd.DataFrame(rows, columns=["d", "k", "q", "y_eve", "base_eve"])


def walk_forward(X: np.ndarray, y: np.ndarray, d: np.ndarray, n_days: int) -> np.ndarray:
    """Out-of-sample predictions: coefficients are refit on all earlier sessions every WALK_EVERY sessions."""
    pred = np.full(len(y), np.nan)
    for start in range(WALK_START, n_days, WALK_EVERY):
        test = (d >= start) & (d < start + WALK_EVERY)
        pred[test] = X[test] @ ols(X[d < start], y[d < start])
    return pred


def isotonic(y: np.ndarray, w: np.ndarray) -> np.ndarray:
    """Weighted pool-adjacent-violators: the closest non-decreasing sequence."""
    vals, wts, size = [], [], []
    for v, wt in zip(y, w):
        vals.append(float(v)); wts.append(float(wt)); size.append(1)
        while len(vals) > 1 and vals[-2] > vals[-1]:
            tot = wts[-2] + wts[-1]
            vals[-2:] = [(vals[-2] * wts[-2] + vals[-1] * wts[-1]) / tot]
            wts[-2:] = [tot]
            size[-2:] = [size[-2] + size[-1]]
    return np.repeat(vals, size)


def lookup(fc: np.ndarray, value: np.ndarray, edges: list[float], grid: list[float]) -> list[float]:
    """Mean of `value` by forecast bucket, made monotone, read off at the grid points."""
    t = pd.DataFrame({"fc": fc, "v": value}).dropna()
    g = t.groupby(pd.cut(t.fc, edges), observed=True)
    stat = pd.DataFrame({"x": g.fc.mean(), "v": g.v.mean(), "n": g.size()})
    stat = stat[stat.n >= 30]
    return [round(float(v), 4) for v in np.interp(grid, stat.x, isotonic(stat.v.to_numpy(), stat.n.to_numpy()))]


def calibrate(raw: np.ndarray, calib: dict) -> np.ndarray:
    """Forecast -> the median outcome seen at that forecast level; proportional beyond the studied range."""
    xs, ys = calib["raw"], calib["actual"]
    raw = np.asarray(raw, dtype=float)
    out = np.interp(raw, xs, ys)
    out = np.where(raw < xs[0], raw * ys[0] / xs[0], out)
    return np.where(raw > xs[-1], raw * ys[-1] / xs[-1], out)


def offer_at(f_r: np.ndarray, table: list[float]) -> np.ndarray:
    """Lookup at a forecast range (R); below the studied range the share falls in proportion, towards zero."""
    f_r = np.asarray(f_r, dtype=float)
    return np.where(f_r < F_GRID[0], table[0] * f_r / F_GRID[0], np.interp(f_r, F_GRID, table))


def verdict_of(reach1: np.ndarray, reach2: np.ndarray, whip: np.ndarray) -> np.ndarray:
    v = np.where(reach1 < P_DEAD, "NO TRADE", np.where(reach2 >= P_FULL, "TRADE", "1:1 ONLY"))
    return np.where((v == "TRADE") & (whip >= P_FAST), "TRADE (fast)", v)


def r2(y: np.ndarray, p: np.ndarray) -> float:
    ok = np.isfinite(y) & np.isfinite(p)
    return float(1 - ((y[ok] - p[ok]) ** 2).sum() / ((y[ok] - y[ok].mean()) ** 2).sum())


def rho(a, b) -> float:
    return float(spearmanr(a, b, nan_policy="omit").statistic)


# ----------------------------------------------------------------------------------------------
# evidence: is chop predictable?
# ----------------------------------------------------------------------------------------------

def nanmean_rows(x: np.ndarray) -> np.ndarray:
    n = (~np.isnan(x)).sum(axis=1)
    return np.where(n > 0, np.nansum(x, axis=1) / np.maximum(n, 1), np.nan)


def efficiency(C: np.ndarray, O: np.ndarray, a: int, b: int) -> np.ndarray:
    """Kaufman efficiency of 5m closes over slots [a, b): |net move| / distance travelled (1 = straight line)."""
    p = np.concatenate([O[:, :1], C], axis=1)   # p[:, k] = price at slot k
    seg = p[:, a:b + 1]
    return np.abs(seg[:, -1] - seg[:, 0]) / np.abs(np.diff(seg, axis=1)).sum(axis=1)


def chop_evidence(full: pd.DataFrame, s: Sessions, f: dict) -> dict:
    """Does chop carry over? Last 4 hours vs next 3 hours (time-of-day pattern removed), and day to day."""
    mm = minute_matrix(continuation(full, STOP_PCT / 100), s)
    minute = np.arange(SESSION_MIN)[None, :]
    rows = []
    for k in range(48, SLOTS - HZN + 1, STEP):
        a, b = (k - 48) * 5, k * 5
        settled = minute[:, a:b] + mm["known"][:, a:b] < b       # only answers already known at the decision time
        rows.append(pd.DataFrame({
            "k": k,
            "er_back": efficiency(s.C, s.O, k - 48, k), "er_fwd": efficiency(s.C, s.O, k, k + HZN),
            "cont_back": nanmean_rows(np.where(settled, mm["cont"][:, a:b], np.nan)),
            "cont_fwd": nanmean_rows(mm["cont"][:, b:b + 180]),
            "rv_back": np.sqrt(f["cs"][:, k] - f["cs"][:, k - 48]), "rng_fwd": f["F"][:, k],
        }))
    t = pd.concat(rows).dropna()
    z = t.drop(columns="k").groupby(t.k).transform(lambda x: x - x.mean())
    ok = s.complete
    hi, lo = np.nanmax(s.H, axis=1), np.nanmin(s.L, axis=1)
    er_d = efficiency(s.C[:, 2::3], s.O, 0, SLOTS // 3)[ok]       # 15m closes over the whole session
    rng_d = ((hi - lo) / s.O[:, 0])[ok]
    trend = (np.abs(s.C[:, -1] - s.O[:, 0]) / (hi - lo))[ok] >= 0.6   # closed 60%+ of its range away from the open
    return {
        "points": int(len(t)), "sessions": int(ok.sum()),
        "chopToChop": round(rho(z.er_back, z.er_fwd), 3),        # efficiency last 4h -> efficiency next 3h
        "contToCont": round(rho(z.cont_back, z.cont_fwd), 3),    # 1R moves that ran to 2R, last 4h -> next 3h
        "moveToMove": round(rho(z.rv_back, z.rng_fwd), 3),       # activity last 4h -> range next 3h
        "dayErLag1": round(rho(er_d[1:], er_d[:-1]), 3),
        "dayRangeLag1": round(rho(rng_d[1:], rng_d[:-1]), 3),
        "trendDayBase": round(float(trend.mean()), 3),
        "trendAfterTrend": round(float(trend[1:][trend[:-1]].mean()), 3),
        "trendAfterOther": round(float(trend[1:][~trend[:-1]].mean()), 3),
    }


# ----------------------------------------------------------------------------------------------
# study
# ----------------------------------------------------------------------------------------------

OFFER_KEYS = ("reach1", "reach2", "whip")


def summarise(v: np.ndarray, real: dict[str, np.ndarray]) -> list[dict]:
    t = pd.DataFrame({"verdict": v, **real})
    rows = []
    for name in ("NO TRADE", "1:1 ONLY", "TRADE", "TRADE (fast)"):
        q = t[t.verdict == name]
        if len(q) < 5:
            continue
        rows.append({
            "verdict": name, "n": int(len(q)), "share": round(len(q) / len(t), 3),
            "range": round(float(q.F.median()), 2), "reach1": round(float(q.reach1.mean()), 3),
            "reach2": round(float(q.reach2.mean()), 3), "whip": round(float(q.whip.mean()), 3),
            "win11": round(float(q.p11_win.mean()), 3), "win12": round(float(q.p12_win.mean()), 3),
            "open12": round(float(q.p12_open.mean()), 3), "min11": int(round(q.p11_min.mean())),
            "min12": int(round(q.p12_min.mean())), "r11": round(float(q.p11.mean()), 3), "r12": round(float(q.p12.mean()), 3),
        })
    return rows


def study(full: pd.DataFrame, label: str, thetas: list[float] = THETAS, verbose: bool = True) -> dict:
    s = Sessions.from_1m(full)
    f = features(s)
    n = len(s.days)
    slots = np.arange(STEP, SLOTS - HZN + 1, STEP)

    # --- next-3-hours model (stop-size free: it forecasts the range as a fraction of price) ---
    q, y, d, k = now_rows(f, slots)
    X = response(q)
    coef_now = ols(X, y)
    oos = walk_forward(X, y, d, n)
    raw = f["base"][d, k] * np.exp(oos) * 100                 # forecast 3h range, % of price
    actual = f["F"][d, k] * 100
    ok = np.isfinite(raw) & np.isfinite(actual)
    # calibration: what the range turned out to be at each forecast level (median, made monotone)
    dec = pd.DataFrame({"raw": raw[ok], "actual": actual[ok]})
    g = dec.groupby(pd.qcut(dec.raw, 12), observed=True)
    calib = {"raw": [round(float(v), 4) for v in g.raw.mean()],
             "actual": [round(float(v), 4) for v in isotonic(g.actual.median().to_numpy(), g.size().to_numpy())]}
    fc = calibrate(raw, calib)                                # calibrated forecast, % of price
    ist = (s.open_ist[d] + k * 5) % 1440
    evening = (ist >= EVE_IST[0]) & (ist <= EVE_IST[0] + (EVE_POINTS - 1) * 30)
    third = ok & (d >= n - n // 3)
    skill = {
        "points": int(ok.sum()), "sessions": int(len(set(d[ok]))),
        "rank": round(rho(raw[ok], actual[ok]), 3),
        "rankNormOnly": round(rho(f["base"][d, k][ok], actual[ok]), 3),
        "r2": round(r2(y[ok], oos[ok]), 3),                   # of ln(range / norm): what today's read adds to the norm
        "r2LastThird": round(r2(y[third], oos[third]), 3),
        "calibSlope": round(float(np.polyfit(np.log(raw[ok]), np.log(actual[ok]), 1)[0]), 3),
    }

    # --- tonight model ---
    t = tonight_rows(f, s)
    Xt = response(t.q.to_numpy())
    coef_tonight = ols(Xt, t.y_eve.to_numpy())
    t["oos"] = walk_forward(Xt, t.y_eve.to_numpy(), t.d.to_numpy(), n)
    t["fc"] = calibrate(t.base_eve * np.exp(t.oos) * 100, calib)
    t["ist"] = s.open_ist[t.d] + t.k * 5
    eve_slots = s.eve_slot[:, None] + STEP * np.arange(EVE_POINTS)[None, :]
    rows_i = np.arange(n)[:, None]

    # --- what price offered at each forecast level. In R the picture is the same for every stop size,
    #     so all stop sizes share one lookup. ---
    real, eve_real = {}, {}
    for pct in thetas:
        off = offered(full, s, pct / 100)
        real[pct] = {key: window_mean(v)[d, k] for key, v in off.items()} | {"F": actual / pct}
        eve_real[pct] = {key: np.mean(window_mean(v)[rows_i, eve_slots], axis=1) for key, v in off.items()}
        eve_real[pct]["F"] = np.median(f["F"][rows_i, eve_slots], axis=1) * 100 / pct
    pooled_f = np.concatenate([fc[ok] / pct for pct in thetas])
    offer = {key: lookup(pooled_f, np.concatenate([real[pct][key][ok] for pct in thetas]), F_EDGES, F_GRID) for key in OFFER_KEYS}
    by_stop = {key: {pct: lookup(fc[ok] / pct, real[pct][key][ok], F_EDGES, F_GRID) for pct in thetas} for key in OFFER_KEYS}
    verdicts = lambda f_r: verdict_of(*(offer_at(f_r, offer[key]) for key in OFFER_KEYS))  # noqa: E731

    tables = {}
    for pct in thetas:
        v = verdicts(fc / pct)
        cut = lambda m: {key: x[m] for key, x in real[pct].items()}  # noqa: E731
        tonight = []
        for hhmm in (6 * 60, 9 * 60, 12 * 60, 15 * 60, 17 * 60):
            tq = t[(t.ist == hhmm) & t.oos.notna() & t.y_eve.notna()]
            tonight.append({"ist": f"{hhmm // 60:02d}:{hhmm % 60:02d}", "days": int(len(tq)),
                            "rank": round(rho(tq.fc, eve_real[pct]["F"][tq.d]), 3),
                            "r2": round(r2(tq.y_eve.to_numpy(), tq.oos.to_numpy()), 3),
                            "table": summarise(verdicts(tq.fc.to_numpy() / pct), {key: x[tq.d.to_numpy()] for key, x in eve_real[pct].items()})})
        tables[pct] = {"all": summarise(v[ok], cut(ok)), "evening": summarise(v[ok & evening], cut(ok & evening)),
                       "lastThird": summarise(v[third], cut(third)), "tonight": tonight}

    result = {
        "label": label, "sessions": s, "features": f, "coefNow": coef_now, "coefTonight": coef_tonight,
        "calib": calib, "skill": skill, "offer": offer, "offerByStop": by_stop, "tables": tables,
        "evidence": chop_evidence(full, s, f),
    }
    if verbose:
        report(result)
    return result


def report(r: dict) -> None:
    pd.set_option("display.width", 250, "display.max_columns", 40, "display.float_format", lambda v: f"{v:,.3f}")
    s = r["sessions"]
    print(f"\n================ {r['label']}: {len(s.days)} sessions {s.days[0].date()} -> {s.days[-1].date()} ================")
    print("next-3h  ln(range / norm) = %.3f + %.3f*q + %.3f*q|q|   q = mean(last 2h, today so far) vs norm, in logs" % tuple(r["coefNow"]))
    print("tonight  ln(range / norm) = %.3f + %.3f*q + %.3f*q|q|   q = u*today + (1-u)*yesterday" % tuple(r["coefTonight"]))
    print("walk-forward:", r["skill"])
    print("calibration (forecast % of price -> median outcome):", dict(zip(r["calib"]["raw"], r["calib"]["actual"])))
    print("\nwhat price offered by forecast range in R (all stop sizes pooled):")
    print(pd.DataFrame(r["offer"], index=F_GRID).T.to_string())
    for key in OFFER_KEYS:
        print(f"  {key} by stop size:")
        print(pd.DataFrame(r["offerByStop"][key], index=F_GRID).T.to_string())
    for pct in STOP_TABLES.values():
        if pct not in r["tables"]:
            continue
        print(f"\n--- stop {pct}% of price ---")
        for name in ("all", "evening", "lastThird"):
            print(f"{name}:")
            print(pd.DataFrame(r["tables"][pct][name]).to_string(index=False))
        for e in r["tables"][pct]["tonight"]:
            print(f"tonight, decided {e['ist']} IST: days {e['days']} rank {e['rank']:+.3f} R2 {e['r2']:+.3f} | "
                  + "; ".join(f"{x['verdict']} n={x['n']} reach2 {x['reach2']:.2f} whip {x['whip']:.2f}" for x in e["table"]))
    print("\nchop evidence:", r["evidence"])


# ----------------------------------------------------------------------------------------------
# the live read, exactly as the page computes it (src/lib/day-filter.ts is a port of this)
# ----------------------------------------------------------------------------------------------

def zigzag(price: np.ndarray, theta: float) -> np.ndarray:
    """Signed leg lengths (fraction of price) of a zigzag that turns after a reversal of `theta`.
    The last, still-running leg is included."""
    p = np.asarray(price, dtype=float)
    legs, direction, start, ext, hi, lo = [], 0, 0, 0, 0, 0
    for i in range(1, len(p)):
        if direction == 0:
            hi = i if p[i] > p[hi] else hi
            lo = i if p[i] < p[lo] else lo
            if p[i] >= p[lo] * (1 + theta):
                direction, start, ext = 1, lo, i
            elif p[i] <= p[hi] * (1 - theta):
                direction, start, ext = -1, hi, i
        elif direction == 1:
            if p[i] > p[ext]:
                ext = i
            elif p[i] <= p[ext] * (1 - theta):
                legs.append(p[ext] / p[start] - 1)
                direction, start, ext = -1, ext, i
        else:
            if p[i] < p[ext]:
                ext = i
            elif p[i] >= p[ext] * (1 + theta):
                legs.append(p[ext] / p[start] - 1)
                direction, start, ext = 1, ext, i
    if direction != 0:
        legs.append(p[ext] / p[start] - 1)
    return np.array(legs)


def session_label(now: pd.Timestamp) -> pd.Timestamp:
    """The session `now` belongs to, or the next one to open if the market is shut."""
    day = (now.tz_convert(NY).tz_localize(None) + pd.Timedelta(hours=7)).normalize()
    return day + pd.Timedelta(days={5: 2, 6: 1}.get(day.dayofweek, 0))


def slice_stats(s: Sessions, cs: np.ndarray, i: int, k: int, theta: float) -> dict | None:
    """Session i from its open to slot k: range, net move, efficiency, activity and swing legs."""
    if k < 1 or np.isnan(s.C[i, :k]).any():
        return None
    o, c = s.O[i, 0], s.C[i, :k]
    prices = np.concatenate([[o], c])
    path = np.abs(np.diff(prices)).sum()
    legs = np.abs(zigzag(prices, theta)) / theta
    return {
        "range": float(s.H[i, :k].max() - s.L[i, :k].min()), "net": float(c[-1] - o), "open": float(o),
        "er": float(abs(c[-1] - o) / path) if path > 0 else 0.0, "rv": float(np.sqrt(cs[i, k])),
        "legs": int(len(legs)), "longest": float(legs.max()) if len(legs) else 0.0, "runners": int((legs >= 3).sum()),
    }


def live(m5: pd.DataFrame, now: pd.Timestamp, model: dict, stop_usd: float) -> dict:
    """The page's numbers at `now` from raw 24/7 5-minute bars (indexed by open time)."""
    m5 = m5[m5.index + pd.Timedelta(minutes=5) <= now]                     # closed bars only
    s = Sessions.from_5m(m5)
    label = session_label(now)
    if label not in s.days:                                                # market shut: the next session is still empty
        blank = np.full((1, SLOTS), np.nan)
        s = Sessions(s.days.append(pd.DatetimeIndex([label])), *(np.vstack([x, blank]) for x in (s.O, s.H, s.L, s.C)))
    i = int(s.days.get_indexer([label])[0])
    f = features(s)
    filled = ~np.isnan(s.C[i])
    k = int(filled.argmin()) if not filled.all() else SLOTS                # closed bars so far in this session
    ka = int(s.eve_slot[i])
    price = float(s.C[i, k - 1]) if k else float(m5.close.iloc[-1])
    theta = stop_usd / price
    num = lambda v: None if not np.isfinite(v) else float(v)  # noqa: E731

    def read(raw_pct: float) -> dict | None:
        if not np.isfinite(raw_pct):
            return None
        pct = float(calibrate(raw_pct, model["calib"]))
        f_r = pct / 100 / theta
        p = {key: float(offer_at(f_r, model["offer"][key])) for key in OFFER_KEYS}
        return {"rawPct": float(raw_pct), "pct": pct, "usd": pct / 100 * price, "r": f_r, **p,
                "verdict": str(verdict_of(p["reach1"], p["reach2"], p["whip"]))}

    out = {"session": label.strftime("%Y-%m-%d"), "slot": k, "eveSlot": ka, "price": price,
           "q2": num(f["q2"][i, min(k, SLOTS - 1)]) if k < SLOTS else None,
           "qd": num(f["qd"][i, min(k, SLOTS - 1)]) if k < SLOTS else None, "qy": num(f["qy"][i])}
    # next 3 hours
    now_read = None
    if 1 <= k <= SLOTS - MIN_HZN:
        q = (f["q2"][i, k] + f["qd"][i, k]) / 2
        now_read = read(f["base"][i, k] * math.exp(float(response(np.array([q]))[0] @ model["now"])) * 100)
        if now_read:
            now_read["normPct"], now_read["q"] = float(f["base"][i, k] * 100), float(q)
    out["now"] = now_read
    # tonight (only while the evening has not started)
    tonight = None
    if k <= ka:
        u = k / ka
        qd, qy = (f["qd"][i, k] if k else 0.0), f["qy"][i]
        q = u * (qd if np.isfinite(qd) else 0.0) + (1 - u) * (qy if np.isfinite(qy) else 0.0)
        norm = float(np.median(f["base"][i, ka + STEP * np.arange(EVE_POINTS)]))
        tonight = read(norm * math.exp(float(response(np.array([q]))[0] @ model["tonight"])) * 100)
        if tonight:
            tonight["normPct"], tonight["q"] = norm * 100, float(q)
    out["tonight"] = tonight
    # today so far against yesterday, last week and the last 20 sessions (same slice of each)
    week = label - pd.Timedelta(days=label.dayofweek + 7)
    last_week = [j for j in range(i) if week <= s.days[j] < week + pd.Timedelta(days=7)]
    prior = list(range(max(0, i - BASE_DAYS), i))
    stats = {j: slice_stats(s, f["cs"], j, k, theta) for j in set(prior + last_week + [i])}
    mean_of = lambda js, key, agg: (lambda v: num(agg(v)) if v else None)([stats[j][key] for j in js if stats[j]])  # noqa: E731
    keys = ("range", "er", "rv", "legs", "longest", "runners")
    out["soFar"] = {
        "today": stats[i], "yesterday": stats[i - 1] if i else None,
        "lastWeek": {key: mean_of(last_week, key, np.mean) for key in keys} | {"absNet": mean_of(last_week, "net", lambda v: np.mean(np.abs(v)))},
        "norm": {key: mean_of(prior, key, np.median) for key in keys} | {"absNet": mean_of(prior, "net", lambda v: np.median(np.abs(v)))},
    }
    return out


# ----------------------------------------------------------------------------------------------
# outputs
# ----------------------------------------------------------------------------------------------

def six_month_table(s: Sessions) -> dict:
    """Quantiles of range / net move / efficiency from the open to each half-hour, last SIX_MONTHS full sessions."""
    rows = np.flatnonzero(s.complete)[-SIX_MONTHS:]
    grid = list(range(STEP, SLOTS + 1, STEP))
    stats = so_far(s)
    out = {"from": s.days[rows[0]].strftime("%Y-%m-%d"), "to": s.days[rows[-1]].strftime("%Y-%m-%d"), "sessions": int(len(rows)),
           "quantiles": QUANTILES, "slots": grid}
    for key, digits in (("rangePct", 4), ("netPct", 4), ("er", 4)):
        out[key] = [[round(float(v), digits) for v in np.percentile(stats[key][rows, k], QUANTILES)] for k in grid]
    return out


def to_5m(m1: pd.DataFrame) -> pd.DataFrame:
    g = m1.resample("5min", label="left", closed="left")
    out = g.agg({"open": "first", "high": "max", "low": "min", "close": "last"})
    return out[g.close.count() == 5]


def write_fixture(m1: pd.DataFrame, model: dict) -> None:
    """Raw 5m bars plus the numbers live() gives at assorted moments; the TS port must reproduce them."""
    ist = lambda text: pd.Timestamp(text, tz=IST).tz_convert("UTC")  # noqa: E731
    end = m1.index[-1] + pd.Timedelta(minutes=1)
    today = end.tz_convert(IST).normalize()
    at = lambda days, hhmm: (today + pd.Timedelta(days=days) + pd.Timedelta(hhmm + ":00")).tz_convert("UTC")  # noqa: E731
    windows = [
        (end, [end, at(0, "09:00"), at(0, "13:00"), at(0, "16:55"), at(0, "17:00"), at(-1, "21:02"), at(-1, "23:55"),
               at(0, "00:40"), at(0, "02:45"), at(0, "03:31"), at(-3, "11:00"), at(-4, "22:17"), at(-5, "08:30")]),
        (ist("2026-02-14 12:00"), [ist("2026-02-12 18:30"), ist("2026-02-13 10:00"), ist("2026-02-13 21:45"), ist("2026-02-14 03:10")]),   # New York on winter time
        (ist("2026-03-21 12:00"), [ist("2026-03-09 19:00"), ist("2026-03-10 05:00"), ist("2026-03-18 12:00"), ist("2026-03-20 23:10")]),   # across the US clock change (8 Mar)
    ]
    cases = []
    for stop, (until, moments) in zip((8.0, 6.0, 10.0), windows):
        m5 = to_5m(m1[(m1.index >= until - pd.Timedelta(days=33)) & (m1.index < until)])
        bars = [[int(ts.timestamp() * 1000), o, h, l, c] for ts, o, h, l, c in m5.itertuples()]
        for now in moments:
            cases.append({"bars": len(cases) and None, "now": int(now.timestamp() * 1000), "stop": stop,
                          "expected": live(m5, now, model, stop)})
            cases[-1]["bars"] = bars if now is moments[0] else None       # later cases reuse the window's bars
    (OUT / "day_filter_fixture.json").write_text(json.dumps({"model": model, "cases": cases}))
    print(f"wrote research/output/day_filter_fixture.json ({len(cases)} cases)")


def compact(text: str) -> str:
    """Put each list of numbers on one line."""
    return re.sub(r"\[\s+(-?[\d.e+-]+(?:,\s+-?[\d.e+-]+)*)\s+\]", lambda m: "[" + " ".join(m.group(1).split()) + "]", text)


def write_ts(main: dict, proxy: dict, six: dict, model: dict) -> None:
    s = main["sessions"]
    data = {
        "generated": pd.Timestamp.now(tz=IST).strftime("%Y-%m-%d %H:%M IST"),
        "dataFrom": s.days[0].strftime("%Y-%m-%d"), "dataThrough": s.days[-1].strftime("%Y-%m-%d"), "sessions": int(len(s.days)),
        "stopPct": STOP_PCT, "feePct": FEE_PCT,
        "params": {"slots": SLOTS, "horizon": HZN, "minHorizon": MIN_HZN, "window2h": W2H, "smooth": SMOOTH, "baseDays": BASE_DAYS,
                   "minBase": MIN_BASE, "qClip": round(Q_CLIP, 6), "step": STEP, "eveStartIst": EVE_IST[0], "evePoints": EVE_POINTS},
        "rules": {"dead": P_DEAD, "full": P_FULL, "fast": P_FAST},
        **model,
        "skill": main["skill"],
        "tables": {str(usd): {"stopPct": pct, **main["tables"][pct]} for usd, pct in STOP_TABLES.items()},
        "evidence": main["evidence"],
        "proxy": {"label": proxy["label"], "from": proxy["sessions"].days[0].strftime("%Y-%m-%d"), "to": proxy["sessions"].days[-1].strftime("%Y-%m-%d"),
                  "skill": proxy["skill"], "evidence": proxy["evidence"]},
        "sixMonths": six,
    }
    body = f"""// AUTO-GENERATED by research/day_filter.py on {data["generated"]} - do not edit by hand.
// Re-run: python3 research/fetch_1m.py && python3 research/day_filter.py
import type {{ DayFilterResearch }} from "./day-filter";

export const DAY_FILTER: DayFilterResearch = {compact(json.dumps(data, indent=1))};
"""
    (REPO / "src/lib/day-filter.generated.ts").write_text(body)
    print("wrote src/lib/day-filter.generated.ts")


if __name__ == "__main__":
    perp = pd.read_parquet(path("binance", "XAUUSDT", "1m"))
    perp = perp[perp.index >= perp.index[0] + pd.Timedelta(days=7)]   # skip the listing week
    main = study(perp, "XAUUSDT perp")
    # second look on a different stretch: tokenised gold before the perp listed (fine tick since June 2025)
    paxg = pd.read_parquet(path("binance_spot", "PAXGUSDT", "1m"))
    proxy = study(paxg[(paxg.index >= "2025-06-01") & (paxg.index < perp.index[0])], "PAXG spot, before the perp", thetas=[STOP_PCT], verbose=False)
    print(f"\n{proxy['label']}: skill {proxy['skill']}\n  evidence {proxy['evidence']}")

    model = {"now": [round(float(v), 4) for v in main["coefNow"]], "tonight": [round(float(v), 4) for v in main["coefTonight"]],
             "calib": main["calib"], "offer": {"f": F_GRID, **main["offer"]}}
    write_ts(main, proxy, six_month_table(main["sessions"]), model)
    write_fixture(perp, model)
