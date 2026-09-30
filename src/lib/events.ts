import type { Instrument } from "./timetable";
import {
  EVENT_CALENDAR,
  EVENT_PROFILES,
  EVENTS_META,
  PRE_NEWS,
  type CalendarEvent,
  type EventProfile,
  type PreNews,
  type ProfileAsset,
} from "./events.generated";

export { EVENT_CALENDAR, EVENT_PROFILES, EVENTS_META, PRE_NEWS };
export type { CalendarEvent, EventProfile, PreNews, ProfileAsset };

export type Verdict = "CLEAR" | "CAUTION" | "NEWS DAY" | "MARKET CLOSED";

export type Block = {
  from: number; // epoch ms
  to: number;
  event: CalendarEvent;
  profile: EventProfile | undefined;
};

export const assetOf = (instrument: Instrument): ProfileAsset =>
  instrument === "XAUUSDT" ? "GOLD" : "BTC";

/** Minimum stand-aside window by tier, in minutes, applied even if the history is milder. */
const FLOOR: Record<number, [number, number]> = { 1: [30, 45], 2: [15, 30], 3: [5, 15] };
/** Listed for context but not blocked: the study found little effect on gold/BTC. */
const QUIET_KINDS = new Set(["MONTH_END", "QUARTER_END", "NVDA"]);

const MIN = 60_000;

export function istDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(date);
}

export const istClock = (ms: number) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));

export const istDayLabel = (ms: number) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "2-digit",
    month: "short",
  }).format(new Date(ms));

export const eventTime = (event: CalendarEvent) => Date.parse(event.time);

const BY_IST_DAY = new Map<string, CalendarEvent[]>();
for (const e of EVENT_CALENDAR) {
  const key = istDateKey(new Date(eventTime(e)));
  BY_IST_DAY.set(key, [...(BY_IST_DAY.get(key) ?? []), e]);
}

export function eventsOnIstDay(dateKey: string): CalendarEvent[] {
  return BY_IST_DAY.get(dateKey) ?? [];
}

export function upcomingEvents(now: Date, days = 7, maxTier = 2): CalendarEvent[] {
  const start = now.getTime() - 3 * 60 * MIN;
  const end = now.getTime() + days * 1440 * MIN;
  return EVENT_CALENDAR.filter((e) => {
    const t = eventTime(e);
    return t >= start && t <= end && e.tier <= maxTier;
  });
}

/** Stand-aside window for one event: history says how long the market is abnormal, floors keep it sane. */
export function blockFor(event: CalendarEvent, instrument: Instrument): Block {
  const profile = EVENT_PROFILES[assetOf(instrument)][event.kind];
  const [floorBefore, floorAfter] = FLOOR[event.tier] ?? [5, 15];
  const before = Math.max(floorBefore, profile?.blockBefore ?? 0);
  const after = Math.min(180, Math.max(floorAfter, profile?.blockAfter ?? 0));
  const t = eventTime(event);
  return { from: t - before * MIN, to: t + after * MIN, event, profile };
}

/** Merge overlapping blocks so clustered releases (e.g. PCE + GDP + claims at 18:00) read as one. */
export function mergeBlocks(blocks: Block[]): Block[] {
  const sorted = [...blocks].sort((a, b) => a.from - b.from);
  const out: Block[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && b.from <= last.to) {
      last.to = Math.max(last.to, b.to);
      if (b.event.tier < last.event.tier) {
        last.event = b.event;
        last.profile = b.profile;
      }
    } else out.push({ ...b });
  }
  return out;
}

/** Blocks overlapping an IST calendar day, including ones spilling over midnight (e.g. FOMC). */
export function blocksForIstDay(dateKey: string, instrument: Instrument): Block[] {
  const dayStart = Date.parse(`${dateKey}T00:00:00+05:30`);
  const dayEnd = dayStart + 1440 * MIN;
  const nearby = [-1, 0, 1].flatMap((offset) =>
    eventsOnIstDay(istDateKey(new Date(dayStart + offset * 1440 * MIN + 12 * 60 * MIN))),
  );
  const blocks = nearby
    .filter((e) => !QUIET_KINDS.has(e.kind))
    .map((e) => blockFor(e, instrument))
    .filter((b) => b.to > dayStart && b.from < dayEnd);
  return mergeBlocks(blocks);
}

export function isGoldWeekend(date: Date): boolean {
  // Gold trades Mon 03:30 IST (CME Sunday open) to Sat ~02:30 IST (an hour later in US winter).
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
  }).format(date);
  return day === "Sat" || day === "Sun";
}

