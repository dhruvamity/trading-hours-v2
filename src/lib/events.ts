import type { Instrument } from "./timetable";
import {
  EVENT_PROFILES,
  EVENTS_META,
  PRE_NEWS,
  type EventProfile,
  type PreNews,
  type ProfileAsset,
} from "./events.generated";
import { buildBlocks, type Block, type LiveEvent } from "./news-feed";

export { EVENT_PROFILES, EVENTS_META, PRE_NEWS };
export type { EventProfile, PreNews, ProfileAsset, Block, LiveEvent };

export type Verdict = "CLEAR" | "CAUTION" | "NEWS DAY" | "MARKET CLOSED";

export const assetOf = (instrument: Instrument): ProfileAsset =>
  instrument === "XAUUSDT" ? "GOLD" : "BTC";

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

export const eventTime = (event: LiveEvent) => event.time;

export function eventsOnIstDay(events: readonly LiveEvent[], dateKey: string): LiveEvent[] {
  return events.filter((e) => istDateKey(new Date(e.time)) === dateKey);
}

export function upcomingEvents(
  events: readonly LiveEvent[],
  now: Date,
  days = 7,
  maxTier = 2,
): LiveEvent[] {
  const start = now.getTime() - 3 * 60 * MIN;
  const end = now.getTime() + days * 1440 * MIN;
  return events.filter((e) => e.time >= start && e.time <= end && e.tier <= maxTier);
}

/** Blocks overlapping an IST calendar day, including ones spilling over midnight (e.g. FOMC). */
export function blocksForIstDay(
  events: readonly LiveEvent[],
  dateKey: string,
  instrument: Instrument,
): Block[] {
  const dayStart = Date.parse(`${dateKey}T00:00:00+05:30`);
  const dayEnd = dayStart + 1440 * MIN;
  return buildBlocks(events, assetOf(instrument)).filter((b) => b.to > dayStart && b.from < dayEnd);
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
  events: LiveEvent[];
  blocks: Block[];
};

const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);

/** Releases whose run-up was studied in research/pre_news.py. */
const LOOKAHEAD_KINDS = new Set(["FOMC", "CPI", "NFP", "PCE"]);

export type Upcoming = { event: LiveEvent; pre: PreNews };

/** Big releases in the next 72h (not today) with how the days before them usually trade. */
export function upcomingRunUps(
  events: readonly LiveEvent[],
  now: Date,
  instrument: Instrument,
): Upcoming[] {
  const t = now.getTime();
  const todayKey = istDateKey(now);
  const asset = assetOf(instrument);
  return events.flatMap((event) => {
    const at = eventTime(event);
    const pre = event.kind ? PRE_NEWS[asset][event.kind] : undefined;
    if (
      !event.kind ||
      !LOOKAHEAD_KINDS.has(event.kind) ||
      !pre ||
      at <= t ||
      at - t > 72 * 60 * MIN
    )
      return [];
    if (istDateKey(new Date(at)) === todayKey) return [];
    return [{ event, pre }];
  });
}

/** `feed` = every release the live feed knows; `feedOk` = false when the feed could not be reached. */
export function dayVerdict(
  feed: readonly LiveEvent[],
  feedOk: boolean,
  date: Date,
  instrument: Instrument,
): DayVerdict {
  const key = istDateKey(date);
  const events = eventsOnIstDay(feed, key);
  const blocks = blocksForIstDay(feed, key, instrument);
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
  const runUps = upcomingRunUps(feed, date, instrument);
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

  if (!feedOk) {
    return {
      verdict: "CAUTION",
      headline:
        "News feed unreachable, so today's releases are unknown. Check a live economic calendar before trading.",
      lines,
      events,
      blocks,
    };
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
