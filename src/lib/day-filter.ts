// Day filter: how far gold is likely to travel in the next 3 hours, in units of the stop.
// The forecast is movement only. Chop is reported as context: the research found it does not
// carry over from one stretch of the day to the next (see research/day_filter.py).
//
// readFilter() is a port of live() in research/day_filter.py. research/parity_day_filter.ts
// checks the two give the same numbers. Pure functions, no browser APIs.

import { DAY_FILTER } from "./day-filter.generated";

export type FilterVerdict = "NO TRADE" | "1:1 ONLY" | "TRADE" | "TRADE (fast)";

export type VerdictRow = {
  verdict: FilterVerdict;
  /** decision points (or days) behind the row */
  n: number;
  share: number;
  /** median 3-hour range that followed, in R */
  range: number;
  /** share of entry minutes from which price moved 1R one way within the hour */
  reach1: number;
  /** …moved 2R one way within 3 hours */
  reach2: number;
  /** …traded both 1R above and 1R below within the hour */
  whip: number;
  /** coin-flip entry, stop 1R: share that hit a 1R / 2R target first */
  win11: number;
  win12: number;
  /** share of 2R trades still open after 3 hours */
  open12: number;
  /** average minutes in the trade */
  min11: number;
  min12: number;
  /** average result in R after fees */
  r11: number;
  r12: number;
};

export type Skill = {
  points: number;
  sessions: number;
  /** rank correlation of forecast and outcome, walk-forward */
  rank: number;
  /** the same using only the 20-session norm for the clock time */
  rankNormOnly: number;
  r2: number;
  r2LastThird: number;
  calibSlope: number;
};

export type Evidence = {
  points: number;
  sessions: number;
  /** rank correlations, time of day removed: last 4 hours -> next 3 hours */
  chopToChop: number;
  contToCont: number;
  moveToMove: number;
  /** whole sessions, today vs yesterday */
  dayErLag1: number;
  dayRangeLag1: number;
  /** share of sessions that closed 60%+ of their range away from the open */
  trendDayBase: number;
  trendAfterTrend: number;
  trendAfterOther: number;
};

export type DayFilterResearch = {
  generated: string;
  dataFrom: string;
  dataThrough: string;
  sessions: number;
  stopPct: number;
  feePct: number;
  params: {
    slots: number;
    horizon: number;
    minHorizon: number;
    window2h: number;
    smooth: number;
    baseDays: number;
    minBase: number;
    qClip: number;
    step: number;
    eveStartIst: number;
    evePoints: number;
  };
  rules: { dead: number; full: number; fast: number };
  /** ln(range / norm) = c + a*q + b*q|q| */
  now: number[];
  tonight: number[];
  /** forecast (% of price) -> median outcome at that forecast level */
  calib: { raw: number[]; actual: number[] };
  /** forecast 3-hour range in R -> what price offered, walk-forward */
  offer: { f: number[]; reach1: number[]; reach2: number[]; whip: number[] };
  skill: Skill;
  tables: Record<
    string,
    {
      stopPct: number;
      all: VerdictRow[];
      evening: VerdictRow[];
      lastThird: VerdictRow[];
      tonight: { ist: string; days: number; rank: number; r2: number; table: VerdictRow[] }[];
    }
  >;
  evidence: Evidence;
  proxy: { label: string; from: string; to: string; skill: Skill; evidence: Evidence };
  sixMonths: {
    from: string;
    to: string;
    sessions: number;
    quantiles: number[];
    slots: number[];
    rangePct: number[][];
    netPct: number[][];
    er: number[][];
  };
};

/** One 5-minute candle: open time (epoch ms), open, high, low, close. */
export type Bar = readonly [number, number, number, number, number];

/** Stop sizes offered on the page, in dollars (playbook: $6 to $10). */
export const STOPS = [6, 8, 10] as const;
export const DEFAULT_STOP = 8;

const P = DAY_FILTER.params;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const BAR = 5 * MIN;
const IST_OFFSET = 330 * MIN;

// ---------------------------------------------------------------------------------------------
// session clock: a gold session runs 18:00 -> 17:00 New York and is named after the day it ends
// ---------------------------------------------------------------------------------------------

const nyFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const offsetByHour = new Map<number, number>();

/** New York wall-clock time as a UTC-style timestamp: read it with getUTC*(). */
function nyWall(ms: number): number {
  const hour = Math.floor(ms / HOUR);
  let offset = offsetByHour.get(hour);
  if (offset === undefined) {
    const p: Record<string, number> = {};
    for (const part of nyFormat.formatToParts(new Date(hour * HOUR)))
      if (part.type !== "literal") p[part.type] = Number(part.value);
    offset =
      Date.UTC(p["year"]!, p["month"]! - 1, p["day"]!, p["hour"]!, p["minute"]!) - hour * HOUR;
    offsetByHour.set(hour, offset);
  }
  return ms + offset;
}

