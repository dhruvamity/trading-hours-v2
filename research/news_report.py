"""Renders public/news.html: plain-language results of the news-event study (events.py)."""
from __future__ import annotations

import html
import math
import warnings

import numpy as np
import pandas as pd

from common import ROOT
from report import CSS

OUT_HTML = ROOT.parent / "public" / "news.html"
IST_SUMMER = {"08:30": "18:00", "10:00": "19:30", "14:00": "23:30", "16:20": "01:50 (+1)", "16:00 London": "20:30"}
IST_WINTER = {"08:30": "19:00", "10:00": "20:30", "14:00": "00:30 (+1)", "16:20": "02:50 (+1)", "16:00 London": "21:30"}
RELEASE_ET = {"FOMC": "14:00", "CPI": "08:30", "NFP": "08:30", "PCE": "08:30", "PPI": "08:30", "RETAIL": "08:30",
              "GDP": "08:30", "ISM_MFG": "10:00", "ISM_SERV": "10:00", "JACKSON": "10:00", "JOLTS": "10:00",
              "CLAIMS": "08:30", "NVDA": "16:20", "MONTH_END": "16:00 London", "QUARTER_END": "16:00 London"}

EXTRA_CSS = """
.verdict{font-weight:600}.good{color:var(--prime)}.bad{color:var(--stop)}.warn{color:var(--small)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);margin:12px 0}
.kpis div{background:var(--panel);padding:10px 12px}.kpis b{display:block;font:600 18px "IBM Plex Mono",monospace;margin-top:2px}
.kpis span{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
svg text{font:10px "IBM Plex Mono",monospace;fill:var(--muted)}
td.big{font-weight:600}
"""


def pct(v) -> str:
    return "-" if v is None or (isinstance(v, float) and math.isnan(v)) else f"{round(100 * v)}%"


def x(v, d=1) -> str:
    return "-" if v is None or (isinstance(v, float) and math.isnan(v)) else f"{v:.{d}f}×"


def mins(v: int) -> str:
    return f"{v // 60}h {v % 60:02d}m" if v >= 60 else f"{v}m"


# Same minimum stand-aside by tier as src/lib/events.ts (FLOOR), so the page matches the terminal.
FLOOR = {1: (30, 45), 2: (15, 30), 3: (5, 15)}
QUIET = {"MONTH_END", "QUARTER_END", "NVDA"}


def stand_aside(g) -> str:
    """g is one summary row, named (instrument, kind)."""
    if g.name[1] in QUIET:
        return "no block (listed only)"
    before, after = FLOOR.get(int(g["tier"]), (5, 15))
    before = max(before, int(-g["danger_from_min"]))
    after = min(180, max(after, int(g["settle_min"])))
    return f"−{mins(before)} → +{mins(after)}"


DASHED = 'stroke-dasharray="5 3"'


def footprint_svg(gold: list, btc: list, bins: list[int]) -> str:
    """Median 15-min range vs normal, -3h..+6h around the release. Gold solid, BTC dashed."""
    w, h, pad = 560, 150, 28
    ymax = 6.0
    n = len(bins)
    xs = lambda i: pad + i * (w - pad - 8) / (n - 1)  # noqa: E731
    ys = lambda v: h - 18 - min(v, ymax) / ymax * (h - 30)  # noqa: E731

    def line(vals, dash, color):
        pts = [f"{xs(i):.1f},{ys(v):.1f}" for i, v in enumerate(vals) if v is not None and not math.isnan(v)]
        return f'<polyline fill="none" stroke="{color}" stroke-width="1.6" {dash} points="{" ".join(pts)}"/>'

    zero = xs(bins.index(0))
    grid = "".join(f'<line x1="{pad}" x2="{w - 8}" y1="{ys(v):.1f}" y2="{ys(v):.1f}" stroke="#262c34"/>'
                   f'<text x="2" y="{ys(v) + 3:.1f}">{v:g}×</text>' for v in (1, 2, 4, 6))
    ticks = "".join(f'<text x="{xs(bins.index(m)) - 8:.1f}" y="{h - 4}">{"+" if m > 0 else ""}{m // 60}h</text>'
                    for m in (-180, -120, -60, 0, 60, 120, 180, 240, 300) if m in bins)
    return (f'<svg viewBox="0 0 {w} {h}" width="100%" role="img" aria-label="Range around the release vs normal">'
            f'{grid}<line x1="{zero:.1f}" x2="{zero:.1f}" y1="8" y2="{h - 16}" stroke="#c26a62" stroke-dasharray="3 3"/>'
            f'<line x1="{pad}" x2="{w - 8}" y1="{ys(1):.1f}" y2="{ys(1):.1f}" stroke="#8b929d" stroke-dasharray="2 4"/>'
            f'{line(gold, "", "#c9a95c")}{line(btc, DASHED, "#6f9fd8")}{ticks}</svg>')


