// Compiled gold filter: one market grade from the three filters that were tested against each other
// (this repo's timetable + day filter, regime-bot's quiet mode, and a live-tape choppiness read).
// Only the parts that improved results in every test group were kept; see research/compiled_filter/.
//
//   NO TRADE  gold shut, inside a US news window, day filter says NO TRADE,
//             or neither of: 17:00–22:30 IST / 15m choppiness under 55
//   B         one of the two holds          → half size, best setups only, 1:2
//   A         both hold                     → full size
//   A+        both hold, choppiness under 50 → full size
//   Target    1:3 in a normal market, 1:2 when quiet mode is on

import { marketOpen, type Bar, type FilterVerdict } from "./day-filter";
import { buildBlocks, type LiveEvent } from "./news-feed";

export type Grade = "A+" | "A" | "B" | "NO TRADE";

export const EVENING = { from: 17 * 60, to: 22 * 60 + 30 } as const; // IST minutes
export const CHOP_A = 55;
export const CHOP_APLUS = 50;
export const QUIET_BELOW = 0.8;
export const QUIET_EXIT = 0.9;
export const DAY_FILTER_STOP = 8; // the day filter was tested with the $8 (0.19%) stop

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Minutes since IST midnight. */
export function istMinutes(ms: number): number {
  return Math.floor(((ms + 330 * MIN) % (1440 * MIN)) / MIN);
}

// ------------------------------------------------------------------ choppiness

/** 15m Choppiness Index (14) on in-session candles, from 15m bars that have closed by `now`.
 *  100 = pure chop, low = trending. Built from 5m candles: high = max, low = min, close = last. */
export function chop15(
  bars5m: readonly Bar[],
  now: number,
  length = 14,
): number | null {
  const buckets: { t: number; h: number; l: number; c: number }[] = [];
  for (const [t, , h, l, c] of bars5m) {
    if (!marketOpen(t)) continue;
    const k = Math.floor(t / (15 * MIN)) * 15 * MIN;
    if (k + 15 * MIN > now) break; // still forming
    const last = buckets[buckets.length - 1];
    if (last && last.t === k) {
      last.h = Math.max(last.h, h);
      last.l = Math.min(last.l, l);
      last.c = c;
    } else buckets.push({ t: k, h, l, c });
  }
  if (buckets.length < length + 1) return null;
  const win = buckets.slice(-length);
  const prevClose = buckets[buckets.length - length - 1]!.c;
  let sumTr = 0;
  let hi = -Infinity;
  let lo = Infinity;
  win.forEach((b, i) => {
    const pc = i === 0 ? prevClose : win[i - 1]!.c;
    sumTr += Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    hi = Math.max(hi, b.h);
    lo = Math.min(lo, b.l);
  });
  if (hi <= lo) return null;
  return (100 * Math.log10(sumTr / (hi - lo))) / Math.log10(length);
}

// ------------------------------------------------------------------ quiet mode (regime-bot)

const nyFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});
function nyParts(ms: number) {
  const parts = nyFmt.formatToParts(new Date(ms));
  const p = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((x) => x.type === type)?.value ?? "";
  return {
    date: `${p("year")}-${p("month")}-${p("day")}`,
    hour: Number(p("hour")),
  };
}
/** Trade date of a candle: from 18:00 New York it belongs to the next day's session. */
function sessionDate(ms: number): string {
  return nyParts(ms + 6 * HOUR).date;
}

