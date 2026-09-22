"""Renders the self-contained HTML research report (public/report.html)."""
from __future__ import annotations

import html

import numpy as np
import pandas as pd

DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
LABEL = {"BTCUSDT": "BTCUSDT perpetual (Binance)", "XAUUSDT": "Gold - XAUUSDT perpetual (Binance) / XAUUSD spot history"}
REGIME_LABEL = {"summer": "US summer time (EDT, ~2nd Sun Mar - 1st Sun Nov)", "winter": "US winter time (EST, ~1st Sun Nov - 2nd Sun Mar)"}

GOLD_SRC = {
    "dukascopy": "Dukascopy XAUUSD spot (1m)",
    "mt5": "MetaTrader 5 XAUUSD",
    "blend": "Dukascopy XAUUSD spot (Sep 2022 - Oct 2023) and Binance PAXGUSDT spot from the month its tick became fine "
             "(tokenised gold, 1 PAXG = 1 oz, masked to gold-market hours)",
}

ANCHORS = [
    ("Tokyo cash open", "05:30", "05:30"),
    ("China / Shanghai gold open", "06:30", "06:30"),
    ("Frankfurt / London open", "11:30 / 12:30", "12:30 / 13:30"),
    ("US macro data (CPI, NFP, claims) 08:30 ET", "18:00", "19:00"),
    ("COMEX gold floor open 08:20 ET", "17:50", "18:50"),
    ("NY equity cash open 09:30 ET", "19:00", "20:00"),
    ("London gold PM fix 15:00 London", "19:30", "20:30"),
    ("London close 16:30", "21:00", "22:00"),
    ("FOMC statement 14:00 ET (Wed)", "23:30", "00:30 (Thu)"),
    ("NY equity close 16:00 ET", "01:30 (+1)", "02:30 (+1)"),
    ("Gold daily break 17:00-18:00 ET", "02:30-03:30", "03:30-04:30"),
    ("CME weekly open Sun 18:00 ET", "Mon 03:30", "Mon 04:30"),
]

CSS = """
:root{--bg:#111418;--panel:#171b20;--line:#262c34;--fg:#d5d9e0;--muted:#8b929d;--prime:#5fb58a;--swing:#6f9fd8;--small:#c9a95c;--stop:#c26a62;--closed:#4a4f58}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 "IBM Plex Sans",system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:32px 16px 80px}h1{font-size:26px;margin:0 0 4px}h2{font-size:19px;margin:48px 0 8px;padding-top:16px;border-top:1px solid var(--line)}
h3{font-size:15px;margin:28px 0 6px}h4{font-size:13px;margin:18px 0 4px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
p,li{color:#c3c8d0;max-width:78ch}.muted{color:var(--muted)}code,.mono{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:12px}
table{border-collapse:collapse;width:100%;margin:8px 0 16px;font-size:12.5px}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{color:var(--muted);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.06em}td.num{text-align:right;font-family:"IBM Plex Mono",monospace}
img{max-width:100%;display:block;margin:8px 0;border:1px solid var(--line)}.panel{background:var(--panel);border:1px solid var(--line);padding:14px 16px;margin:12px 0}
.pill{display:inline-block;font:600 10px "IBM Plex Mono",monospace;padding:2px 6px;border:1px solid currentColor}
.PRIME{color:var(--prime)}.SWING{color:var(--swing)}.SMALL{color:var(--small)}.NO{color:var(--stop)}.CLOSED{color:var(--closed)}
nav a{color:var(--muted);margin-right:14px;font-size:12px}a{color:#8fb3de}.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.scroll{overflow-x:auto}
"""


def pill(status: str) -> str:
    return f'<span class="pill {status.split()[0]}">{html.escape(status)}</span>'


def fmt(v, d=2):
    return "-" if v is None or (isinstance(v, float) and np.isnan(v)) else f"{v:.{d}f}"


def table(df: pd.DataFrame, num_cols=None) -> str:
    num_cols = num_cols or [c for c in df.columns if pd.api.types.is_numeric_dtype(df[c])]
    head = "".join(f"<th>{html.escape(str(c))}</th>" for c in df.columns)
    rows = []
    for _, r in df.iterrows():
        cells = []
        for c in df.columns:
            v = r[c]
            if c in num_cols:
                cells.append(f'<td class="num">{fmt(float(v), 3 if abs(float(v)) < 10 else 0)}</td>')
            else:
                cells.append(f"<td>{v}</td>")
        rows.append("<tr>" + "".join(cells) + "</tr>")
    return f'<div class="scroll"><table><thead><tr>{head}</tr></thead><tbody>{"".join(rows)}</tbody></table></div>'