/** Sun 18:00 -> Fri 17:00 New York, minus the daily 17:00-18:00 break. */
export function marketOpen(ms: number): boolean {
  const wall = new Date(nyWall(ms));
  const dow = wall.getUTCDay();
  const hr = wall.getUTCHours();
  return !(hr === 17 || dow === 6 || (dow === 5 && hr >= 17) || (dow === 0 && hr < 18));
}

/** Session day number of the session `ms` belongs to, or of the next one if the market is shut. */
function sessionDay(ms: number): number {
  const day = Math.floor((nyWall(ms) + 7 * HOUR) / DAY);
  const dow = new Date(day * DAY).getUTCDay();
  return day + (dow === 6 ? 2 : dow === 0 ? 1 : 0);
}

/** Epoch ms of the session's first minute (18:00 New York on the evening before its label day). */
function sessionOpen(day: number): number {
  const wall = day * DAY - 6 * HOUR;
  const guess = wall + 5 * HOUR;
  return wall - (nyWall(guess) - guess);
}

const dayKey = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------
// sessions of 5-minute bars
// ---------------------------------------------------------------------------------------------

type Row = { day: number; o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array };

const blankRow = (day: number): Row => ({
  day,
  o: new Float64Array(P.slots).fill(NaN),
  h: new Float64Array(P.slots).fill(NaN),
  l: new Float64Array(P.slots).fill(NaN),
  c: new Float64Array(P.slots).fill(NaN),
});

/** Running sum of squared 5m log returns since the session open, slots 0..P.slots. */
function cumSq(r: Row): Float64Array {
  const out = new Float64Array(P.slots + 1);
  let prev = r.o[0]!;
  for (let j = 0; j < P.slots; j += 1) {
    const ret = Math.log(r.c[j]! / prev);
    out[j + 1] = out[j]! + ret * ret;
    prev = r.c[j]!;
  }
  return out;
}

const rv2h = (cs: Float64Array, k: number) =>
  Math.sqrt(cs[k]! - (k >= P.window2h ? cs[k - P.window2h]! : 0));

/** High-low range of the next 3 hours from each slot, as a fraction of price (cut at the close). */
function fwdRange(r: Row): Float64Array {
  const out = new Float64Array(P.slots).fill(NaN);
  for (let k = 0; k <= P.slots - P.minHorizon; k += 1) {
    const end = Math.min(k + P.horizon, P.slots);
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = k; j < end; j += 1) {
      const h = r.h[j]!;
      const l = r.l[j]!;
      if (Number.isNaN(h) || Number.isNaN(l)) {
        hi = NaN;
        break;
      }
      if (h > hi) hi = h;
      if (l < lo) lo = l;
    }
    out[k] = (hi - lo) / (k ? r.c[k - 1]! : r.o[0]!);
  }
  return out;
}

/** Median of the usable values; NaN unless at least `need` of them exist. */
function median(values: number[], need = P.minBase): number {
  const v = values.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  if (v.length < need || v.length === 0) return NaN;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}
const mean = (values: number[]) => values.reduce((s, x) => s + x, 0) / values.length;

const clipLog = (ratio: number) => Math.min(P.qClip, Math.max(-P.qClip, Math.log(ratio)));

/** Piecewise-linear lookup, flat beyond the ends. */
function interp(x: number, xs: readonly number[], ys: readonly number[]): number {
  if (x <= xs[0]!) return ys[0]!;
  for (let i = 1; i < xs.length; i += 1)
    if (x <= xs[i]!)
      return ys[i - 1]! + ((ys[i]! - ys[i - 1]!) * (x - xs[i - 1]!)) / (xs[i]! - xs[i - 1]!);
  return ys[ys.length - 1]!;
}

/** Forecast -> the median outcome seen at that forecast level; proportional beyond the studied range. */
export function calibrate(rawPct: number): number {
  const { raw, actual } = DAY_FILTER.calib;
  const last = raw.length - 1;
  if (rawPct < raw[0]!) return (rawPct * actual[0]!) / raw[0]!;
  if (rawPct > raw[last]!) return (rawPct * actual[last]!) / raw[last]!;
  return interp(rawPct, raw, actual);
}

