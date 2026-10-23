import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { FileBarChart2, MoonStar } from "lucide-react";
import {
  DAYS,
  INSTRUMENTS,
  RESEARCH_META,
  SCHEDULES,
  locate,
  toMinutes,
  usRegime,
  weekTimeline,
  type Day,
  type Instrument,
  type Regime,
  type Status,
  type Window,
} from "@/lib/timetable";
import {
  activeForexSessions,
  FOREX_SESSIONS,
  FOREX_SOURCE_URL,
  forexSessionsForIstDate,
  isForexMarketOpen,
  istDateKey,
} from "@/lib/forex-hours";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "IST Session Terminal — BTC & Gold Trading Timetable" },
      {
        name: "description",
        content: "Research-driven IST windows for BTC and Gold, plus live Forex market sessions.",
      },
      { property: "og:title", content: "IST Session Terminal" },
      {
        property: "og:description",
        content: "Research-driven IST windows for BTC and Gold, plus live Forex market sessions.",
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

// Score bars are drawn between these bounds so differences between slots stay visible.
const PROFILE_MIN = 0.3;
const PROFILE_MAX = 2.2;
const profileHeight = (value: number) =>
  `${Math.min(100, Math.max(4, ((value - PROFILE_MIN) / (PROFILE_MAX - PROFILE_MIN)) * 100))}%`;

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

function formatCountdown(totalMinutes: number) {
  const safe = Math.max(0, Math.floor(totalMinutes * 60));
  const days = Math.floor(safe / 86400);
  const hours = Math.floor((safe % 86400) / 3600)
    .toString()
    .padStart(2, "0");
  const minutes = Math.floor((safe % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (safe % 60).toString().padStart(2, "0");
  return `${days ? `${days}d ` : ""}${hours}:${minutes}:${seconds}`;
}

const clock = (minutes: number) =>
  `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(Math.floor(minutes % 60)).padStart(2, "0")}`;
const fmt = (value: number | null, digits = 2) => (value === null ? "—" : value.toFixed(digits));
const pct = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);

type DashboardInstrument = Instrument | "FOREX";

const DASHBOARD_INSTRUMENTS: { id: DashboardInstrument; label: string }[] = [
  ...INSTRUMENTS,
  { id: "FOREX", label: "Forex market sessions" },
];

function dateKeyForDay(now: Date, currentDay: Day, selectedDay: Day) {
  const [year, month, day] = istDateKey(now).split("-").map(Number);
  const offset = DAYS.indexOf(selectedDay) - DAYS.indexOf(currentDay);
  return new Date(Date.UTC(year!, month! - 1, day! + offset)).toISOString().slice(0, 10);
}

function Index() {
  const [now, setNow] = useState<Date | null>(null);
  const [instrument, setInstrument] = useState<DashboardInstrument>("BTCUSDT");
  const [selectedDay, setSelectedDay] = useState<Day | null>(null);
  const [regimeOverride, setRegimeOverride] = useState<Regime | null>(null);
  const [hoverPercent, setHoverPercent] = useState<number | null>(null);

  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const ist = getIstParts(now ?? new Date(0));
  const liveRegime = usRegime(now ?? new Date(0));
  const regime = regimeOverride ?? liveRegime;
  const day = selectedDay ?? ist.day;
  const isForex = instrument === "FOREX";
  // Forex has overlapping city sessions rather than the research-scored
  // timetable used by BTC and Gold. Keep the established timetable type narrow.
  const researchInstrument: Instrument = isForex ? "BTCUSDT" : instrument;
  const schedule = SCHEDULES[researchInstrument][regime][day];
  const sessions = schedule.windows;
  const isLiveDay = now !== null && day === ist.day;

  const timeline = useMemo(
    () => weekTimeline(researchInstrument, regime),
    [researchInstrument, regime],
  );
  const weekMinute = DAYS.indexOf(ist.day) * 1440 + ist.minutes;
  const live = locate(timeline, weekMinute);
  const activeIndex = isLiveDay
    ? sessions.findIndex(
        (slot) => ist.minutes >= toMinutes(slot.start) && ist.minutes < toMinutes(slot.end),
      )
    : -1;

  const statusAt = (minutes: number): Window | undefined =>
    sessions.find((slot) => minutes >= toMinutes(slot.start) && minutes < toMinutes(slot.end));
  const handleRailMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setHoverPercent(Math.min(99.99, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100)));
  };
  const hoverMinutes = hoverPercent !== null ? hoverPercent * 14.4 : null;
  const hoverWindow = hoverMinutes !== null ? statusAt(hoverMinutes) : undefined;
  const hoverScore =
    hoverMinutes !== null ? (schedule.profile[Math.floor(hoverMinutes / 30)] ?? null) : null;
  const hoverShift =
    hoverPercent !== null
      ? hoverPercent < 10
        ? "translate-x-0"
        : hoverPercent > 90
          ? "-translate-x-full"
          : "-translate-x-1/2"
      : "";

  const durationLabel = (start: string, end: string) => {
    const minutes = toMinutes(end) - toMinutes(start);
    return minutes % 60 === 0
      ? `${minutes / 60}h`
      : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  };
  const whenLabel = (w: { day: Day; from: number }) =>
    `${w.day === ist.day ? "Today" : w.day.slice(0, 3)} ${clock(w.from % 1440)}`;
  const instrumentLabel =
    DASHBOARD_INSTRUMENTS.find((item) => item.id === instrument)?.label ?? instrument;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6 sm:py-8 lg:px-8">
        <header className="flex flex-col gap-5 border-b border-border pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold sm:text-4xl">Trading hours</h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <a
                href="/report.html"
                className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                <FileBarChart2 className="size-4" aria-hidden="true" />
                Research report
              </a>
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
            </div>
          </div>
          <div className="flex items-center gap-3 sm:text-right">
            <MoonStar className="size-5 text-muted-foreground" aria-hidden="true" />
            <div>
              <div className="text-3xl font-bold tabular-nums sm:text-4xl" aria-live="polite">
                {now ? ist.time : "--:--:--"}
                <span className="ml-2 text-sm font-medium text-muted-foreground">IST</span>
              </div>
              <div className="mt-1 text-sm text-muted-foreground">
                {now ? `${ist.day} · ${ist.date}` : "Synchronising time"}
              </div>
            </div>
          </div>
        </header>

        <section className="mt-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="inline-flex w-fit border border-border bg-panel p-1">
            {DASHBOARD_INSTRUMENTS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setInstrument(item.id)}
                className={`min-w-28 px-4 py-2.5 text-sm font-bold transition-colors ${instrument === item.id ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
                aria-pressed={instrument === item.id}
              >
                {item.id}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {!isForex && (
              <div
                className="inline-flex border border-border bg-panel p-1"
                role="group"
                aria-label="US clock"
              >
                {([null, "summer", "winter"] as (Regime | null)[]).map((item) => (
                  <button
                    key={item ?? "auto"}
                    type="button"
                    onClick={() => setRegimeOverride(item)}
                    className={`min-h-10 px-3 text-sm font-semibold uppercase transition-colors ${regimeOverride === item ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    aria-pressed={regimeOverride === item}
                  >
                    {item === null
                      ? `Auto · ${liveRegime === "summer" ? "EDT" : "EST"}`
                      : item === "summer"
                        ? "US summer"
                        : "US winter"}
                  </button>
                ))}
              </div>
            )}
            <div className="grid grid-cols-7 border border-border bg-panel p-1">
              {DAYS.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setSelectedDay(item)}
                  className={`min-h-10 px-2.5 text-sm font-semibold uppercase transition-colors sm:px-3.5 ${day === item ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  aria-label={item}
                  aria-pressed={day === item}
                >
                  {item.slice(0, 3)}
                </button>
              ))}
            </div>
          </div>
        </section>

        {isForex ? (
          <ForexHours
            now={now}
            dateKey={dateKeyForDay(now ?? new Date(), ist.day, day)}
            isLiveDay={isLiveDay}
            day={day}
            selectedDay={Boolean(selectedDay)}
            onReturnToToday={() => setSelectedDay(null)}
          />
        ) : (
          <>
            <section
              className="mt-4 grid gap-px border border-border bg-border md:grid-cols-3"
              aria-label="Live guidance"
            >
              <div className="bg-panel p-5">
                <p className="terminal-label">Now · {instrument}</p>
                <div className="mt-2.5 flex items-center gap-2.5">
                  <span className={`size-3 rounded-full ${bg(live.current?.status ?? "CLOSED")}`} />
                  <p className={`text-2xl font-bold ${fg(live.current?.status ?? "CLOSED")}`}>
                    {now ? (live.current?.status ?? "CLOSED") : "—"}
                  </p>
                </div>
                <p className="mt-3 text-base tabular-nums text-muted-foreground">
                  {now && live.current
                    ? `until ${clock(live.current.to % 1440)} · ${formatCountdown(live.endsIn)}`
                    : "—"}
                </p>
              </div>
              <div className="bg-panel p-5">
                <p className="terminal-label">Next change</p>
                <div className="mt-2.5 flex items-baseline justify-between gap-3">
                  <p
                    className={`text-2xl font-bold ${live.next ? fg(live.next.window.status) : ""}`}
                  >
                    {now && live.next ? live.next.window.status : "—"}
                  </p>
                  <p className="text-base tabular-nums text-muted-foreground">
                    {now && live.next ? formatCountdown(live.next.startsIn) : ""}
                  </p>
                </div>
                <p className="mt-3 text-base tabular-nums text-muted-foreground">
                  {now && live.next
                    ? `${whenLabel(live.next.window)} — ${clock(live.next.window.to % 1440)}`
                    : "—"}
                </p>
              </div>
              <div className="bg-panel p-5">
                <p className="terminal-label">Next prime / swing window</p>
                <div className="mt-2.5 flex items-baseline justify-between gap-3">
                  <p className="text-2xl font-bold tabular-nums">
                    {now && live.nextPrime ? whenLabel(live.nextPrime.window) : "—"}
                  </p>
                  <p className="text-base tabular-nums text-muted-foreground">
                    {now && live.nextPrime ? `in ${formatCountdown(live.nextPrime.startsIn)}` : ""}
                  </p>
                </div>
                <p
                  className={`mt-3 text-base font-semibold ${live.nextPrime ? fg(live.nextPrime.window.status) : "text-muted-foreground"}`}
                >
                  {now && live.nextPrime
                    ? `${live.nextPrime.window.status} · until ${clock(live.nextPrime.window.to % 1440)}`
                    : "—"}
                </p>
              </div>
            </section>

            <section
              className="mt-4 border border-border bg-panel p-4 sm:p-5"
              aria-label={`${day} 24-hour timeline`}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="terminal-label">
                    24-hour rail · {regime === "summer" ? "US summer clock" : "US winter clock"}
                  </p>
                  <h2 className="mt-1 text-xl font-bold">
                    {instrumentLabel} / {day}
                  </h2>
                </div>
                {selectedDay && (
                  <button
                    type="button"
                    onClick={() => setSelectedDay(null)}
                    className="text-sm font-semibold uppercase text-muted-foreground hover:text-foreground"
                  >
                    Return to today
                  </button>
                )}
              </div>

              <div
                className="relative mt-8"
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
                      {hoverScore !== null && (
                        <span className="text-muted-foreground">· {hoverScore.toFixed(2)}×</span>
                      )}
                    </span>
                  </div>
                )}
                <div className="relative flex h-14 items-end gap-px" aria-hidden="true">
                  <div
                    className="pointer-events-none absolute inset-x-0 z-10 border-t border-dashed border-foreground/40"
                    style={{ bottom: profileHeight(1) }}
                  />
                  {schedule.profile.map((value, index) => {
                    const w = statusAt(index * 30);
                    return (
                      <div
                        key={index}
                        className={`flex-1 ${w ? bg(w.status) : ""} opacity-60`}
                        style={{
                          height: value === null ? 0 : profileHeight(value),
                        }}
                      />
                    );
                  })}
                </div>
                <div className="relative mt-1 h-11 cursor-crosshair overflow-hidden border border-border bg-background">
                  {sessions.map((slot, index) => (
                    <div
                      key={`${slot.start}-${slot.status}`}
                      className={`absolute inset-y-0 border-r border-background/70 ${bg(slot.status)} ${index === activeIndex ? "opacity-100" : "opacity-55"}`}
                      style={{
                        left: `${toMinutes(slot.start) / 14.4}%`,
                        width: `${(toMinutes(slot.end) - toMinutes(slot.start)) / 14.4}%`,
                      }}
                    />
                  ))}
                  {isLiveDay && (
                    <div
                      className="absolute inset-y-0 z-10 w-px bg-live-marker"
                      style={{ left: `${Math.min(100, ist.minutes / 14.4)}%` }}
                    >
                      <span className="absolute -left-1.5 top-1/2 size-3 -translate-y-1/2 rounded-full border-2 border-background bg-live-marker" />
                    </div>
                  )}
                </div>
                {hoverPercent !== null && (
                  <div
                    className="pointer-events-none absolute inset-y-0 z-20 w-px border-l border-dashed border-foreground/60"
                    style={{ left: `${hoverPercent}%` }}
                  />
                )}
              </div>
              <div className="relative mt-2 h-5">
                <div className="flex justify-between text-xs font-medium text-muted-foreground">
                  <span>00:00</span>
                  <span>06:00</span>
                  <span>12:00</span>
                  <span>18:00</span>
                  <span>24:00</span>
                </div>
                {hoverMinutes !== null && (
                  <span
                    className={`pointer-events-none absolute top-0 whitespace-nowrap bg-foreground px-1.5 py-0.5 text-xs font-bold tabular-nums text-background ${hoverShift}`}
                    style={{ left: `${hoverPercent}%` }}
                  >
                    {clock(hoverMinutes)}
                  </span>
                )}
              </div>

              <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2">
                {(Object.keys(statusClass) as Status[]).map((status) => (
                  <div key={status} className="flex items-center gap-2">
                    <span className={`size-2.5 rounded-full ${bg(status)}`} />
                    <span className="text-xs font-semibold text-muted-foreground">{status}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="mt-4 overflow-hidden border border-border bg-panel">
              <div className="grid grid-cols-[auto_1fr_auto] gap-3 border-b border-border px-4 py-3 text-xs font-bold uppercase tracking-wide text-muted-foreground sm:grid-cols-[170px_1fr_80px_90px_70px_80px]">
                <span>Window</span>
                <span>Status</span>
                <span className="hidden text-right sm:block">Score</span>
                <span className="hidden text-right sm:block">1h move</span>
                <span className="hidden text-right sm:block">Hit</span>
                <span className="text-right">Length</span>
              </div>
              {sessions.map((slot, index) => (
                <div
                  key={`${slot.start}-${slot.end}`}
                  className={`grid min-h-16 grid-cols-[auto_1fr_auto] items-center gap-3 border-b border-border/70 px-4 py-3.5 last:border-b-0 sm:grid-cols-[170px_1fr_80px_90px_70px_80px] ${index === activeIndex ? "bg-active-row" : ""}`}
                >
                  <span className="whitespace-nowrap text-sm tabular-nums sm:text-base">
                    {slot.start} — {slot.end}
                  </span>
                  <span className="flex items-center gap-2.5 whitespace-nowrap text-sm font-bold sm:text-base">
                    <span className={`size-2.5 shrink-0 rounded-full ${bg(slot.status)}`} />
                    <span className={index === activeIndex ? fg(slot.status) : ""}>
                      {slot.status}
                    </span>
                    {index === activeIndex && (
                      <span className="hidden border border-current px-1.5 py-0.5 text-xs font-bold uppercase sm:inline">
                        Live
                      </span>
                    )}
                  </span>
                  <span className="hidden text-right text-sm tabular-nums sm:block sm:text-base">
                    {slot.score === null ? "—" : `${fmt(slot.score)}×`}
                  </span>
                  <span className="hidden text-right text-sm tabular-nums text-muted-foreground sm:block sm:text-base">
                    {slot.movePct === null ? "—" : `${fmt(slot.movePct)}%`}
                  </span>
                  <span className="hidden text-right text-sm tabular-nums text-muted-foreground sm:block sm:text-base">
                    {pct(slot.consistency)}
                  </span>
                  <span className="text-right text-sm text-muted-foreground sm:text-base">
                    {durationLabel(slot.start, slot.end)}
                  </span>
                </div>
              ))}
            </section>
            <footer className="mt-5 border-t border-border pt-4 text-sm text-muted-foreground">
              Research data through {RESEARCH_META.dataThrough} · generated{" "}
              {RESEARCH_META.generated}
            </footer>
          </>
        )}
      </div>
    </main>
  );
}

function ForexHours({
  now,
  dateKey,
  isLiveDay,
  day,
  selectedDay,
  onReturnToToday,
}: {
  now: Date | null;
  dateKey: string;
  isLiveDay: boolean;
  day: Day;
  selectedDay: boolean;
  onReturnToToday: () => void;
}) {
  const sessions = useMemo(() => forexSessionsForIstDate(dateKey), [dateKey]);
  const marketOpen = now !== null && isForexMarketOpen(now);
  const active = now && marketOpen ? activeForexSessions(now) : [];
  const activeIds = new Set(active.map((session) => session.id));
  const minutesFromIstMidnight = (date: Date) => getIstParts(date).minutes;
  const range = (start: Date, end: Date) =>
    `${clock(minutesFromIstMidnight(start))} — ${clock(minutesFromIstMidnight(end))}`;
  const sessionSegments = (id: string) => sessions.filter((segment) => segment.session.id === id);
  const london = sessionSegments("london")[0];
  const newYork = sessionSegments("new-york")[0];
  const overlap =
    london && newYork
      ? {
          start: new Date(Math.max(london.start.getTime(), newYork.start.getTime())),
          end: new Date(Math.min(london.end.getTime(), newYork.end.getTime())),
        }
      : null;
  const hasOverlap = overlap && overlap.end > overlap.start;

  return (
    <>
      <section
        className="mt-4 grid gap-px border border-border bg-border md:grid-cols-3"
        aria-label="Forex market guidance"
      >
        <div className="bg-panel p-5">
          <p className="terminal-label">Forex market · New York clock</p>
          <div className="mt-2.5 flex items-center gap-2.5">
            <span
              className={`size-3 rounded-full ${marketOpen ? "bg-status-prime" : "bg-status-closed"}`}
            />
            <p
              className={`text-2xl font-bold ${marketOpen ? "text-status-prime" : "text-status-closed"}`}
            >
              {now ? (marketOpen ? "OPEN" : "CLOSED") : "—"}
            </p>
          </div>
          <p className="mt-3 text-base text-muted-foreground">Sun 17:00 — Fri 17:00 ET</p>
        </div>
        <div className="bg-panel p-5">
          <p className="terminal-label">Main sessions open</p>
          <p className="mt-2.5 text-2xl font-bold">
            {now
              ? active.length
                ? active.map((session) => session.name).join(" + ")
                : "None"
              : "—"}
          </p>
          <p className="mt-3 text-base text-muted-foreground">
            {marketOpen ? "City sessions use local business hours" : "Weekend market closure"}
          </p>
        </div>
        <div className="bg-panel p-5">
          <p className="terminal-label">Highest-volume overlap</p>
          <p className="mt-2.5 text-2xl font-bold">London + New York</p>
          <p className="mt-3 text-base tabular-nums text-muted-foreground">
            {hasOverlap
              ? `${range(overlap.start, overlap.end)} IST${isLiveDay ? " today" : ""}`
              : "Shown on the next weekday"}
          </p>
        </div>
      </section>

      <section
        className="mt-4 border border-border bg-panel p-4 sm:p-5"
        aria-label={`${day} forex sessions`}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="terminal-label">24-hour rail · IST</p>
            <h2 className="mt-1 text-xl font-bold">Forex market sessions / {day}</h2>
          </div>
          {selectedDay && (
            <button
              type="button"
              onClick={onReturnToToday}
              className="text-sm font-semibold uppercase text-muted-foreground hover:text-foreground"
            >
              Return to today
            </button>
          )}
        </div>

        <div className="mt-7 space-y-3">
          {FOREX_SESSIONS.map((session) => {
            const segments = sessionSegments(session.id);
            const isActive = isLiveDay && activeIds.has(session.id);
            return (
              <div
                key={session.id}
                className="grid grid-cols-[70px_1fr] items-center gap-3 sm:grid-cols-[130px_1fr]"
              >
                <div>
                  <p className="text-sm font-bold">{session.name}</p>
                  <p className="text-xs text-muted-foreground">{session.localHours}</p>
                </div>
                <div className="relative h-10 overflow-hidden border border-border bg-background">
                  {segments.map((segment) => {
                    const start = minutesFromIstMidnight(segment.start);
                    const end = minutesFromIstMidnight(segment.end);
                    return (
                      <div
                        key={`${session.id}-${segment.start.toISOString()}`}
                        className={`absolute inset-y-0 ${session.color} ${isActive ? "opacity-100" : "opacity-65"}`}
                        style={{ left: `${start / 14.4}%`, width: `${(end - start) / 14.4}%` }}
                        title={`${session.name}: ${range(segment.start, segment.end)} IST`}
                      />
                    );
                  })}
                  {isLiveDay && now && (
                    <div
                      className="pointer-events-none absolute inset-y-0 z-10 w-px bg-live-marker"
                      style={{ left: `${Math.min(100, minutesFromIstMidnight(now) / 14.4)}%` }}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="ml-[82px] mt-2 flex justify-between text-xs font-medium text-muted-foreground sm:ml-[142px]">
          <span>00:00</span>
          <span>06:00</span>
          <span>12:00</span>
          <span>18:00</span>
          <span>24:00</span>
        </div>
      </section>

      <section className="mt-4 overflow-hidden border border-border bg-panel">
        <div className="grid grid-cols-[1fr_auto_auto] gap-3 border-b border-border px-4 py-3 text-xs font-bold uppercase tracking-wide text-muted-foreground sm:grid-cols-[160px_1fr_150px_90px]">
          <span>Session</span>
          <span>IST hours</span>
          <span className="hidden sm:block">Local hours</span>
          <span className="text-right">Status</span>
        </div>
        {FOREX_SESSIONS.map((session) => {
          const segments = sessionSegments(session.id);
          const isActive = isLiveDay && activeIds.has(session.id);
          return (
            <div
              key={session.id}
              className="grid min-h-16 grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-border/70 px-4 py-3.5 last:border-b-0 sm:grid-cols-[160px_1fr_150px_90px]"
            >
              <span className="text-sm font-bold sm:text-base">{session.name}</span>
              <span className="text-right text-sm tabular-nums sm:text-left sm:text-base">
                {segments.length
                  ? segments.map((segment) => range(segment.start, segment.end)).join(" · ")
                  : "Market closed"}
              </span>
              <span className="hidden text-sm text-muted-foreground sm:block">
                {session.localHours}
              </span>
              <span
                className={`text-right text-sm font-bold ${isActive ? "text-status-prime" : "text-muted-foreground"}`}
              >
                {isActive ? "OPEN" : "CLOSED"}
              </span>
            </div>
          );
        })}
      </section>

      <footer className="mt-5 border-t border-border pt-4 text-sm text-muted-foreground">
        Session definitions:{" "}
        <a href={FOREX_SOURCE_URL} className="underline hover:text-foreground">
          BabyPips Forex Market Hours
        </a>{" "}
        · local session clocks and DST are converted to IST automatically.
      </footer>
    </>
  );
}