export type Quiet = {
  quiet: boolean | null;
  ratio: number | null;
  avg2: number | null;
  normal: number | null;
  sessions: number;
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** regime-bot quiet mode: average range of the last 2 complete sessions / median of the last 60.
 *  On below 0.80, off again at 0.90. The mode decided after a session closes applies to the next one. */
export function quietMode(bars1h: readonly Bar[], now: number): Quiet {
  const sessions = new Map<
    string,
    { h: number; l: number; n: number; lastHourNy: number }
  >();
  for (const [t, , h, l] of bars1h) {
    if (t + HOUR > now || !marketOpen(t)) continue;
    const d = sessionDate(t);
    const s = sessions.get(d);
    const hourNy = nyParts(t).hour;
    if (s) {
      s.h = Math.max(s.h, h);
      s.l = Math.min(s.l, l);
      s.n += 1;
      s.lastHourNy = hourNy;
    } else sessions.set(d, { h, l, n: 1, lastHourNy: hourNy });
  }
  const current = sessionDate(now);
  const ranges = [...sessions.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    // complete sessions only (the 16:00 New York candle is the last one), and no holiday stubs
    .filter(([d, s]) => (d < current || s.lastHourNy === 16) && s.n >= 10)
    .map(([, s]) => s.h - s.l);
  let mode: boolean | null = null;
  let ratio: number | null = null;
  let avg2: number | null = null;
  let normal: number | null = null;
  for (let i = 59; i < ranges.length; i++) {
    avg2 = (ranges[i]! + ranges[i - 1]!) / 2;
    normal = median(ranges.slice(i - 59, i + 1));
    ratio = avg2 / normal;
    mode = ratio < QUIET_BELOW || (mode === true && ratio < QUIET_EXIT);
  }
  return { quiet: mode, ratio, avg2, normal, sessions: ranges.length };
}

// ------------------------------------------------------------------ news

export type NewsHit = { name: string; until: number } | null;

/** Inside this repo's measured stand-aside window for gold, or the wider gate used in the test:
 *  tier 1 two hours before to 90 min after (FOMC 4 hours after), tier 2 30 min before to 45 after. */
export function newsHit(events: readonly LiveEvent[], now: number): NewsHit {
  const hits: { name: string; until: number }[] = [];
  for (const b of buildBlocks(events, "GOLD"))
    if (now >= b.from && now < b.to)
      hits.push({ name: b.names.join(", "), until: b.to });
  for (const e of events) {
    if (e.tier > 2) continue;
    const before = e.tier === 1 ? 120 : 30;
    const after = e.tier === 1 ? (e.kind === "FOMC" ? 240 : 90) : 45;
    if (now >= e.time - before * MIN && now < e.time + after * MIN)
      hits.push({ name: e.name, until: e.time + after * MIN });
  }
  if (!hits.length) return null;
  return hits.reduce((a, b) => (b.until > a.until ? b : a));
}

// ------------------------------------------------------------------ grade

export type GradeRead = {
  grade: Grade;
  size: number;
  target: number | null;
  reason: string;
  inWindow: boolean;
  calm: boolean;
};

export function gradeOf(x: {
  now: number;
  chop: number | null;
  news: NewsHit;
  dayFilter: FilterVerdict | null;
  quiet: boolean | null;
}): GradeRead {
  const m = istMinutes(x.now);
  const inWindow = m >= EVENING.from && m < EVENING.to;
  const calm = x.chop !== null && x.chop < CHOP_A;
  const no = (reason: string): GradeRead => ({
    grade: "NO TRADE",
    size: 0,
    target: null,
    reason,
    inWindow,
    calm,
  });
  if (!marketOpen(x.now)) return no("Gold is shut.");
  if (x.news) return no(`${x.news.name}: inside the news window.`);
  if (x.dayFilter === "NO TRADE")
    return no("Day filter: too little movement forecast for an $8 stop.");
  if (inWindow && calm) {
    const target = x.quiet ? 2 : 3;
    return {
      grade: x.chop! < CHOP_APLUS ? "A+" : "A",
      size: 1,
      target,
      reason: `Inside 17:00–22:30 IST and the 15m chart is ${x.chop! < CHOP_APLUS ? "clean" : "calm"}.${x.quiet ? " Quiet market: take 1:2." : ""}`,
      inWindow,
      calm,
    };
  }
  if (inWindow || calm)
    return {
      grade: "B",
      size: 0.5,
      target: 2,
      reason: inWindow
        ? "Inside the evening window, but the 15m chart is choppy."
        : "Calm 15m chart, but outside 17:00–22:30 IST.",
      inWindow,
      calm,
    };
  return no("Outside 17:00–22:30 IST and the 15m chart is choppy.");
}

// ------------------------------------------------------------------ evidence (research/compiled_filter)

/** Mean result per trade by grade. Trader's trades in $ (net after fees), mechanical trades in R at 1:2. */
export const EVIDENCE = {
  groups: [
    {
      id: "early",
      label: "Own trades to 20 Sep",
      unit: "$",
      n: 113,
      cells: {
        "A+": [1.4, 25],
        A: [4.9, 6],
        B: [4.3, 51],
        "NO TRADE": [-23.7, 31],
      },
    },
    {
      id: "late",
      label: "Own trades from 21 Sep",
      unit: "$",
      n: 238,
      cells: {
        "A+": [24.6, 47],
        A: [3.9, 30],
        B: [-4.5, 101],
        "NO TRADE": [-23.5, 60],
      },
    },
    {
      id: "train",
      label: "Mechanical, Dec–Jun",
      unit: "R",
      n: 3019,
      cells: {
        "A+": [-0.13, 377],
        A: [-0.18, 172],
        B: [-0.22, 1580],
        "NO TRADE": [-0.24, 890],
      },
    },
    {
      id: "test",
      label: "Mechanical, Jul–Oct",
      unit: "R",
      n: 1754,
      cells: {
        "A+": [-0.04, 247],
        A: [-0.2, 107],
        B: [-0.22, 831],
        "NO TRADE": [-0.2, 569],
      },
    },
  ],
  diff: { early: [25.8, 1.9, 52.1], late: [40.0, 22.8, 56.7] },
  totals: {
    aPlusA: 1336,
    noTrade: -2144,
    noTradeN: 91,
    noTradeWin: 21,
    all: -1041,
  },
  rr: [
    {
      grade: "A / A+ · normal",
      bracket: "$8–10 stop · 1:3",
      own: "+0.65R (1:2 +0.38R)",
      mech: "≈0R, best at 1:3–1:4",
    },
    {
      grade: "A / A+ · quiet",
      bracket: "$6–8 stop · 1:1.5–1:2",
      own: "+0.37 to +0.42R",
      mech: "best at 1:1–1:1.5",
    },
    {
      grade: "B",
      bracket: "1:2 · half size",
      own: "−0.1 to +0.1R",
      mech: "−0.2R",
    },
    {
      grade: "NO TRADE",
      bracket: "none works",
      own: "−0.4 to −0.8R",
      mech: "−0.3R",
    },
  ],
} as const;