/** What price offered at a forecast range (R); below the studied range it falls towards zero. */
function offerAt(fR: number, table: readonly number[]): number {
  const f = DAY_FILTER.offer.f;
  return fR < f[0]! ? (table[0]! * fR) / f[0]! : interp(fR, f, table);
}

export function verdictOf(reach1: number, reach2: number, whip: number): FilterVerdict {
  const { dead, full, fast } = DAY_FILTER.rules;
  if (reach1 < dead) return "NO TRADE";
  if (reach2 < full) return "1:1 ONLY";
  return whip >= fast ? "TRADE (fast)" : "TRADE";
}

/** Signed leg lengths (fraction of price) of a zigzag that turns after a reversal of `theta`. */
export function zigzag(p: readonly number[], theta: number): number[] {
  const legs: number[] = [];
  let direction = 0;
  let start = 0;
  let ext = 0;
  let hi = 0;
  let lo = 0;
  for (let i = 1; i < p.length; i += 1) {
    const x = p[i]!;
    if (direction === 0) {
      if (x > p[hi]!) hi = i;
      if (x < p[lo]!) lo = i;
      if (x >= p[lo]! * (1 + theta)) [direction, start, ext] = [1, lo, i];
      else if (x <= p[hi]! * (1 - theta)) [direction, start, ext] = [-1, hi, i];
    } else if (direction === 1) {
      if (x > p[ext]!) ext = i;
      else if (x <= p[ext]! * (1 - theta)) {
        legs.push(p[ext]! / p[start]! - 1);
        [direction, start, ext] = [-1, ext, i];
      }
    } else if (x < p[ext]!) ext = i;
    else if (x >= p[ext]! * (1 + theta)) {
      legs.push(p[ext]! / p[start]! - 1);
      [direction, start, ext] = [1, ext, i];
    }
  }
  if (direction !== 0) legs.push(p[ext]! / p[start]! - 1);
  return legs;
}

// ---------------------------------------------------------------------------------------------
// the read
// ---------------------------------------------------------------------------------------------

export type Read = {
  /** forecast before calibration, % of price */
  rawPct: number;
  /** expected 3-hour high-low range: % of price, dollars, and stop-widths */
  pct: number;
  usd: number;
  r: number;
  reach1: number;
  reach2: number;
  whip: number;
  verdict: FilterVerdict;
  /** what the same clock time did over the last 20 sessions, % of price */
  normPct: number;
  /** activity vs that norm, in logs (0 = normal, 0.69 = double) */
  q: number;
};

/** One session from its open to "now": the trader's picture of the day so far. */
export type Slice = {
  range: number;
  net: number;
  open: number;
  /** |net move| / distance travelled on 5m closes (1 = straight line, 0 = went nowhere) */
  er: number;
  rv: number;
  /** swings that reversed by one stop */
  legs: number;
  /** longest swing, in stop-widths */
  longest: number;
  /** swings of 3 stop-widths or more */
  runners: number;
};
export type SliceSummary = Omit<Slice, "net" | "open"> & { absNet: number };
type Nullable<T> = { [K in keyof T]: T[K] | null };

export type FilterRead = {
  /** session label, YYYY-MM-DD */
  session: string;
  /** 5-minute bars closed so far in this session */
  slot: number;
  /** slot at which the evening window (17:00 IST) starts */
  eveSlot: number;
  price: number;
  q2: number | null;
  qd: number | null;
  qy: number | null;
  /** next 3 hours; null outside the session, in its last 2 hours, or without enough history */
  now: Read | null;
  /** the evening window, while it has not started */
  tonight: Read | null;
  soFar: {
    today: Slice | null;
    yesterday: Slice | null;
    lastWeek: Nullable<SliceSummary>;
    norm: Nullable<SliceSummary>;
  };
};

/** Extras the page draws that the research fixture does not check. */
export type FilterView = FilterRead & {
  /** epoch ms of the session open, and whether the market is trading right now */
  openAt: number;
  marketOpen: boolean;
  /** an ordinary day, every half hour: the norm for that clock time and the verdict it would give */
  typical: { slot: number; at: number; r: number; verdict: FilterVerdict }[];
  /** today's range / net move / efficiency so far against the last six months (0-100), null if unknown */
  sixMonth: { range: number | null; net: number | null; er: number | null };
};

const finite = (v: number): number | null => (Number.isFinite(v) ? v : null);

