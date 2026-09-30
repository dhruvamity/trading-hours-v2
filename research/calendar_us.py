"""US macro event calendar, Jun 2023 -> Dec 2026, in UTC.

Dates come from the official release archives / schedules (fetched 2026-09-30):
  CPI, Employment Situation (NFP), PPI ....... bls.gov/bls/news-release/*.htm + bls.gov/schedule/2026
  Personal Income & Outlays (Core PCE), GDP .. bea.gov/news/archive + bea.gov/news/schedule/full
  FOMC decisions ............................. federalreserve.gov/monetarypolicy/fomccalendars.htm
  Retail sales ............................... census.gov/retail/release_schedule.html (2025-11 on)
  NVIDIA earnings ............................ alphaquery.com/stock/NVDA/earnings-history
Rule-based: ISM Manufacturing (1st business day, 10:00 ET), ISM Services (3rd business day),
weekly jobless claims (Thursday 08:30 ET, Wednesday in holiday weeks), month/quarter end.

Update the lists when new schedules are published (BLS/BEA publish the next year each autumn).
"""
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import pandas as pd

ET = ZoneInfo("America/New_York")
LONDON = ZoneInfo("Europe/London")


def _d(s: str) -> list[date]:
    return [date.fromisoformat(x) for x in s.split()]


CPI = _d("""2023-06-13 2023-07-12 2023-08-10 2023-09-13 2023-10-12 2023-11-14 2023-12-12
2024-01-11 2024-02-13 2024-03-12 2024-04-10 2024-05-15 2024-06-12 2024-07-11 2024-08-14 2024-09-11 2024-10-10 2024-11-13 2024-12-11
2025-01-15 2025-02-12 2025-03-12 2025-04-10 2025-05-13 2025-06-11 2025-07-15 2025-08-12 2025-09-11 2025-10-24 2025-12-18
2026-01-13 2026-02-13 2026-03-11 2026-04-10 2026-05-12 2026-06-10 2026-07-14 2026-08-12 2026-09-11 2026-10-14 2026-11-10 2026-12-10""")

NFP = _d("""2023-06-02 2023-07-07 2023-08-04 2023-09-01 2023-10-06 2023-11-03 2023-12-08
2024-01-05 2024-02-02 2024-03-08 2024-04-05 2024-05-03 2024-06-07 2024-07-05 2024-08-02 2024-09-06 2024-10-04 2024-11-01 2024-12-06
2025-01-10 2025-02-07 2025-03-07 2025-04-04 2025-05-02 2025-06-06 2025-07-03 2025-08-01 2025-09-05 2025-11-20 2025-12-16
2026-01-09 2026-02-11 2026-03-06 2026-04-03 2026-05-08 2026-06-05 2026-07-02 2026-08-07 2026-09-04 2026-10-02 2026-11-06 2026-12-04""")

PPI = _d("""2023-06-14 2023-07-13 2023-08-11 2023-09-14 2023-10-11 2023-11-15 2023-12-13
2024-01-12 2024-02-16 2024-03-14 2024-04-11 2024-05-14 2024-06-13 2024-07-12 2024-08-13 2024-09-12 2024-10-11 2024-11-14 2024-12-12
2025-01-14 2025-02-13 2025-03-13 2025-04-11 2025-05-15 2025-06-12 2025-07-16 2025-08-14 2025-09-10 2025-11-25
2026-01-14 2026-01-30 2026-02-27 2026-03-18 2026-04-14 2026-05-13 2026-06-11 2026-07-15 2026-08-13 2026-09-10 2026-10-15 2026-11-13 2026-12-15""")

PCE = _d("""2023-06-30 2023-07-28 2023-08-31 2023-09-29 2023-10-27 2023-11-30 2023-12-22
2024-01-26 2024-02-29 2024-03-29 2024-04-26 2024-05-31 2024-06-28 2024-07-26 2024-08-30 2024-09-27 2024-10-31 2024-11-27 2024-12-20
2025-01-31 2025-02-28 2025-03-28 2025-04-30 2025-05-30 2025-06-27 2025-07-31 2025-08-29 2025-09-26 2025-12-05 2025-12-23
2026-01-22 2026-02-20 2026-03-13 2026-04-09 2026-04-30 2026-05-28 2026-06-25 2026-07-30 2026-08-26 2026-09-30 2026-10-29 2026-11-25 2026-12-23""")

GDP_ADVANCE = _d("""2023-07-27 2023-10-26 2024-01-25 2024-04-25 2024-07-25 2024-10-30 2025-01-30 2025-04-30 2025-07-30
2025-12-23 2026-02-20 2026-04-30 2026-07-30 2026-10-29""")

RETAIL = _d("""2023-06-15 2023-07-18 2023-08-15 2023-09-14 2023-10-17 2023-11-15 2023-12-14
2024-01-17 2024-02-15 2024-03-14 2024-04-15 2024-05-15 2024-06-18 2024-07-16 2024-08-15 2024-09-17 2024-10-17 2024-11-15 2024-12-17
2025-01-16 2025-02-14 2025-03-17 2025-04-16 2025-05-15 2025-06-17 2025-07-17 2025-08-15 2025-09-16 2025-11-25 2025-12-16
2026-01-14 2026-02-10 2026-03-06 2026-04-01 2026-04-21 2026-05-14 2026-06-17 2026-07-16 2026-08-14 2026-09-16 2026-10-15 2026-11-17 2026-12-16""")