def curve_svg(gold: list, btc: list, hours: list[int]) -> str:
    """Hour-by-hour range vs clean weeks, -72h..+24h, 6h rolling median. Gold solid, BTC dashed."""
    w, h, pad = 560, 150, 30
    lo_v, hi_v = 0.5, 2.0
    smooth = lambda v: pd.Series(v, dtype=float).rolling(6, min_periods=3, center=True).median().tolist()  # noqa: E731
    xs = lambda i: pad + i * (w - pad - 8) / (len(hours) - 1)  # noqa: E731
    ys = lambda v: h - 18 - (min(max(v, lo_v), hi_v) - lo_v) / (hi_v - lo_v) * (h - 30)  # noqa: E731

    def line(vals, dash, color):
        pts = [f"{xs(i):.1f},{ys(v):.1f}" for i, v in enumerate(smooth(vals)) if v == v]
        return f'<polyline fill="none" stroke="{color}" stroke-width="1.6" {dash} points="{" ".join(pts)}"/>'

    grid = "".join(f'<line x1="{pad}" x2="{w - 8}" y1="{ys(v):.1f}" y2="{ys(v):.1f}" stroke="#262c34"/>'
                   f'<text x="2" y="{ys(v) + 3:.1f}">{v:g}×</text>' for v in (0.5, 1, 1.5, 2))
    zero = xs(hours.index(0))
    ticks = "".join(f'<text x="{xs(hours.index(m)) - 10:.1f}" y="{h - 4}">{"+" if m > 0 else ""}{m}h</text>'
                    for m in (-72, -48, -24, 0, 24) if m in hours)
    days = "".join(f'<line x1="{xs(hours.index(m)):.1f}" x2="{xs(hours.index(m)):.1f}" y1="8" y2="{h - 16}" stroke="#262c34" stroke-dasharray="2 3"/>'
                   for m in (-48, -24) if m in hours)
    return (f'<svg viewBox="0 0 {w} {h}" width="100%" role="img" aria-label="Range per hour vs clean weeks">'
            f'{grid}{days}<line x1="{zero:.1f}" x2="{zero:.1f}" y1="8" y2="{h - 16}" stroke="#c26a62" stroke-dasharray="3 3"/>'
            f'<line x1="{pad}" x2="{w - 8}" y1="{ys(1):.1f}" y2="{ys(1):.1f}" stroke="#8b929d" stroke-dasharray="2 4"/>'
            f'{line(gold, "", "#c9a95c")}{line(btc, DASHED, "#6f9fd8")}{ticks}</svg>')


