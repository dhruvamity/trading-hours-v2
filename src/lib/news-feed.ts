// Live US news → stand-aside windows.
// Release times come live from a free public calendar feed (see src/routes/api.news.ts).
// No release date is hard-coded anywhere. The only fixed data is how long the market stays
// abnormal after each kind of release, from the 3-year study (events.generated.ts).

import {
  EVENT_PROFILES,
  type EventKind,
  type EventProfile,
  type ProfileAsset,
} from "./events.generated";

export const NEWS_FEED_URLS = [
  "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
  "https://nfs.faireconomy.media/ff_calendar_nextweek.json",
];

export type Tier = 1 | 2 | 3;

export type LiveEvent = {
  /** epoch ms of the release */
  time: number;
  /** feed title, e.g. "Core PCE Price Index m/m" */
  name: string;
  /** study key when we have one; null = only the feed's impact label is known */
  kind: EventKind | null;
  tier: Tier;
  impact: "High" | "Medium";
};

/** Minimum stand-aside window by tier, minutes [before, after]. */
const FLOOR: Record<Tier, [number, number]> = { 1: [30, 45], 2: [15, 30], 3: [5, 15] };
const MAX_AFTER = 180;
/** The study found no real effect for these on gold/BTC. */
const QUIET = new Set<EventKind>(["MONTH_END", "QUARTER_END", "NVDA"]);
const MIN = 60_000;

const PATTERNS: [RegExp, EventKind | null, Tier | null][] = [
  [/FOMC (Statement|Press Conference)|Federal Funds Rate/i, "FOMC", 1],
  [/Jackson Hole/i, "JACKSON", 1],
  [/Fed Chair .*Speaks|Powell Speaks/i, null, 1],
  [/FOMC (Meeting )?Minutes/i, null, 2],
  [/^(Core )?CPI/i, "CPI", null],
  [/^ADP/i, null, 3], // private estimate two days early, not the jobs report
  [/Non-Farm|Unemployment Rate|Average Hourly Earnings/i, "NFP", null],
  [/PCE Price/i, "PCE", null],
  [/^(Advance|Prelim|Final) GDP q\/q/i, "GDP", null],
  [/^(Core )?PPI/i, "PPI", null],
  [/Retail Sales/i, "RETAIL", null],
  [/ISM Manufacturing/i, "ISM_MFG", null],
  [/ISM Services/i, "ISM_SERV", null],
  [/JOLTS/i, "JOLTS", null],
  [/Unemployment Claims/i, "CLAIMS", null],
];

export function classify(
  title: string,
  impact: "High" | "Medium",
): { kind: EventKind | null; tier: Tier } {
  for (const [re, kind, tier] of PATTERNS) {
    if (!re.test(title)) continue;
    const studied = kind ? EVENT_PROFILES.GOLD[kind]?.tier : undefined;
    return { kind, tier: (tier ?? studied ?? (impact === "High" ? 2 : 3)) as Tier };
  }
  return { kind: null, tier: impact === "High" ? 2 : 3 };
}

/** Raw feed rows → USD High/Medium releases, sorted. Bad rows are dropped, never guessed. */
type FeedRow = { country?: string; impact?: string; date?: string; title?: string };

export function parseFeed(raw: unknown): LiveEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: LiveEvent[] = [];
  for (const row of raw as FeedRow[]) {
    if (row.country !== "USD" || (row.impact !== "High" && row.impact !== "Medium")) continue;
    const time = Date.parse(String(row.date));
    const name = String(row.title ?? "").trim();
    if (!Number.isFinite(time) || !name) continue;
    out.push({ time, name, impact: row.impact, ...classify(name, row.impact) });
  }
  return out.sort((a, b) => a.time - b.time || a.tier - b.tier);
}

export function mergeFeeds(feeds: LiveEvent[][]): LiveEvent[] {
  const seen = new Map<string, LiveEvent>();
  for (const e of feeds.flat()) seen.set(`${e.time}|${e.name}`, e);
  return [...seen.values()].sort((a, b) => a.time - b.time || a.tier - b.tier);
}

export const profileOf = (e: LiveEvent, asset: ProfileAsset): EventProfile | undefined =>
  e.kind ? EVENT_PROFILES[asset][e.kind] : undefined;

export type Block = {
  from: number;
  to: number;
  /** the most important release inside the window */
  event: LiveEvent;
  profile: EventProfile | undefined;
  /** every release inside the window (several land at the same minute) */
  names: string[];
};

/** Stand-aside window: history sets the length, the tier floor keeps it sane. */
export function windowFor(e: LiveEvent, asset: ProfileAsset): { from: number; to: number } | null {
  if (e.kind && QUIET.has(e.kind)) return null;
  const p = profileOf(e, asset);
  const [fb, fa] = FLOOR[e.tier];
  const before = Math.max(fb, p?.blockBefore ?? 0);
  const after = Math.min(MAX_AFTER, Math.max(fa, p?.blockAfter ?? 0));
  return { from: e.time - before * MIN, to: e.time + after * MIN };
}

/** All blocks with overlapping ones merged (PCE + GDP + claims at one minute read as one). */
export function buildBlocks(events: readonly LiveEvent[], asset: ProfileAsset): Block[] {
  const raw = events.flatMap((e) => {
    const w = windowFor(e, asset);
    return w ? [{ ...w, event: e, profile: profileOf(e, asset), names: [e.name] }] : [];
  });
  raw.sort((a, b) => a.from - b.from);
  const out: Block[] = [];
  for (const b of raw) {
    const last = out[out.length - 1];
    if (last && b.from <= last.to) {
      last.to = Math.max(last.to, b.to);
      last.names.push(...b.names);
      if (b.event.tier < last.event.tier) {
        last.event = b.event;
        last.profile = b.profile;
      }
    } else out.push(b);
  }
  return out;
}

export type NewsState =
  | { state: "blocked"; block: Block; minutesLeft: number }
  | { state: "soon"; block: Block; minutesAway: number }
  | { state: "clear"; next: Block | null };

export function newsState(blocks: Block[], now: number, soonMin = 60): NewsState {
  const active = blocks.find((b) => now >= b.from && now < b.to);
  if (active)
    return { state: "blocked", block: active, minutesLeft: Math.ceil((active.to - now) / MIN) };
  const next = blocks.find((b) => b.from > now) ?? null;
  if (next && next.from - now <= soonMin * MIN)
    return { state: "soon", block: next, minutesAway: Math.ceil((next.from - now) / MIN) };
  return { state: "clear", next };
}