function sliceStats(r: Row, cs: Float64Array, k: number, theta: number): Slice | null {
  if (k < 1) return null;
  const open = r.o[0]!;
  const prices = [open];
  let hi = -Infinity;
  let lo = Infinity;
  let path = 0;
  for (let j = 0; j < k; j += 1) {
    const c = r.c[j]!;
    if (Number.isNaN(c)) return null;
    path += Math.abs(c - prices[j]!);
    prices.push(c);
    hi = Math.max(hi, r.h[j]!);
    lo = Math.min(lo, r.l[j]!);
  }
  const net = prices[k]! - open;
  const legs = zigzag(prices, theta).map((x) => Math.abs(x) / theta);
  return {
    range: hi - lo,
    net,
    open,
    er: path > 0 ? Math.abs(net) / path : 0,
    rv: Math.sqrt(cs[k]!),
    legs: legs.length,
    longest: legs.length ? Math.max(...legs) : 0,
    runners: legs.filter((x) => x >= 3).length,
  };
}

const SUMMARY_KEYS = ["range", "er", "rv", "legs", "longest", "runners"] as const;

function summarise(slices: (Slice | null)[], agg: (v: number[]) => number): Nullable<SliceSummary> {
  const have = slices.filter((s): s is Slice => s !== null);
  const pick = (f: (s: Slice) => number) => (have.length ? finite(agg(have.map(f))) : null);
  const out = { absNet: pick((s) => Math.abs(s.net)) } as Nullable<SliceSummary>;
  for (const key of SUMMARY_KEYS) out[key] = pick((s) => s[key]);
  return out;
}

/** Where `value` sits in the six-month distribution for this point of the session (0-100). */
function percentile(table: number[][], slot: number, value: number): number | null {
  const { slots, quantiles } = DAY_FILTER.sixMonths;
  if (slot < slots[0]!) return null;
  const at = Math.min(slots.length - 1, Math.round(slot / P.step) - 1);
  const row = table[at]!;
  if (value <= row[0]!) return (quantiles[0]! * value) / (row[0]! || 1);
  const last = row.length - 1;
  if (value >= row[last]!) return Math.min(99, quantiles[last]! + (100 - quantiles[last]!) / 2);
  return interp(value, row, quantiles);
}

/**
 * The page's numbers at `now` from raw 24/7 five-minute candles (about 31 days of them).
 * Bars still forming at `now` are ignored.
 */
