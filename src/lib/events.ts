import type { Instrument } from "./timetable";
import { buildBlocks, type Block, type LiveEvent } from "./news-feed";
import type { ProfileAsset } from "./events.generated";

export type { Block, LiveEvent };

export const assetOf = (instrument: Instrument): ProfileAsset =>
  instrument === "XAUUSDT" ? "GOLD" : "BTC";

export function istDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(date);
}

/** Stand-aside blocks overlapping one IST calendar day, including ones spilling over midnight. */
export function blocksForIstDay(
  events: readonly LiveEvent[],
  dateKey: string,
  instrument: Instrument,
): Block[] {
  const dayStart = Date.parse(`${dateKey}T00:00:00+05:30`);
  const dayEnd = dayStart + 1440 * 60_000;
  return buildBlocks(events, assetOf(instrument)).filter((b) => b.to > dayStart && b.from < dayEnd);
}
