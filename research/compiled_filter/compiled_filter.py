"""Compiled gold filter (iteration 8 of gold_filter_lab). Every rule below survived the robustness screen:
it improved results on the trader's own gold trades (before and after 21 Sep 2026) AND on 4,773 mechanical
sweep-reversal trades (Dec-Jun train, Jul-Oct test) - see gold_filter_lab/REPORT.md.

grade(context) -> dict(grade, size, target_rr, reasons)

  NO TRADE  market shut, or inside a US news window, or trading-hours-v2 day filter says NO TRADE,
            or neither of: (17:00-22:30 IST) / (15m choppiness < 55)
  B         exactly one of the two holds            -> half size, only your A+ setups, 1:2
  A         both hold                               -> full size
  A+        both hold and choppiness < 50           -> full size
  Target    1:3 in a normal market, 1:2 when regime-bot's quiet mode is ON (2-session range < 80% of normal).
"""
from __future__ import annotations

EVENING = (17 * 60, 22 * 60 + 30)       # IST minutes
CHOP_A, CHOP_APLUS = 55.0, 50.0


def grade(ist_min: int, chop15: float | None, news: bool, closed: bool, dayfilter_verdict: str | None,
          quiet: bool | None) -> dict:
    reasons = []
    if closed:
        return dict(grade="NO TRADE", size=0.0, target_rr=None, reasons=["gold is shut"])
    if news:
        return dict(grade="NO TRADE", size=0.0, target_rr=None, reasons=["inside a US news window"])
    if dayfilter_verdict == "NO TRADE":
        return dict(grade="NO TRADE", size=0.0, target_rr=None, reasons=["day filter: not enough movement forecast"])
    in_window = EVENING[0] <= ist_min < EVENING[1]
    calm = chop15 is not None and chop15 < CHOP_A
    reasons.append("17:00-22:30 IST" if in_window else "outside 17:00-22:30 IST")
    reasons.append(f"15m choppiness {chop15:.0f}" if chop15 is not None else "choppiness unknown")
    tgt = 2.0 if quiet else 3.0
    if in_window and calm:
        g = "A+" if chop15 < CHOP_APLUS else "A"
        return dict(grade=g, size=1.0, target_rr=tgt, reasons=reasons + (["quiet market: target 1:2"] if quiet else []))
    if in_window or calm:
        return dict(grade="B", size=0.5, target_rr=2.0, reasons=reasons + ["half size, A+ setups only"])
    return dict(grade="NO TRADE", size=0.0, target_rr=None, reasons=reasons)