export function readFilter(bars: readonly Bar[], now: number, stopUsd: number): FilterView | null {
  const byDay = new Map<number, Row>();
  let lastClose = NaN;
  for (const [t, o, h, l, c] of bars) {
    if (t + BAR > now) continue;
    lastClose = c;
    if (!marketOpen(t)) continue;
    const shifted = nyWall(t) + 6 * HOUR;
    const day = Math.floor(shifted / DAY);
    let row = byDay.get(day);
    if (!row) byDay.set(day, (row = blankRow(day)));
    const slot = Math.floor((shifted - day * DAY) / BAR);
    row.o[slot] = o;
    row.h[slot] = h;
    row.l[slot] = l;
    row.c[slot] = c;
  }
  if (Number.isNaN(lastClose)) return null;

  const label = sessionDay(now);
  if (!byDay.has(label)) byDay.set(label, blankRow(label)); // market shut: the next session is still empty
  const rows = [...byDay.values()].sort((a, b) => a.day - b.day);
  const i = rows.findIndex((r) => r.day === label);
  const today = rows[i]!;
  const prior = rows.slice(Math.max(0, i - P.baseDays), i);
  const cs = new Map(rows.map((r) => [r.day, cumSq(r)]));
  const csOf = (r: Row) => cs.get(r.day)!;

  let k = today.c.findIndex((x) => Number.isNaN(x));
  if (k < 0) k = P.slots;
  const openAt = sessionOpen(label);
  const openIst = ((openAt + IST_OFFSET) % DAY) / MIN;
  const eveSlot = (P.eveStartIst - openIst) / 5;
  const price = k ? today.c[k - 1]! : lastClose;
  const theta = stopUsd / price;

  // the norm: same clock time over the previous 20 sessions, averaged over +-10 minutes
  const fwd = prior.map(fwdRange);
  const med = Array.from({ length: P.slots }, (_, s) => median(fwd.map((f) => f[s]!)));
  const base = med.map((m, s) => {
    if (Number.isNaN(m)) return NaN;
    const near = med
      .slice(Math.max(0, s - P.smooth), s + P.smooth + 1)
      .filter((x) => !Number.isNaN(x));
    return mean(near);
  });

  // activity against the norm, in logs
  const csToday = csOf(today);
  const qdAt = (s: number) =>
    s === 0
      ? 0
      : clipLog(Math.sqrt(csToday[s]!) / median(prior.map((r) => Math.sqrt(csOf(r)[s]!))));
  const q2At = (s: number) =>
    s === 0 ? 0 : clipLog(rv2h(csToday, s) / median(prior.map((r) => rv2h(csOf(r), s))));
  const whole = (r: Row) => Math.sqrt(csOf(r)[P.slots]!); // NaN unless the session is complete
  const before = rows.slice(Math.max(0, i - P.baseDays), Math.max(0, i - 1));
  const qy = i >= 1 ? clipLog(whole(rows[i - 1]!) / median(before.map(whole))) : NaN;

  const read = (rawPct: number, normPct: number, q: number): Read | null => {
    if (!Number.isFinite(rawPct)) return null;
    const pct = calibrate(rawPct);
    const r = pct / 100 / theta;
    const { reach1, reach2, whip } = DAY_FILTER.offer;
    const p = { reach1: offerAt(r, reach1), reach2: offerAt(r, reach2), whip: offerAt(r, whip) };
    const usd = (pct / 100) * price;
    return {
      rawPct,
      pct,
      usd,
      r,
      ...p,
      verdict: verdictOf(p.reach1, p.reach2, p.whip),
      normPct,
      q,
    };
  };
  const response = (c: readonly number[], q: number) =>
    Math.exp(c[0]! + c[1]! * q + c[2]! * q * Math.abs(q));

  let nowRead: Read | null = null;
  if (k >= 1 && k <= P.slots - P.minHorizon) {
    const q = (q2At(k) + qdAt(k)) / 2;
    nowRead = read(base[k]! * response(DAY_FILTER.now, q) * 100, base[k]! * 100, q);
  }

  const eveSlots = Array.from({ length: P.evePoints }, (_, j) => eveSlot + P.step * j);
  let tonight: Read | null = null;
  if (k <= eveSlot) {
    const u = k / eveSlot;
    const qd = k ? qdAt(k) : 0;
    const q = u * (Number.isFinite(qd) ? qd : 0) + (1 - u) * (Number.isFinite(qy) ? qy : 0);
    const eve = eveSlots.map((s) => base[s]!);
    const norm = eve.some((x) => Number.isNaN(x)) ? NaN : median(eve, 1);
    tonight = read(norm * response(DAY_FILTER.tonight, q) * 100, norm * 100, q);
  }

  // today so far against yesterday, last week and the last 20 sessions (the same slice of each)
  const slice = (r: Row) => sliceStats(r, csOf(r), k, theta);
  const dowMon = (new Date(label * DAY).getUTCDay() + 6) % 7;
  const week = label - dowMon - 7;
  const lastWeek = rows.slice(0, i).filter((r) => r.day >= week && r.day < week + 7);
  const todaySlice = slice(today);

  const six = DAY_FILTER.sixMonths;
  const pctOf = (v: number) => (v / (todaySlice?.open ?? price)) * 100;

  return {
    session: dayKey(label),
    slot: k,
    eveSlot,
    price,
    q2: k < P.slots ? finite(q2At(k)) : null,
    qd: k < P.slots ? finite(qdAt(k)) : null,
    qy: finite(qy),
    now: nowRead,
    tonight,
    soFar: {
      today: todaySlice,
      yesterday: i >= 1 ? slice(rows[i - 1]!) : null,
      lastWeek: summarise(lastWeek.map(slice), mean),
      norm: summarise(prior.map(slice), (v) => median(v, 1)),
    },
    openAt,
    marketOpen: marketOpen(now),
    typical: Array.from(
      { length: Math.floor((P.slots - P.minHorizon) / P.step) + 1 },
      (_, j) => j * P.step,
    )
      .map((slot) => ({
        slot,
        typ: read(base[slot]! * response(DAY_FILTER.now, 0) * 100, base[slot]! * 100, 0),
      }))
      .filter((x): x is { slot: number; typ: Read } => x.typ !== null)
      .map(({ slot, typ }) => ({ slot, at: openAt + slot * BAR, r: typ.r, verdict: typ.verdict })),
    sixMonth: todaySlice
      ? {
          range: percentile(six.rangePct, k, pctOf(todaySlice.range)),
          net: percentile(six.netPct, k, pctOf(Math.abs(todaySlice.net))),
          er: percentile(six.er, k, todaySlice.er),
        }
      : { range: null, net: null, er: null },
  };
}

/** The research backtest table closest to a stop of `stopUsd` at the current price. */
export function tablesFor(stopUsd: number, price: number) {
  const pct = (stopUsd / price) * 100;
  const all = Object.values(DAY_FILTER.tables);
  return all.reduce(
    (best, t) => (Math.abs(t.stopPct - pct) < Math.abs(best.stopPct - pct) ? t : best),
    all[0]!,
  );
}
