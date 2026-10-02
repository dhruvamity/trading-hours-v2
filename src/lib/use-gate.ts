import { useMemo } from "react";
import { assetOf } from "./events";
import { dayKey, dayStats, evaluateGate, lockStatus } from "./discipline";
import { clock } from "./format";
import { buildBlocks, newsState } from "./news-feed";
import { DAYS, locate, usRegime, weekTimeline, type Instrument } from "./timetable";
import { useTrades } from "./trade-log";
import type { NewsFeed } from "./use-news";

const istMinuteOfWeek = (date: Date) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  );
  const day = DAYS.indexOf(p["weekday"] as (typeof DAYS)[number]);
  return day * 1440 + Number(p["hour"]) * 60 + Number(p["minute"]) + Number(p["second"]) / 60;
};

/** Everything the page needs to answer "can I trade now?": window, news, and the logged-trade checks. */
export function useGate(now: Date | null, instrument: Instrument, feed: NewsFeed) {
  const [trades, setTrades, ready] = useTrades();
  const t = now?.getTime() ?? 0;
  const regime = usRegime(now ?? new Date(0));
  const timeline = useMemo(() => weekTimeline(instrument, regime), [instrument, regime]);

  return useMemo(() => {
    const live = locate(timeline, istMinuteOfWeek(new Date(t)));
    const windowStatus = live.current?.status ?? "CLOSED";
    const windowEnd = live.current ? clock(live.current.to % 1440) : null;
    const blocks = buildBlocks(feed.events, assetOf(instrument));
    const day = dayStats(trades, dayKey(t));
    const open = trades.find((x) => x.closedAt == null);
    const gate = evaluateGate({
      now: t,
      window: { status: windowStatus, end: windowEnd },
      news: feed.ok ? newsState(blocks, t) : null,
      day,
      openCount: open ? 1 : 0,
    });
    return {
      ...gate,
      live,
      windowStatus,
      windowEnd,
      day,
      open,
      lock: lockStatus(day),
      trades,
      setTrades,
      ready,
    };
  }, [timeline, t, feed, instrument, trades, setTrades, ready]);
}
export type GateState = ReturnType<typeof useGate>;