def day_table(wins: list[dict]) -> str:
    rows = []
    for w in wins:
        rows.append(
            f"<tr><td class='mono'>{w['start']} - {w['end']}</td><td>{pill(w['status'])}</td>"
            f"<td class='num'>{fmt(w['score'])}</td><td class='num'>{fmt(w['move'], 3)}</td><td class='num'>{fmt(w['movePct'], 3)}</td>"
            f"<td class='num'>{fmt(w['efficiency'])}</td><td class='num'>{fmt(w['followThrough'])}</td>"
            f"<td class='num'>{fmt(w['consistency'])}</td><td class='muted'>{html.escape(w['note'])}</td></tr>")
    return ("<div class='scroll'><table><thead><tr><th>IST window</th><th>Status</th><th>Score</th><th>Move/ATR</th><th>1h move %</th>"
            "<th>Efficiency</th><th>Follow-thru</th><th>Consistency</th><th>Why</th></tr></thead><tbody>"
            + "".join(rows) + "</tbody></table></div>")


def top_slots(cls: pd.DataFrame, regime: str, n=8) -> pd.DataFrame:
    g = cls[(cls["regime"] == regime) & cls["scope"] & ~cls["closed"]].copy()
    g["IST"] = g["slot"].map(lambda s: f"{s * 30 // 60:02d}:{s * 30 % 60:02d}")
    cols = ["day", "IST", "score", "movepct", "disp60", "beats", "swing", "er60", "ft"]
    best = g.sort_values("score", ascending=False).head(n)[cols]
    worst = g.sort_values("score").head(n)[cols]
    return best, worst


def bias_rows(cls: pd.DataFrame) -> pd.DataFrame:
    g = cls[cls["scope"] & ~cls["closed"] & (cls["bias_t"].abs() >= 2.5)].copy()
    if g.empty:
        return g
    g["IST"] = g["slot"].map(lambda s: f"{s * 30 // 60:02d}:{s * 30 % 60:02d}")
    g["direction"] = np.where(g["net60"] > 0, "up", "down")
    return g.sort_values("bias_t", key=abs, ascending=False)[["regime", "day", "IST", "direction", "p_up", "net60", "bias_t"]].head(12)


def narrative(inst: str, regime: str, day: str, wins: list[dict]) -> str:
    trade = [w for w in wins if w["status"] in ("PRIME", "SWING ENTRY", "SMALL TRADES")]
    prime = [w for w in wins if w["status"] in ("PRIME", "SWING ENTRY")]
    hours = lambda ws: sum((int(w["end"][:2]) * 60 + int(w["end"][3:]) - int(w["start"][:2]) * 60 - int(w["start"][3:])) for w in ws) / 60  # noqa: E731
    parts = [f"{hours(trade):.1f}h of the day is tradeable, {hours(prime):.1f}h of it prime/swing quality."]
    if prime:
        parts.append("Focus windows: " + ", ".join(f"<b>{w['start']}-{w['end']}</b> ({w['status'].lower()})" for w in prime) + ".")
    no = sorted([w for w in wins if w["status"] == "NO TRADE"], key=lambda w: -hours([w]))[:2]
    if no:
        parts.append("Longest stand-aside blocks: " + ", ".join(f"{w['start']}-{w['end']}" for w in no) + ".")
    return " ".join(parts)