export type DayVerdict = {
  verdict: Verdict;
  headline: string;
  lines: string[];
  events: CalendarEvent[];
  blocks: Block[];
};

const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);

/** Releases whose run-up was studied in research/pre_news.py. */
const LOOKAHEAD_KINDS = new Set(["FOMC", "CPI", "NFP", "PCE"]);

export type Upcoming = { event: CalendarEvent; pre: PreNews };

/** Big releases in the next 72h (not today) with how the days before them usually trade. */
export function upcomingRunUps(now: Date, instrument: Instrument): Upcoming[] {
  const t = now.getTime();
  const todayKey = istDateKey(now);
  const asset = assetOf(instrument);
  return EVENT_CALENDAR.flatMap((event) => {
    const at = eventTime(event);
    const pre = PRE_NEWS[asset][event.kind];
    if (!LOOKAHEAD_KINDS.has(event.kind) || !pre || at <= t || at - t > 72 * 60 * MIN) return [];
    if (istDateKey(new Date(at)) === todayKey) return [];
    return [{ event, pre }];
  });
}

export function dayVerdict(date: Date, instrument: Instrument): DayVerdict {
  const key = istDateKey(date);
  const events = eventsOnIstDay(key);
  const blocks = blocksForIstDay(key, instrument);
  const asset = assetOf(instrument);
  const top = [...events].sort((a, b) => a.tier - b.tier)[0];

  if (instrument === "XAUUSDT" && isGoldWeekend(date)) {
    return {
      verdict: "MARKET CLOSED",
      headline:
        "Gold weekend: closed from Sat early morning until Mon 03:30 IST. Plan, don't trade.",
      lines: [],
      events,
      blocks,
    };
  }

  const lines: string[] = [];
  const runUps = upcomingRunUps(date, instrument);
  for (const { event, pre } of runUps) {
    lines.push(
      `${event.name} on ${istDayLabel(eventTime(event))}, ${istClock(eventTime(event))} IST. ${pre.verdict}`,
    );
  }
  const stallAhead = runUps.find((u) => u.pre.stall);
  for (const b of blocks) {
    const p = b.profile;
    lines.push(
      `No new ${asset === "GOLD" ? "gold" : "BTC"} trades ${istClock(b.from)}–${istClock(b.to)} IST (${b.event.name}).`,
    );
    if (p && b.event.tier <= 2) {
      if ((p.preSessionRange ?? 1) <= 0.85)
        lines.push(
          `${asset === "GOLD" ? "Gold" : "BTC"} usually moves ~${Math.round((1 - (p.preSessionRange ?? 1)) * 100)}% less than normal in the 5h before ${b.event.name} — expect smaller moves, don't force trades.`,
        );
      if ((p.preSessionChop ?? 0) <= -0.03)
        lines.push(
          `Before ${b.event.name}, the hours leading in are usually choppier than normal — keep size small or wait.`,
        );
      if (p.whipsaw != null && p.whipsawBase != null && p.whipsaw >= p.whipsawBase + 0.1)
        lines.push(
          `First 30 min wicked both ways ${pct(p.whipsaw)} of the time (normal ${pct(p.whipsawBase)}). Don't trade the spike.`,
        );
      // "Small effect" adds nothing beyond the block line itself
      if (!p.advice.startsWith("Small effect") && !lines.includes(p.advice)) lines.push(p.advice);
    }
  }

  if (!top || blocks.length === 0) {
    return {
      verdict: "CLEAR",
      headline: stallAhead
        ? `No US news today, but ${stallAhead.event.name} is coming and markets usually stall before it. Smaller targets, fewer trades.`
        : "No scheduled US news that moves this market today. Follow the timetable.",
      lines,
      events,
      blocks,
    };
  }
  if (top.tier === 1) {
    return {
      verdict: "NEWS DAY",
      headline: `${top.name} today at ${istClock(eventTime(top))} IST. Trade only outside the blocked windows, smaller size.`,
      lines,
      events,
      blocks,
    };
  }
  return {
    verdict: top.tier === 2 ? "CAUTION" : "CLEAR",
    headline:
      top.tier === 2
        ? `${top.name} at ${istClock(eventTime(top))} IST. Stand aside around it; the rest of the day is normal.`
        : `Only minor releases today (${top.name}). Short pause around ${istClock(eventTime(top))} IST.`,
    lines,
    events,
    blocks,
  };
}

export function activeBlock(now: Date, blocks: Block[]): Block | undefined {
  const t = now.getTime();
  return blocks.find((b) => t >= b.from && t < b.to);
}