def pre_news_section(pre: pd.DataFrame | None, prof: pd.DataFrame | None) -> str:
    if pre is None:
        return ""
    names = {"FOMC": "FOMC (Fed decision)", "CPI": "CPI", "NFP": "Jobs report (NFP)", "PCE": "Core PCE"}
    tables = []
    for inst, label in (("GOLD", "Gold"), ("BTC", "BTC")):
        rows = []
        for kind in ("FOMC", "CPI", "NFP", "PCE"):
            r = pre[(pre.instrument == inst) & (pre.kind == kind)]
            if r.empty:
                continue
            r = r.iloc[0]
            cell = lambda v: f"<td class='num {'good' if v >= 1.08 else 'bad' if v <= 0.92 else ''}'>{x(v, 2)}</td>"  # noqa: E731
            rows.append(
                f"<tr><td class='big'>{names[kind]}</td><td class='num'>{int(r.n)}</td>"
                + "".join(cell(r[f"D-2 {tf}"]) for tf in ("5m", "15m", "1h", "4h"))
                + cell(r["D-2 1d range"])
                + "".join(cell(r[f"D-1 {tf}"]) for tf in ("5m", "15m", "1h", "4h"))
                + cell(r["D-1 1d range"])
                + f"<td class='num'>{pct(r['D-1 1d inside%'])} <span class='muted'>({pct(r['D-1 1d inside base%'])})</span></td>"
                + cell(r["next 24h 1h"])
                + f"<td>{html.escape(r.verdict)}</td></tr>")
        tables.append(
            f"<h3>{label}</h3><div class='scroll'><table><thead>"
            "<tr><th></th><th></th><th colspan='5'>2 days before</th><th colspan='5'>The day before</th><th></th><th></th><th></th></tr>"
            "<tr><th>Release</th><th>Events</th><th>5m</th><th>15m</th><th>1h</th><th>4h</th><th>1d</th>"
            "<th>5m</th><th>15m</th><th>1h</th><th>4h</th><th>1d</th><th>Inside day (normal)</th><th>24h after</th><th>Verdict</th></tr>"
            "</thead><tbody>" + "".join(rows) + "</tbody></table></div>")
    charts = ""
    warnings.filterwarnings("ignore", "All-NaN slice")  # gold's weekend hours have no bars in any event
    if prof is not None and len(prof):
        hours = list(range(-72, 24))
        cards = []
        for kind in ("FOMC", "CPI", "NFP", "PCE"):
            med = lambda inst: np.nanmedian(np.vstack(prof[(prof.instrument == inst) & (prof.kind == kind)].profile.tolist()), axis=0).tolist()  # noqa: E731
            cards.append(f"<div class='panel'><h3 style='margin-top:0'>{names[kind]}</h3>{curve_svg(med('GOLD'), med('BTC'), hours)}"
                         "<p class='muted' style='font-size:12px;margin:4px 0 0'>Gold (solid) / BTC (dashed): hourly range vs the same "
                         "hours in clean weeks, 6-hour median. Below 1× = quieter. Dotted lines = 48h and 24h before; red = release.</p></div>")
        charts = f"<div class='grid2'>{''.join(cards)}</div>"
    return f"""
<h2>Does the market stall in the days before big news?</h2>
<p>Each release is compared with the <b>same weekday and New York time on up to 8 recent clean weeks</b> (no FOMC, CPI, NFP or PCE
from 72h before to 24h after). Numbers are how much price moves per bar on that timeframe vs those clean weeks, so 1× = a normal week.
<span class="bad">Red ≤ 0.92×</span> = quieter, <span class="good">green ≥ 1.08×</span> = busier. <b>1d</b> = that day's high–low range vs clean weeks.
An inside day stays within the previous day's high and low.</p>
{''.join(tables)}
<p>The stall is real before <b>FOMC</b>: on both gold and BTC the two days before are quieter and the day before has a smaller range
(gold also forms inside days about twice as often). Then the 24 hours after move far more than normal. Before <b>CPI, NFP and PCE</b>
there is no stall, and the week of the jobs report is busier than normal because ADP, ISM, JOLTS and jobless claims all land in it.</p>
{charts}
"""


