import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { NewsDrawer } from "@/components/news-drawer";
import { Signal } from "@/components/signal";
import { blocksForIstDay, istDateKey } from "@/lib/events";
import { clock } from "@/lib/format";
import { useGate } from "@/lib/use-gate";
import { useNews } from "@/lib/use-news";
import {
  DAYS,
  INSTRUMENTS,
  RESEARCH_META,
  SCHEDULES,
  toMinutes,
  usRegime,
  type Day,
  type Instrument,
  type Status,
} from "@/lib/timetable";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "IST Session Terminal — BTC & Gold Trading Timetable" },
      {
        name: "description",
        content: "Research-driven IST trading windows for BTCUSDT and XAUUSDT perpetuals.",
      },
      { property: "og:title", content: "IST Session Terminal" },
      {
        property: "og:description",
        content: "Research-driven IST trading windows for BTCUSDT and XAUUSDT perpetuals.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

const statusClass: Record<Status, string> = {
  PRIME: "bg-status-prime text-status-prime",
  "SWING ENTRY": "bg-status-swing text-status-swing",
  "SMALL TRADES": "bg-status-small text-status-small",
  "NO TRADE": "bg-status-stop text-status-stop",
  CLOSED: "bg-status-closed text-status-closed",
};
const bg = (status: Status) => statusClass[status].split(" ")[0];
const fg = (status: Status) => statusClass[status].split(" ")[1];

function getIstParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return {
    day: part("weekday") as Day,
    date: `${part("day")} ${part("month")} ${part("year")}`,
    time: `${part("hour")}:${part("minute")}:${part("second")}`,
    minutes: Number(part("hour")) * 60 + Number(part("minute")) + Number(part("second")) / 60,
  };
}

const BEST: Status[] = ["PRIME", "SWING ENTRY"];
const tierTone = ["", "text-status-stop", "text-status-small", "text-muted-foreground"];