FOMC = _d("""2023-06-14 2023-07-26 2023-09-20 2023-11-01 2023-12-13
2024-01-31 2024-03-20 2024-05-01 2024-06-12 2024-07-31 2024-09-18 2024-11-07 2024-12-18
2025-01-29 2025-03-19 2025-05-07 2025-06-18 2025-07-30 2025-09-17 2025-10-29 2025-12-10
2026-01-28 2026-03-18 2026-04-29 2026-06-17 2026-07-29 2026-09-16 2026-10-28 2026-12-09""")

NVDA = _d("""2023-08-23 2023-11-21 2024-02-21 2024-05-22 2024-08-28 2024-11-20 2025-02-26 2025-05-28 2025-08-27
2025-11-19 2026-02-25 2026-05-20 2026-08-26 2026-11-18""")

JACKSON_HOLE = _d("2023-08-25 2024-08-23 2025-08-22")

# Official schedules for Oct-Dec 2026 not covered by the lists above (JOLTS is only known forward)
JOLTS_FORWARD = _d("2026-11-03")


def us_holidays(year: int) -> set[date]:
    """Market holidays that shift ISM / claims release days."""
    def nth_weekday(month, weekday, n):
        d = date(year, month, 1)
        d += timedelta(days=(weekday - d.weekday()) % 7)
        return d + timedelta(weeks=n - 1)

    def observed(d):
        return d - timedelta(days=1) if d.weekday() == 5 else d + timedelta(days=1) if d.weekday() == 6 else d

    return {observed(date(year, 1, 1)), observed(date(year, 7, 4)), observed(date(year, 12, 25)),
            nth_weekday(9, 0, 1), nth_weekday(11, 3, 4), nth_weekday(1, 0, 3), nth_weekday(2, 0, 3),
            nth_weekday(5, 0, 5) if nth_weekday(5, 0, 5).month == 5 else nth_weekday(5, 0, 4),
            observed(date(year, 6, 19))}


def business_days(start: date, end: date):
    hol = set().union(*(us_holidays(y) for y in range(start.year, end.year + 1)))
    d = start
    while d <= end:
        if d.weekday() < 5 and d not in hol:
            yield d
        d += timedelta(days=1)


def at(d: date, hh: int, mm: int, tz=ET) -> pd.Timestamp:
    return pd.Timestamp(datetime.combine(d, time(hh, mm), tzinfo=tz)).tz_convert("UTC")


# tier: 1 = market-moving everywhere, 2 = moves gold/BTC often, 3 = background
EVENT_TYPES = {
    "FOMC": ("FOMC rate decision + press conference", 1),
    "CPI": ("CPI inflation", 1),
    "NFP": ("Non-farm payrolls (jobs report)", 1),
    "PCE": ("Core PCE + personal income/spending", 2),
    "PPI": ("PPI producer inflation", 2),
    "RETAIL": ("Retail sales", 2),
    "GDP": ("GDP advance estimate", 2),
    "ISM_MFG": ("ISM manufacturing PMI", 2),
    "ISM_SERV": ("ISM services PMI", 2),
    "JACKSON": ("Fed chair Jackson Hole speech", 1),
    "JOLTS": ("JOLTS job openings", 3),
    "CLAIMS": ("Weekly jobless claims", 3),
    "NVDA": ("NVIDIA earnings (after US close)", 3),
    "MONTH_END": ("Month-end London 4pm fix / rebalancing", 3),
    "QUARTER_END": ("Quarter-end London 4pm fix / rebalancing", 3),
}


def build(start: str = "2023-06-01", end: str = "2026-12-31") -> pd.DataFrame:
    s, e = date.fromisoformat(start), date.fromisoformat(end)
    rows = []

    def add(kind, ts):
        if s <= ts.tz_convert(ET).date() <= e:
            rows.append((ts, kind))

    for d in CPI: add("CPI", at(d, 8, 30))
    for d in NFP: add("NFP", at(d, 8, 30))
    for d in PPI: add("PPI", at(d, 8, 30))
    for d in PCE: add("PCE", at(d, 8, 30))
    for d in GDP_ADVANCE: add("GDP", at(d, 8, 30))
    for d in RETAIL: add("RETAIL", at(d, 8, 30))
    for d in FOMC: add("FOMC", at(d, 14, 0))
    for d in NVDA: add("NVDA", at(d, 16, 20))
    for d in JACKSON_HOLE: add("JACKSON", at(d, 10, 0))
    for d in JOLTS_FORWARD: add("JOLTS", at(d, 10, 0))

    bdays = list(business_days(s - timedelta(days=5), e))
    by_month: dict[tuple, list[date]] = {}
    for d in bdays:
        by_month.setdefault((d.year, d.month), []).append(d)
    for (y, m), ds in by_month.items():
        if ds[0].day <= 5:  # month fully covered
            add("ISM_MFG", at(ds[0], 10, 0))
            add("ISM_SERV", at(ds[2], 10, 0))
        last = ds[-1]
        add("QUARTER_END" if m in (3, 6, 9, 12) else "MONTH_END", at(last, 16, 0, LONDON))
    bset = set(bdays)
    d = s
    while d <= e:
        if d.weekday() == 3:
            add("CLAIMS", at(d if d in bset else d - timedelta(days=1), 8, 30))
        d += timedelta(days=1)

    df = pd.DataFrame(rows, columns=["time", "kind"]).drop_duplicates().sort_values("time").reset_index(drop=True)
    df["name"] = df["kind"].map(lambda k: EVENT_TYPES[k][0])
    df["tier"] = df["kind"].map(lambda k: EVENT_TYPES[k][1])
    df["ist"] = df["time"].dt.tz_convert("Asia/Kolkata")
    return df


if __name__ == "__main__":
    ev = build()
    print(ev.groupby("kind").size())
    print(ev[(ev.time >= "2026-09-28") & (ev.time < "2026-10-10")].to_string())