def write_news_html(summary: pd.DataFrame, per_event: pd.DataFrame, data_through: pd.Timestamp,
                    pre: pd.DataFrame | None = None, pre_prof: pd.DataFrame | None = None):
    bins = list(range(-180, 346, 15))
    s = summary.set_index(["instrument", "kind"])
    gold = summary[summary.instrument == "GOLD"].assign(few=lambda d: d.n < 8)
    order = gold.sort_values(["few", "tier", "first15_range"], ascending=[True, True, False]).kind.tolist()

    # ── one-screen rules table
    rows = []
    for kind in order:
        g = s.loc[("GOLD", kind)]
        b = s.loc[("BTC", kind)] if ("BTC", kind) in s.index else None
        et = RELEASE_ET[kind]
        rows.append(
            f"<tr><td class='big'>{html.escape(g['name'])}</td>"
            f"<td class='mono'>{IST_SUMMER[et]}<br><span class='muted'>{IST_WINTER[et]} winter</span></td>"
            f"<td class='num'>{int(g['n'])}</td>"
            f"<td class='mono'>{stand_aside(g)}</td>"
            f"<td class='num'>{x(g['first15_range'])}</td>"
            f"<td class='num'>{pct(g['whipsaw'])} <span class='muted'>({pct(g['whipsaw_base'])})</span></td>"
            f"<td class='num'>{pct(g['follow15'])}</td>"
            f"<td class='num'>{g['trade15_avg_r']:+.2f}R</td>"
            f"<td>{html.escape(g['advice'])}</td>"
            f"<td class='num'>{x(b['first15_range']) if b is not None else '-'}</td>"
            f"<td>{html.escape(b['advice']) if b is not None else '-'}</td></tr>")
    rules = ("<div class='scroll'><table><thead><tr><th>Release</th><th>IST (US summer)</th><th>Events</th>"
             "<th>Gold: stand aside</th><th>Gold: first 15 min size</th><th>Gold: wicks both ways</th>"
             "<th>Gold: first move continues</th><th>Gold: trade-after-15m test</th><th>Gold: what to do</th>"
             "<th>BTC: first 15 min</th><th>BTC: what to do</th></tr></thead><tbody>"
             + "".join(rows) + "</tbody></table></div>")

    # ── pre-news chop
    pre_rows = []
    for kind in order:
        g = s.loc[("GOLD", kind)]
        pre_rows.append(
            f"<tr><td>{html.escape(g['name'])}</td><td class='num'>{x(g['pre_session_range'], 2)}</td>"
            f"<td class='num'>{g['pre_session_chop']:+.3f}</td><td class='num'>{x(g['pre60_range'], 2)}</td>"
            f"<td class='num'>{x(g['pre30_range'], 2)}</td><td class='num'>{x(g['m120_240_range'], 2)}</td>"
            f"<td class='num'>{g['rest_of_day_er']:.2f} <span class='muted'>({g['rest_of_day_er_base']:.2f})</span></td></tr>")
    pre_table = ("<div class='scroll'><table><thead><tr><th>Release</th><th>5h before: range</th><th>5h before: trendiness vs normal</th>"
           "<th>60-30m before: range</th><th>last 30m: range</th><th>+2h to +4h: range</th>"
           "<th>+4h to +8h trendiness (normal)</th></tr></thead><tbody>" + "".join(pre_rows) + "</tbody></table></div>")

    # ── footprints
    cards = []
    for kind in order:
        g = s.loc[("GOLD", kind)]
        b = s.loc[("BTC", kind)] if ("BTC", kind) in s.index else None
        cards.append(
            f"<div class='panel'><h3 style='margin-top:0'>{html.escape(g['name'])}</h3>"
            f"{footprint_svg(g['profile'], b['profile'] if b is not None else [], bins)}"
            f"<p class='muted' style='font-size:12px;margin:4px 0 0'>Gold (solid) / BTC (dashed): median 15-minute range "
            f"relative to the same clock time on quiet days. 1× = normal. Red line = release.</p></div>")

    # ── recent examples (last 6 tier-1/2 gold events)
    recent = per_event[(per_event.instrument == "GOLD")].sort_values("time").tail(12)
    ex_rows = "".join(
        f"<tr><td class='mono'>{r.time.tz_convert('Asia/Kolkata'):%d %b %Y %H:%M}</td><td>{html.escape(r.kind)}</td>"
        f"<td class='num'>{x(r.pre330_30_rr, 2)}</td><td class='num'>{x(r.first15_rr)}</td>"
        f"<td>{'yes' if r.whipsaw else 'no'}</td><td>{'yes' if r.follow15 else 'no'}</td>"
        f"<td class='num'>{'-' if r.trade15_r is None or (isinstance(r.trade15_r, float) and math.isnan(r.trade15_r)) else f'{r.trade15_r:+.1f}R'}</td></tr>"
        for r in recent.itertuples())
    examples = ("<div class='scroll'><table><thead><tr><th>IST</th><th>Event</th><th>5h before range</th><th>First 15m range</th>"
                "<th>Wicked both ways</th><th>First move continued</th><th>Trade-after-15m</th></tr></thead><tbody>"
                + ex_rows + "</tbody></table></div>")

    n_gold = int((per_event.instrument == "GOLD").sum())
    body = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>News Study</title><style>{CSS}{EXTRA_CSS}</style></head><body><main>