function Index() {
  const [now, setNow] = useState<Date | null>(null);
  const [instrument, setInstrument] = useState<Instrument>("XAUUSDT");
  const [selectedDay, setSelectedDay] = useState<Day | null>(null);
  const [hoverPercent, setHoverPercent] = useState<number | null>(null);
  const feed = useNews();

  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const ist = getIstParts(now ?? new Date(0));
  const regime = usRegime(now ?? new Date(0));
  const day = selectedDay ?? ist.day;
  const sessions = SCHEDULES[instrument][regime][day].windows;
  const isLiveDay = now !== null && day === ist.day;

  const gate = useGate(now, instrument, feed);

  // The rail shows the chosen weekday (today, or its next occurrence) with that day's news blocks.
  const railDate = new Date(
    (now ?? new Date(0)).getTime() +
      ((DAYS.indexOf(day) - DAYS.indexOf(ist.day) + 7) % 7) * 86_400_000,
  );
  const railKey = istDateKey(railDate);
  const railBlocks = now ? blocksForIstDay(feed.events, railKey, instrument) : [];
  const dayStartMs = Date.parse(`${railKey}T00:00:00+05:30`);
  const railMinute = (ms: number) => Math.min(1440, Math.max(0, (ms - dayStartMs) / 60_000));

  const statusAt = (minutes: number) =>
    sessions.find((slot) => minutes >= toMinutes(slot.start) && minutes < toMinutes(slot.end));
  const handleRailMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setHoverPercent(Math.min(99.99, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100)));
  };
  const hoverMinutes = hoverPercent !== null ? hoverPercent * 14.4 : null;
  const hoverWindow = hoverMinutes !== null ? statusAt(hoverMinutes) : undefined;
  const hoverShift =
    hoverPercent !== null
      ? hoverPercent < 10
        ? "translate-x-0"
        : hoverPercent > 90
          ? "-translate-x-full"
          : "-translate-x-1/2"
      : "";

  const tradeWindows = sessions.filter((slot) => BEST.includes(slot.status));

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-6 sm:py-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="inline-flex border border-border bg-panel p-1">
            {INSTRUMENTS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setInstrument(item.id)}
                className={`min-w-24 px-4 py-2 text-sm font-bold transition-colors ${instrument === item.id ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
                aria-pressed={instrument === item.id}
              >
                {item.id === "XAUUSDT" ? "GOLD" : "BTC"}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-5">
            <Link
              to="/filter"
              className="text-sm font-semibold text-muted-foreground hover:text-foreground"
            >
              Day filter →
            </Link>
            <Link
              to="/journal"
              className="text-sm font-semibold text-muted-foreground hover:text-foreground"
            >
              Journal →
            </Link>
            <div className="text-right" aria-live="polite">
              <span className="text-3xl font-bold tabular-nums">{now ? ist.time : "--:--:--"}</span>
              <span className="ml-2 text-sm font-medium text-muted-foreground">
                IST · {now ? ist.day.slice(0, 3) : ""}
              </span>
            </div>
          </div>
        </header>

        <Signal g={gate} today={now ? ist.day : null} />

        <section
          className="mt-6 border border-border bg-panel p-4 sm:p-5"
          aria-label={`${day} timeline`}
        >
          <div className="grid grid-cols-7 gap-1" role="group" aria-label="Day">
            {DAYS.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setSelectedDay(item === ist.day ? null : item)}
                className={`min-h-10 text-sm font-semibold uppercase transition-colors ${day === item ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                aria-label={item}
                aria-pressed={day === item}
              >
                {item.slice(0, 3)}
              </button>
            ))}
          </div>

          <div
            className="relative mt-9"
            onMouseMove={handleRailMove}
            onMouseLeave={() => setHoverPercent(null)}
          >
            {hoverPercent !== null && hoverWindow && (
              <div
                className="pointer-events-none absolute -top-7 z-30"
                style={{ left: `${hoverPercent}%` }}
              >
                <span
                  className={`absolute flex items-center gap-2 whitespace-nowrap border border-border bg-panel px-2.5 py-1.5 text-xs font-bold uppercase ${hoverShift}`}
                >
                  <span className={`size-2 rounded-full ${bg(hoverWindow.status)}`} />
                  <span className={fg(hoverWindow.status)}>{hoverWindow.status}</span>
                </span>
              </div>
            )}
            <div className="relative h-16 cursor-crosshair overflow-hidden border border-border bg-background">
              {sessions.map((slot) => (
                <div
                  key={`${slot.start}-${slot.status}`}
                  className={`absolute inset-y-0 border-r border-background/70 ${bg(slot.status)}`}
                  style={{
                    left: `${toMinutes(slot.start) / 14.4}%`,
                    width: `${(toMinutes(slot.end) - toMinutes(slot.start)) / 14.4}%`,
                    opacity: slot.status === "NO TRADE" || slot.status === "CLOSED" ? 0.3 : 0.9,
                  }}
                />
              ))}
              {railBlocks.map((block) => (
                <div
                  key={block.from}
                  className="news-block absolute inset-y-0 z-[5] border-x border-status-stop"
                  style={{
                    left: `${railMinute(block.from) / 14.4}%`,
                    width: `${(railMinute(block.to) - railMinute(block.from)) / 14.4}%`,
                  }}
                  title={`${block.event.name}: stand aside ${clock(railMinute(block.from))}–${clock(railMinute(block.to))} IST`}
                />
              ))}
              {isLiveDay && (
                <div
                  className="absolute inset-y-0 z-10 w-0.5 bg-live-marker"
                  style={{ left: `${Math.min(100, ist.minutes / 14.4)}%` }}
                />
              )}
            </div>
            {hoverPercent !== null && (
              <div
                className="pointer-events-none absolute inset-y-0 z-20 w-px border-l border-dashed border-foreground/60"
                style={{ left: `${hoverPercent}%` }}
              />
            )}
          </div>
          <div className="mt-2 flex justify-between text-xs font-medium text-muted-foreground">
            {["00:00", "06:00", "12:00", "18:00", "24:00"].map((tick) => (
              <span key={tick}>{tick}</span>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
            {(Object.keys(statusClass) as Status[]).map((status) => (
              <div key={status} className="flex items-center gap-2">
                <span className={`size-2.5 rounded-full ${bg(status)}`} />
                <span className="text-xs font-semibold text-muted-foreground">{status}</span>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <span className="news-block size-3 border border-status-stop" />
              <span className="text-xs font-semibold text-muted-foreground">NEWS</span>
            </div>
          </div>

          <div className="mt-5 border-t border-border pt-4 text-base">
            <div>
              <p className="terminal-label">Best windows</p>
              <ul className="mt-2 space-y-1.5">
                {tradeWindows.length === 0 && (
                  <li className="text-muted-foreground">No prime window.</li>
                )}
                {tradeWindows.map((slot) => (
                  <li
                    key={`${slot.start}-${slot.end}`}
                    className="flex items-center gap-2 tabular-nums"
                  >
                    <span className={`size-2.5 rounded-full ${bg(slot.status)}`} />
                    {slot.start}–{slot.end}
                    <span className={`text-sm font-semibold ${fg(slot.status)}`}>
                      {slot.status}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <footer className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
          <a href="/news.html" className="font-medium hover:text-foreground">
            News study
          </a>
          <a href="/report.html" className="font-medium hover:text-foreground">
            Research
          </a>
          <span className="sm:ml-auto">Data through {RESEARCH_META.dataThrough}</span>
        </footer>
      </div>
      <NewsDrawer feed={feed} now={now} />
    </main>
  );
}
