export type Status = "NO TRADE" | "SMALL TRADES" | "PRIME" | "SWING ENTRY" | "CLOSED";

export type Window = {
  start: string;
  end: string;
  status: Status;
  /** Intraday score, 1 = a typical half-hour for this instrument. */
  score: number | null;
  /** |net 60-min move| / ATR. */
  move: number | null;
  /** Average |net 60-min move| in percent of price. */
  movePct: number | null;
  /** Kaufman efficiency ratio of the next 60 minutes (1 = straight line). */
  efficiency: number | null;
  /** P(next 60 min continues the previous 30 min's direction). */
  followThrough: number | null;
  /** Share of weeks this window beat the day's median half-hour. */
  consistency: number | null;
  note: string;
};

export type DaySchedule = { windows: Window[]; profile: (number | null)[] };

export type Instrument = "BTCUSDT" | "XAUUSDT";
export type Regime = "summer" | "winter";

export const DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;
export type Day = (typeof DAYS)[number];

export type Schedules = Record<Instrument, Record<Regime, Record<Day, DaySchedule>>>;

export type ResearchMeta = {
  generated: string;
  dataThrough: string;
  halfLifeWeeks: number;
  btcFrom: string;
  goldFrom: string;
  goldSplice: string;
  goldHistorySource: string;
  /** Date range left out of the gold history for lack of clean 5m data ("" if none). */
  goldGaps: string;
  oosRankCorr: Record<Instrument, number>;
};

export { RESEARCH_META, SCHEDULES } from "./timetable.generated";
import { SCHEDULES } from "./timetable.generated";

export const INSTRUMENTS: { id: Instrument; label: string }[] = [
  { id: "BTCUSDT", label: "BTCUSDT Perpetual" },
  { id: "XAUUSDT", label: "Gold · XAUUSDT Perpetual" },
];

export const TRADE_STATUSES: Status[] = ["PRIME", "SWING ENTRY", "SMALL TRADES"];

export function toMinutes(time: string) {
  if (time === "24:00") return 1440;
  const [hours = "0", minutes = "0"] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

/** US daylight time decides where London/NY sessions fall in IST (they shift 1h). */
export function usRegime(date: Date): Regime {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "short",
  })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;
  return name === "EDT" ? "summer" : "winter";
}

export type TimelineWindow = Window & { day: Day; from: number; to: number };

const WEEK = 7 * 1440;

/** Whole-week timeline (minutes from Monday 00:00 IST), with same-status windows merged across midnight. */
export function weekTimeline(instrument: Instrument, regime: Regime): TimelineWindow[] {
  const out: TimelineWindow[] = [];
  DAYS.forEach((day, index) => {
    for (const w of SCHEDULES[instrument][regime][day].windows) {
      const from = index * 1440 + toMinutes(w.start);
      const to = index * 1440 + toMinutes(w.end);
      const last = out[out.length - 1];
      if (last && last.status === w.status && last.to === from && last.note === w.note)
        last.to = to;
      else out.push({ ...w, day, from, to });
    }
  });
  return out;
}

/** Current window and the upcoming ones, wrapping around the week. `at` = minutes from Monday 00:00 IST. */
export function locate(timeline: TimelineWindow[], at: number) {
  const index = timeline.findIndex((w) => at >= w.from && at < w.to);
  const upcoming = (predicate: (w: TimelineWindow) => boolean) => {
    for (let step = 1; step <= timeline.length; step += 1) {
      const w = timeline[(index + step) % timeline.length]!;
      if (predicate(w)) return { window: w, startsIn: (w.from - at + WEEK) % WEEK };
    }
    return undefined;
  };
  const current = index >= 0 ? timeline[index] : undefined;
  return {
    current,
    endsIn: current ? current.to - at : 0,
    next: upcoming(() => true),
    nextTrade: upcoming((w) => TRADE_STATUSES.includes(w.status)),
    nextPrime: upcoming((w) => w.status === "PRIME" || w.status === "SWING ENTRY"),
  };
}