def build_report(results, meta, cross, p, args, coverage, ginfo, weekly, fns) -> str:
    heatmap, schedule_chart, profile_chart, windows = fns["heatmap"], fns["schedule_chart"], fns["profile_chart"], fns["windows"]
    out = [f"<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
           f"<title>IST Session Research</title><style>{CSS}</style></head><body><main>"]
    out.append("<h1>IST session research - BTC & Gold perps</h1>")
    out.append(f"<p class='muted'>Generated {meta['generated']} - data through {meta['dataThrough']} - recency half-life {meta['halfLifeWeeks']:.0f} weeks. "
               "<a href='/'>Back to terminal</a></p>")
    out.append("<nav>" + "".join(f"<a href='#{a}'>{t}</a>" for a, t in [("summary", "Summary"), ("method", "Method"), ("data", "Data"),
                                                                        ("BTCUSDT", "BTC"), ("XAUUSDT", "Gold"), ("findings", "Findings"), ("validation", "Validation"),
                                                                        ("anchors", "Session clock"), ("caveats", "Caveats")]) + "</nav>")

    # summary
    out.append("<h2 id='summary'>Executive summary</h2><div class='grid2'>")
    for inst, r in results.items():
        val = r["val"]
        tradeable = val.drop(index=[i for i in ["NO TRADE"] if i in val.index])
        lift = (tradeable["move"] * tradeable["slots"]).sum() / tradeable["slots"].sum() / val.loc["NO TRADE", "move"] if "NO TRADE" in val.index else np.nan
        eff = (tradeable["efficiency"] * tradeable["slots"]).sum() / tradeable["slots"].sum() / val.loc["NO TRADE", "efficiency"] if "NO TRADE" in val.index else np.nan
        out.append(f"<div class='panel'><h3 style='margin-top:0'>{LABEL[inst]}</h3><ul>"
                   f"<li>Out-of-sample (last 12 months, unseen): trade windows moved <b>{lift:.2f}x</b> more per hour than NO TRADE windows, "
                   f"with <b>{eff:.2f}x</b> the trend efficiency.</li>"
                   f"<li>Slot-score rank correlation, train vs unseen year: <b>{r['rho']:.2f}</b> (0 = no persistence, 1 = identical).</li>"
                   + "".join(f"<li>{row['period']}: profile rank-corr {row['rank_corr_vs_last_12m']:.2f} vs last 12 months</li>" for _, row in r["stab"].iterrows())
                   + "</ul></div>")
    out.append("</div>")
    out.append("<p><b>What the data says.</b> <i>How much</i> price moves in a given IST half-hour is strongly persistent: the same windows "
               "(Asia open, London open, US data and cash open, the London fix, the US afternoon) keep delivering the big displacements year after year. "
               "<i>Whether</i> a window trends cleanly or chops is not predictable from the clock: efficiency, clarity and follow-through by slot "
               "do not carry over to unseen data. And the <i>direction</i> in any window is close to a coin-flip (see the bias tables). "
               "So NO TRADE here means: the typical move is too small relative to noise, stops and fees to be worth the risk. "
               "Inside a trade window you still need your own setup to judge direction and chop.</p>")
    fee_rows = []
    for inst, r in results.items():
        v = r["val"]
        for st in v.index:
            fee_rows.append({"instrument": inst, "status": st, "avg 1h net move %": v.loc[st, "move_pct"],
                             "0.10% round-trip fee as % of move": 10.0 / v.loc[st, "move_pct"]})
    out.append("<h4>Cost of trading quiet hours (last 12 months, unseen)</h4>" + table(pd.DataFrame(fee_rows)))

    # method
    out.append("<h2 id='method'>Method</h2><ol>"
               "<li><b>Grid.</b> Each IST weekday split into 48 half-hour slots. Candles: 5m (slot and 60-min horizon), 15m (4h swing horizon), "
               "1d (ATR normalisation), 1h + 1w (weekly-range context). BTC from Binance USD-M; gold from Binance XAUUSDT perp since listing "
               f"({meta['goldSplice']}), spliced onto {GOLD_SRC.get(meta['goldHistorySource'], meta['goldHistorySource'])} for the years before.</li>"
               "<li><b>Two clocks.</b> London/NY events move 1h in IST when the US/UK change clocks, so every slot is estimated separately for US summer "
               "and US winter time. The 2-3 weeks a year when US and UK DST disagree are excluded from training.</li>"
               "<li><b>Per-slot metrics</b> (all normalised by the trailing 20-day ATR, known before the day starts):"
               "<ul><li><i>Move</i> = |net change over the next 60 min| / ATR - how far price actually travelled.</li>"
               "<li><i>Efficiency</i> = |net| / path length of 5m closes (Kaufman ER) - 1 is a straight line, near 0 is chop.</li>"
               "<li><i>Clarity</i> = |up excursion - down excursion| / total range - does the hour go one way, or whip both sides?</li>"
               "<li><i>Follow-through</i> = P(next 60 min continues the previous 30 min's direction).</li>"
               "<li><i>Consistency</i> = share of weeks the slot beat that day's median slot.</li>"
               "<li><i>Swing</i> = 4h |net| / ATR x 4h efficiency on 15m bars.</li></ul></li>"
               f"<li><b>Recency weighting.</b> Each week weighted 0.5^(age/{meta['halfLifeWeeks']:.0f} weeks): last month ~1.0, 1 year ago 0.5, 3 years ago 0.125. "
               "Extreme days winsorised at the 99th percentile so one crash day cannot define a slot.</li>"
               "<li><b>Metric selection by evidence.</b> Every metric was tested for persistence: does its time-of-day pattern in the training years "
               "reappear in the unseen last 12 months? Net displacement (how far price travels) persists strongly; efficiency, clarity and follow-through "
               "(trend-vs-chop character) do not (see <a href='#findings'>findings</a>). The score is therefore built only from what persists; the others are reported, not used.</li>"
               "<li><b>Score</b> = recency-weighted mean |net 60-min move| / ATR, divided by the median slot. 1.00 = a typical half-hour. "
               "<b>Swing</b> = 4h net move / median x sqrt(4h efficiency / median). Both smoothed with a [1,2,1] kernel across neighbouring half-hours.</li>"
               f"<li><b>Status rules.</b> NO TRADE: score below the {p.no_trade_pct:.0%} percentile of open weekday slots. "
               f"PRIME: score in the top {1 - p.prime_pct:.0%} and beats the day's median slot in &ge; {p.prime_consistency:.0%} of weeks. "
               f"SWING ENTRY: swing score in the top {1 - p.swing_pct:.0%} with above-median slot activity and 4h efficiency. SMALL TRADES: everything else that is open. "
               "CLOSED: market shut in &gt;50% of weeks. Lone 30-min fragments are merged into their neighbours.</li>"
               "<li><b>Weekend.</b> Saturday after 04:00 IST and all of Sunday are excluded by design.</li>"
               "<li><b>Validation.</b> The timetable is rebuilt using only data up to 12 months ago, frozen, and scored on the most recent 12 months.</li></ol>")

    # data
    out.append("<h2 id='data'>Data coverage</h2>")
    out.append(table(pd.DataFrame(coverage), num_cols=["bars"]))
    if meta.get("goldGaps"):
        out.append(f"<p><b>Gold history gap:</b> {meta['goldGaps']} is intentionally left out. Dukascopy blocks bulk downloads beyond what was cached, "
                   "and PAXG in that period traded on a $1 tick with heavy bid-ask bounce (table below), which would corrupt 5-minute statistics. "
                   "Fill it with MetaTrader 5 (research/fetch_mt5.py on Windows) or a full Dukascopy export and re-run.</p>")
        if "paxg_quality" in ginfo:
            out.append("<h4>PAXG 5m data quality by quarter</h4>" + table(ginfo["paxg_quality"]))
    out.append("<h3>Gold feed cross-checks</h3>")
    out.append(table(pd.DataFrame(cross), num_cols=["bars", "ret_corr_5m", "mean_basis_pct", "slot_profile_rank_corr", "range_ratio"]))
    out.append("<p class='muted'>ret_corr_5m: correlation of 5-minute returns on shared bars. slot_profile_rank_corr: do both feeds agree on which "
               "IST half-hours are active? range_ratio: average 5m range of the history feed relative to the reference. High profile correlation means the "
               "multi-year history is a valid stand-in for the perp's session structure, which is the only thing the timetable uses.</p>")

    for inst, r in results.items():
        cls = r["cls"]
        out.append(f"<h2 id='{inst}'>{LABEL[inst]}</h2>")
        wk = weekly[inst].reset_index()
        wk.columns = ["IST day", "share of weekly range", "P(makes weekly high)", "P(makes weekly low)"]
        out.append("<h4>Weekly context (1h + 1w candles)</h4>" + table(wk))
        for regime in ["summer", "winter"]:
            out.append(f"<h3>{REGIME_LABEL[regime]}</h3>")
            out.append(f"<img alt='timetable' src='{schedule_chart(cls, regime, f'{inst} timetable - {regime}')}'>")
            out.append(f"<img alt='score heatmap' src='{heatmap(cls, regime, 'score', 'Intraday score (1 = typical)', 'magma')}'>")
            out.append(f"<img alt='efficiency heatmap' src='{heatmap(cls, regime, 'er60', '60-min efficiency ratio (trend vs chop)', 'viridis')}'>")
            out.append(f"<img alt='swing heatmap' src='{heatmap(cls, regime, 'swing', '4h swing score', 'cividis')}'>")
            best, worst = top_slots(cls, regime)
            out.append("<div class='grid2'><div><h4>Best half-hours</h4>" + table(best) + "</div><div><h4>Worst half-hours</h4>" + table(worst) + "</div></div>")
            for day in DAYS:
                wins = windows(cls, regime, day)
                if day == "Saturday":
                    wins = [w for w in wins if w["start"] < "04:00"]
                out.append(f"<h4>{day}</h4><p>{narrative(inst, regime, day, wins)}</p>")
                out.append(f"<img alt='{day} profile' src='{profile_chart(cls, regime, day)}'>")
                out.append(day_table(wins))
        b = bias_rows(cls)
        out.append("<h3>Directional bias check</h3>")
        if b.empty:
            out.append("<p>No slot shows a statistically meaningful up/down bias (|t| &ge; 2.5). Trade the move, not a calendar direction.</p>")
        else:
            out.append("<p>Slots with the strongest recency-weighted directional drift (|t| &ge; 2.5). With ~500 slots tested, a handful will clear this bar by "
                       "chance, so treat these as weak tilts at best.</p>" + table(b))

    # findings
    out.append("<h2 id='findings'>Research findings: what persists?</h2>"
               "<p>Rank correlation between each slot's value in the training years and in the unseen last 12 months "
               "(1 = identical ordering, 0 = no relationship). Only persistent metrics can build a timetable.</p><div class='grid2'>")
    for inst, r in results.items():
        out.append(f"<div><h4>{inst}</h4>" + table(r["studies"]["persistence"]) + "</div>")
    out.append("</div><h3>How much should recent weeks count?</h3><p>Rolling-origin test over the last 6 quarters: weight history with a given "
               "half-life, predict the next quarter's slot displacement, measure rank correlation. Very short memories chase noise; "
               f"the chosen {meta['halfLifeWeeks']:.0f}-week half-life sits on the plateau while still favouring recent behaviour.</p><div class='grid2'>")
    for inst, r in results.items():
        out.append(f"<div><h4>{inst}</h4>" + table(r["studies"]["halflife"]) + "</div>")
    out.append("</div>")

    # validation
    out.append("<h2 id='validation'>Out-of-sample validation</h2><p>Timetable built on data up to 12 months ago, then applied unchanged to the last 12 months. "
               "If the method works, PRIME/SWING should show larger and cleaner moves than SMALL, and SMALL larger than NO TRADE.</p>")
    for inst, r in results.items():
        v = r["val"].reset_index().rename(columns={"status": "status (frozen)", "move": "move/ATR", "range": "range/ATR"})
        out.append(f"<h3>{inst}</h3>" + table(v) + f"<p class='muted'>Slot-level rank correlation (train score vs unseen move): {r['rho']:.3f}</p>")

    out.append("<h2 id='anchors'>Session clock in IST</h2>" + table(pd.DataFrame(ANCHORS, columns=["event", "US summer (IST)", "US winter (IST)"]), num_cols=[]))
    out.append("<h2 id='caveats'>Caveats</h2><ul>"
               "<li>This is a statistical map of <i>when</i> markets tend to move cleanly. It is not a signal, and not financial advice.</li>"
               "<li>Scheduled events (CPI, NFP, FOMC) inflate the averages of their slots; on those days expect whipsaw in the first 5-15 minutes.</li>"
               "<li>MetaTrader5's Python API is Windows-only. Use research/fetch_mt5.py on Windows to swap in your broker's feed (--gold-source mt5). "
               "Dukascopy spot history can be used instead once fully downloaded (--gold-source dukascopy).</li>"
               "<li>Re-run the pipeline monthly so the recency weighting keeps tracking the market.</li></ul>")
    out.append("</main></body></html>")
    return "".join(out)