<nav><a href="/">← Trading hours</a><a href="/report.html">Session research</a></nav>
<h1>What US news does to gold and BTC</h1>
<p class="muted">{n_gold} gold releases and the same for BTC, {pd.Timestamp('2023-09-01'):%b %Y} – {data_through:%d %b %Y}, 1-minute candles.
Every number compares the event day with the same New York clock time on the previous 20 quiet weekdays, so <b>1× = a normal day</b>.</p>

<h2>The rules, in one table</h2>
<p><b>Stand aside</b> = from when the market starts getting abnormal before the release, until the 15-minute range is back under 1.5× normal.
<b>Wicks both ways</b> = in the first 30 minutes price went at least half a normal 30-minute range above <i>and</i> below the release price (the number in brackets is how often that happens on a quiet day).
<b>Trade-after-15m test</b> = wait 15 minutes, enter in the direction of those 15 minutes, stop just beyond their high/low, take profit at 2× the risk or exit after 2 hours. Average result per trade in R (risk units). Positive = the first move tends to carry on.</p>
{rules}

<h2>Is the market choppy before the news?</h2>
<p>This is the "gold is going nowhere all day before 6 PM" question. Range below 1× = quieter than normal; trendiness below 0 = more back-and-forth than normal.</p>
{pre_table}

{pre_news_section(pre, pre_prof)}

<h2>Footprints</h2>
<p>How long each release disturbs the market, before and after.</p>
<div class="grid2">{"".join(cards)}</div>

<h2>Most recent gold releases</h2>
{examples}

<h2>How to use this</h2>
<ul>
<li>The terminal's <b>News check</b> panel uses these stand-aside windows automatically and shades them on the 24-hour rail.</li>
<li>Scheduled releases only. Fed speakers, tariff headlines, and wars are not in the calendar — check a live calendar (e.g. Forex Factory) each morning.</li>
<li>Gold history before Dec 2025 is Binance PAXGUSDT (tokenised gold); it tracks spot closely but has thinner liquidity, so spikes may look slightly larger than on XAUUSD.</li>
<li>Re-run monthly: <code>python3 research/fetch_1m.py &amp;&amp; python3 research/events.py</code>.</li>
</ul>
<p class="muted">Statistics, not advice. Generated {pd.Timestamp.now(tz='Asia/Kolkata'):%d %b %Y}.</p>
</main></body></html>"""
    OUT_HTML.write_text(body)
    print(f"wrote {OUT_HTML.relative_to(ROOT.parent)}")
