import { useMemo, useState } from "react";
import { assetOf } from "@/lib/events";
import {
  dayKey,
  dayStats,
  evaluateGate,
  lockStatus,
  type CheckState,
  type TradeEntry,
} from "@/lib/discipline";
import { formatCountdown } from "@/lib/format";
import { buildBlocks, newsState } from "@/lib/news-feed";
import type { Instrument, Status } from "@/lib/timetable";
import { newId, useTrades } from "@/lib/trade-log";
import type { NewsFeed } from "@/lib/use-news";

const dot: Record<CheckState, string> = {
  pass: "bg-status-prime",
  warn: "bg-status-small",
  fail: "bg-status-stop",
};

const SHORT: Record<string, string> = {
  window: "Window",
  news: "News",
  losses: "Losses",
  cooldown: "Cooldown",
  open: "Open",
};

type Props = {
  now: Date | null;
  instrument: Instrument;
  feed: NewsFeed;
  windowStatus: Status;
  windowEnd: string | null;
  /** minutes until the current window ends */
  endsIn: number | null;
  next: { status: Status; startsIn: number; at: string } | null;
};

/** The one-glance answer: can I trade right now, until when, and why not. */
export function Signal({ now, instrument, feed, windowStatus, windowEnd, endsIn, next }: Props) {
  const [trades, setTrades, ready] = useTrades();
  const [confirming, setConfirming] = useState(false);
  const [side, setSide] = useState<"long" | "short">("long");
  const t = now?.getTime() ?? 0;

  const g = useMemo(() => {
    const blocks = buildBlocks(feed.events, assetOf(instrument));
    const news = feed.ok ? newsState(blocks, t) : null;
    const day = dayStats(trades, dayKey(t));
    const open = trades.find((x) => x.closedAt == null);
    const gate = evaluateGate({
      now: t,
      window: { status: windowStatus, end: windowEnd },
      news,
      day,
      openCount: open ? 1 : 0,
    });
    return { ...gate, day, open, news };
  }, [feed, instrument, t, trades, windowStatus, windowEnd]);

  if (!now || !ready)
    return <section className="mt-6 h-56 border border-border bg-panel" aria-hidden="true" />;

  const closed = windowStatus === "CLOSED";
  const lock = lockStatus(g.day);
  const nogo = g.verdict === "NO-GO";
  const word = closed ? "CLOSED" : g.verdict;
  const color = closed
    ? "text-status-closed"
    : nogo
      ? "text-status-stop"
      : g.verdict === "GO"
        ? "text-status-prime"
        : "text-status-small";
  const edge = closed
    ? "border-status-closed/50"
    : nogo
      ? "border-status-stop/60"
      : g.verdict === "GO"
        ? "border-status-prime/50"
        : "border-status-small/50";
  const problems = g.checks.filter((c) => c.state !== "pass");
  const reason = closed
    ? "Market shut."
    : g.verdict === "GO"
      ? `${windowStatus} window${windowEnd ? ` until ${windowEnd} IST` : ""}.`
      : problems
          .slice(0, 1)
          .map((c) => c.detail)
          .join(" ");

  const take = () => {
    const entry: TradeEntry = {
      id: newId(),
      instrument,
      side,
      openedAt: t,
      note: "",
      verdict: g.verdict,
      failed: g.checks.filter((c) => c.state === "fail").map((c) => c.id),
      warned: g.checks.filter((c) => c.state === "warn").map((c) => c.id),
    };
    setTrades((old) => [...old, entry]);
    setConfirming(false);
  };
  const close = (result: "win" | "loss") =>
    setTrades((old) =>
      old.map((x) => (x.id === g.open?.id ? { ...x, closedAt: Date.now(), result } : x)),
    );

  return (
    <section className={`mt-6 border bg-panel p-5 sm:p-7 ${edge}`} aria-label="Trading signal">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className={`text-6xl font-bold leading-none sm:text-7xl ${color}`}>{word}</p>
          <p className="mt-3 text-lg">{reason}</p>
          {lock.locked && (
            <p className="mt-1 text-base font-semibold text-status-stop">
              Day locked. Stop and write the journal.
            </p>
          )}
        </div>
        <div className="shrink-0 text-base sm:text-right">
          {!closed && endsIn !== null && (
            <p className="tabular-nums">
              <span className="text-muted-foreground">Window ends </span>
              <span className="font-semibold">{formatCountdown(endsIn)}</span>
            </p>
          )}
          {next && (
            <p className="mt-1 text-muted-foreground">
              Next: <span className="font-semibold text-foreground">{next.status}</span> {next.at} ·
              in {formatCountdown(next.startsIn)}
            </p>
          )}
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm" aria-label="Checks">
          {g.checks.map((c) => (
            <li key={c.id} title={c.detail} className="flex items-center gap-2">
              <span className={`size-2.5 rounded-full ${dot[c.state]}`} />
              <span className={c.state === "pass" ? "text-muted-foreground" : "font-semibold"}>
                {SHORT[c.id]}
                {c.id === "losses" && ` ${g.day.losses}/2`}
              </span>
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          {g.open ? (
            <>
              <span className="font-semibold">Open {g.open.side}</span>
              <button
                onClick={() => close("win")}
                className="border border-status-prime px-3 py-1.5 font-semibold text-status-prime"
              >
                Won
              </button>
              <button
                onClick={() => close("loss")}
                className="border border-status-stop px-3 py-1.5 font-semibold text-status-stop"
              >
                Lost
              </button>
            </>
          ) : (
            <>
              {(["long", "short"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSide(s)}
                  className={`border px-3 py-1.5 font-semibold capitalize ${side === s ? "border-foreground" : "border-border text-muted-foreground"}`}
                >
                  {s}
                </button>
              ))}
              {confirming ? (
                <>
                  <button
                    onClick={take}
                    className="border border-status-stop px-3 py-1.5 font-semibold text-status-stop"
                  >
                    Enter anyway
                  </button>
                  <button
                    onClick={() => setConfirming(false)}
                    className="px-2 py-1.5 text-muted-foreground"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={() => (nogo || closed ? setConfirming(true) : take())}
                  className="border border-foreground px-3 py-1.5 font-semibold"
                >
                  Log entry
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
