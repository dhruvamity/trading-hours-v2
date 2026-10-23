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
  forexScheduleForIstDate,
  forexSessionsForIstDate,
  forexWeekTimeline,
  isForexMarketOpen,
  istDateKey,
  locateForex,
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
const durationLabel = (start: string, end: string) => {
  const minutes = toMinutes(end) - toMinutes(start);
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};
const formatWhenLabel = (w: { day: Day; from: number }, currentDay?: Day) =>
  `${w.day === currentDay ? "Today" : w.day.slice(0, 3)} ${clock(w.from % 1440)}`;

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
                to="/grade"
                className="text-sm font-semibold text-muted-foreground hover:text-foreground"
              >
                Market grade →
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
  const [hoverPercent, setHoverPercent] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<"windows" | "sessions">("windows");

  const schedule = useMemo(() => forexScheduleForIstDate(dateKey), [dateKey]);
  const sessions = useMemo(() => forexSessionsForIstDate(dateKey), [dateKey]);
  const marketOpen = now !== null && isForexMarketOpen(now);
  const active = now && marketOpen ? activeForexSessions(now) : [];
  const activeIds = new Set(active.map((session) => session.id));

  const ist = useMemo(() => (now ? getIstParts(now) : null), [now]);
  const liveMinutes = ist ? ist.minutes : 0;
  const weekMinute = ist ? DAYS.indexOf(ist.day) * 1440 + ist.minutes : 0;

  const forexTimeline = useMemo(() => (now ? forexWeekTimeline(now) : []), [now]);
  const live = useMemo(
    () => (now && forexTimeline.length > 0 ? locateForex(forexTimeline, weekMinute) : null),
    [forexTimeline, weekMinute, now],
  );

  const minutesFromIstMidnight = (date: Date) => getIstParts(date).minutes;
  const range = (start: Date, end: Date) =>
    `${clock(minutesFromIstMidnight(start))} — ${clock(minutesFromIstMidnight(end))}`;

  const sessionSegments = (id: string) => sessions.filter((segment) => segment.session.id === id);

  const activeWindowIndex =
    isLiveDay && now
      ? schedule.windows.findIndex(
          (slot) => liveMinutes >= toMinutes(slot.start) && liveMinutes < toMinutes(slot.end),
        )
      : -1;

  const handleRailMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setHoverPercent(Math.min(99.99, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100)));
  };

  const hoverMinutes = hoverPercent !== null ? hoverPercent * 14.4 : null;
  const hoverWindow =
    hoverMinutes !== null
      ? schedule.windows.find(
          (slot) => hoverMinutes >= toMinutes(slot.start) && hoverMinutes < toMinutes(slot.end),
        )
      : undefined;
  const hoverScore =
    hoverMinutes !== null
      ? (schedule.profile[Math.min(47, Math.max(0, Math.floor(hoverMinutes / 30)))] ?? null)
      : null;
  const hoverShift =
    hoverPercent !== null
      ? hoverPercent < 15
        ? "translate-x-0"
        : hoverPercent > 85
          ? "-translate-x-full"
          : "-translate-x-1/2"
      : "";

  return (
    <>
      <section
        className="mt-4 grid gap-px border border-border bg-border md:grid-cols-3"
        aria-label="Forex market guidance"
      >
        <div className="bg-panel p-5">
          <div className="flex items-center justify-between">
            <p className="terminal-label">Now · Forex market</p>
            <span
              className={`text-xs font-semibold uppercase tracking-wider ${
                marketOpen ? "text-status-prime" : "text-muted-foreground"
              }`}
            >
              {marketOpen ? "● Open" : "○ Closed"}
            </span>
          </div>
          <div className="mt-2.5 flex items-center gap-2.5">
            <span
              className={`size-3 rounded-full ${bg(live?.current?.status ?? (marketOpen ? "SWING ENTRY" : "CLOSED"))}`}
            />
            <p
              className={`text-2xl font-bold ${fg(live?.current?.status ?? (marketOpen ? "SWING ENTRY" : "CLOSED"))}`}
            >
              {now ? (live?.current?.status ?? (marketOpen ? "OPEN" : "CLOSED")) : "—"}
            </p>
          </div>
          <p className="mt-3 text-base tabular-nums text-muted-foreground">
            {now && live?.current
              ? `until ${clock(live.current.to % 1440)} · ${formatCountdown(live.endsIn)}`
              : "Sun 17:00 — Fri 17:00 ET"}
          </p>
        </div>

        <div className="bg-panel p-5">
          <div className="flex items-center justify-between">
            <p className="terminal-label">Next session change</p>
            {active.length > 0 && (
              <span className="text-[11px] font-medium text-muted-foreground truncate max-w-[150px]">
                {active.map((s) => s.name).join(" + ")}
              </span>
            )}
          </div>
          <div className="mt-2.5 flex items-baseline justify-between gap-3">
            <p className={`text-2xl font-bold ${live?.next ? fg(live.next.window.status) : ""}`}>
              {now && live?.next ? live.next.window.status : "—"}
            </p>
            <p className="text-base tabular-nums text-muted-foreground">
              {now && live?.next ? formatCountdown(live.next.startsIn) : ""}
            </p>
          </div>
          <p className="mt-3 text-base tabular-nums text-muted-foreground">
            {now && live?.next
              ? `${formatWhenLabel(live.next.window, ist?.day)} — ${clock(live.next.window.to % 1440)}`
              : "—"}
          </p>
        </div>

        <div className="bg-panel p-5">
          <p className="terminal-label">Highest-volume overlap · London + NY</p>
          <div className="mt-2.5 flex items-baseline justify-between gap-3">
            <p className="text-2xl font-bold tabular-nums">
              {now && live?.nextPrime
                ? formatWhenLabel(live.nextPrime.window, ist?.day)
                : "London + NY"}
            </p>
            <p className="text-base tabular-nums text-muted-foreground">
              {now && live?.nextPrime ? `in ${formatCountdown(live.nextPrime.startsIn)}` : ""}
            </p>
          </div>
          <p
            className={`mt-3 text-base font-semibold ${
              live?.nextPrime ? fg(live.nextPrime.window.status) : "text-muted-foreground"
            }`}
          >
            {now && live?.nextPrime
              ? `${live.nextPrime.window.status} · until ${clock(live.nextPrime.window.to % 1440)}`
              : "17:30 — 21:30 IST"}
          </p>
        </div>
      </section>

      <section
        className="mt-4 border border-border bg-panel p-4 sm:p-5"
        aria-label={`${day} forex sessions timeline`}
      >
        <div className="flex items-center justify-between gap-3">
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

        <div className="relative mt-8">
          <div className="grid grid-cols-[80px_1fr] sm:grid-cols-[170px_1fr] gap-x-3 sm:gap-x-4">
            {/* Left Column: Row Labels and Converted IST Hours */}
            <div className="flex flex-col select-none">
              {/* Profile Bar Label */}
              <div className="h-14 flex flex-col justify-end pb-1 pr-1 text-right sm:text-left">
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  Liquidity
                </span>
                <span className="text-[10px] text-muted-foreground/60 hidden sm:block">
                  Relative volume
                </span>
              </div>

              {/* Market Rail Label */}
              <div className="mt-2 h-9 flex flex-col justify-center pr-1 text-right sm:text-left">
                <span className="text-xs font-bold uppercase tracking-wider text-foreground">
                  Market Rail
                </span>
                <span className="text-[10px] text-muted-foreground hidden sm:block">
                  Composite regime
                </span>
              </div>

              {/* Session Group Header */}
              <div className="mt-3 pt-2 border-t border-border/30 pr-1 text-right sm:text-left">
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/70">
                  Sessions (IST)
                </span>
              </div>

              {/* 4 City Session Labels */}
              <div className="mt-1.5 space-y-1.5">
                {FOREX_SESSIONS.map((session) => {
                  const segments = sessionSegments(session.id);
                  const isLiveActive = isLiveDay && activeIds.has(session.id);
                  const istHoursText = segments.length
                    ? segments.map((seg) => range(seg.start, seg.end)).join(", ")
                    : "Closed";

                  return (
                    <div
                      key={session.id}
                      className="h-6 flex items-center justify-end sm:justify-between pr-1 text-right sm:text-left"
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span
                          className={`size-1.5 shrink-0 rounded-full ${
                            isLiveActive ? "bg-emerald-400 animate-pulse" : "bg-muted-foreground/30"
                          }`}
                        />
                        <span
                          className={`text-xs font-semibold tracking-wide truncate ${
                            isLiveActive ? "text-foreground font-bold" : "text-muted-foreground"
                          }`}
                        >
                          {session.name}
                        </span>
                      </div>
                      <span className="text-[10px] tabular-nums text-muted-foreground/70 hidden sm:inline ml-1 shrink-0">
                        {istHoursText}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Time Axis IST Label */}
              <div className="mt-2 h-5 flex items-center pr-1 text-right sm:text-left">
                <span className="text-[10px] font-semibold text-muted-foreground/60">IST</span>
              </div>
            </div>

            {/* Right Column: Timeline Tracks with Interactive Hover */}
            <div
              className="relative cursor-crosshair select-none"
              onMouseMove={handleRailMove}
              onMouseLeave={() => setHoverPercent(null)}
            >
              {/* Floating Hover Window Pill */}
              {hoverPercent !== null && hoverWindow && (
                <div
                  className="pointer-events-none absolute -top-8 z-30"
                  style={{ left: `${hoverPercent}%` }}
                >
                  <span
                    className={`absolute flex items-center gap-2 whitespace-nowrap border border-border bg-panel px-2.5 py-1.5 text-xs font-bold uppercase shadow-lg ${hoverShift}`}
                  >
                    <span className={`size-2 rounded-full ${bg(hoverWindow.status)}`} />
                    <span className={fg(hoverWindow.status)}>{hoverWindow.status}</span>
                    <span className="text-foreground">· {hoverWindow.label}</span>
                    {hoverScore !== null && (
                      <span className="text-muted-foreground">· {hoverScore.toFixed(2)}×</span>
                    )}
                  </span>
                </div>
              )}

              {/* Full-Height Vertical Hover Crosshair Line */}
              {hoverPercent !== null && (
                <div
                  className="pointer-events-none absolute inset-y-0 z-20 w-px border-l border-dashed border-foreground/60"
                  style={{ left: `${hoverPercent}%` }}
                />
              )}

              {/* Volatility Profile Bars (h-14) */}
              <div className="relative flex h-14 items-end gap-px" aria-hidden="true">
                <div
                  className="pointer-events-none absolute inset-x-0 z-10 border-t border-dashed border-foreground/40"
                  style={{ bottom: profileHeight(1) }}
                />
                {schedule.profile.map((value, index) => {
                  const status = schedule.profileStatuses[index] ?? "CLOSED";
                  return (
                    <div
                      key={index}
                      className={`flex-1 ${bg(status)} opacity-60`}
                      style={{
                        height: value === null ? 0 : profileHeight(value),
                      }}
                    />
                  );
                })}
              </div>

              {/* 24-Hour Composite Rail (h-9) */}
              <div className="relative mt-2 h-9 overflow-hidden border border-border bg-background">
                {schedule.windows.map((slot, index) => (
                  <div
                    key={`${slot.start}-${slot.end}-${slot.status}`}
                    className={`absolute inset-y-0 border-r border-background/70 ${bg(slot.status)} ${
                      index === activeWindowIndex ? "opacity-100" : "opacity-55"
                    }`}
                    style={{
                      left: `${toMinutes(slot.start) / 14.4}%`,
                      width: `${(toMinutes(slot.end) - toMinutes(slot.start)) / 14.4}%`,
                    }}
                    title={`${slot.label} (${slot.start} — ${slot.end})`}
                  />
                ))}
                {isLiveDay && now && (
                  <div
                    className="absolute inset-y-0 z-10 w-px bg-live-marker"
                    style={{ left: `${Math.min(100, liveMinutes / 14.4)}%` }}
                  >
                    <span className="absolute -left-1.5 top-1/2 size-3 -translate-y-1/2 rounded-full border-2 border-background bg-live-marker" />
                  </div>
                )}
              </div>

              {/* Session Divider Alignment Line */}
              <div className="mt-3 pt-2 border-t border-border/30" />

              {/* 4 City Session Tracks (h-6 each) */}
              <div className="mt-1.5 space-y-1.5">
                {FOREX_SESSIONS.map((session) => {
                  const segments = sessionSegments(session.id);
                  const isLiveActive = isLiveDay && activeIds.has(session.id);
                  const isHoverActive =
                    hoverMinutes !== null &&
                    segments.some((seg) => {
                      const s = minutesFromIstMidnight(seg.start);
                      const e = minutesFromIstMidnight(seg.end);
                      return hoverMinutes >= s && hoverMinutes < e;
                    });

                  return (
                    <div
                      key={session.id}
                      className="relative h-6 overflow-hidden border border-border/40 bg-background/50 rounded-xs"
                    >
                      {segments.map((segment) => {
                        const start = minutesFromIstMidnight(segment.start);
                        const end = minutesFromIstMidnight(segment.end);
                        return (
                          <div
                            key={`${session.id}-${segment.start.toISOString()}`}
                            className={`absolute inset-y-0 border-x border-foreground/20 transition-all ${
                              isHoverActive
                                ? "bg-foreground/35 ring-1 ring-foreground/50 z-10"
                                : isLiveActive
                                  ? "bg-foreground/20 border-foreground/40"
                                  : "bg-foreground/10 hover:bg-foreground/20"
                            }`}
                            style={{
                              left: `${start / 14.4}%`,
                              width: `${(end - start) / 14.4}%`,
                            }}
                            title={`${session.name} (${session.code}): ${range(segment.start, segment.end)} IST · Local ${session.localHours}`}
                          />
                        );
                      })}
                      {isLiveDay && now && (
                        <div
                          className="pointer-events-none absolute inset-y-0 z-10 w-px bg-live-marker/70"
                          style={{ left: `${Math.min(100, liveMinutes / 14.4)}%` }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Time Axis (h-5) */}
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
            </div>
          </div>
        </div>

        {/* Status Legend */}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-y-2 border-t border-border/50 pt-4">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            {(Object.keys(statusClass) as Status[]).map((status) => (
              <div key={status} className="flex items-center gap-2">
                <span className={`size-2.5 rounded-full ${bg(status)}`} />
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  {status}
                </span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-block h-2.5 w-5 rounded-xs border border-foreground/30 bg-foreground/15" />
            <span>Session track (operating hours converted to IST)</span>
          </div>
        </div>
      </section>

      <section className="mt-4 border border-border bg-panel" aria-label="Forex timetable details">
        <div className="flex border-b border-border">
          <button
            type="button"
            onClick={() => setViewMode("windows")}
            className={`min-h-11 px-4 text-xs font-bold uppercase tracking-wider transition-colors ${
              viewMode === "windows"
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Market Windows ({schedule.windows.length})
          </button>
          <button
            type="button"
            onClick={() => setViewMode("sessions")}
            className={`min-h-11 px-4 text-xs font-bold uppercase tracking-wider transition-colors ${
              viewMode === "sessions"
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            City Sessions ({FOREX_SESSIONS.length})
          </button>
        </div>

        {viewMode === "windows" ? (
          <>
            <div className="grid grid-cols-[100px_1fr_auto] items-center gap-3 border-b border-border px-4 py-3 text-xs font-bold uppercase tracking-wider text-muted-foreground sm:grid-cols-[140px_130px_1fr_80px]">
              <span>Window</span>
              <span>Status</span>
              <span className="hidden sm:block">Description</span>
              <span className="text-right">Length</span>
            </div>
            {schedule.windows.map((slot, index) => {
              const isActive = index === activeWindowIndex;
              return (
                <div
                  key={`${slot.start}-${slot.end}-${slot.status}`}
                  className={`grid min-h-14 grid-cols-[100px_1fr_auto] items-center gap-3 border-b border-border/70 px-4 py-3 last:border-b-0 sm:grid-cols-[140px_130px_1fr_80px] ${
                    isActive ? "bg-active-row" : ""
                  }`}
                >
                  <span className="text-sm font-semibold tabular-nums sm:text-base">
                    {slot.start} — {slot.end}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className={`size-2.5 shrink-0 rounded-full ${bg(slot.status)}`} />
                    <span className={`text-xs font-bold uppercase sm:text-sm ${fg(slot.status)}`}>
                      {slot.status}
                    </span>
                  </span>
                  <span className="hidden text-sm text-muted-foreground sm:block">
                    {slot.score !== null ? (
                      <span className="font-semibold text-foreground mr-1.5">
                        {slot.score.toFixed(2)}×
                      </span>
                    ) : null}
                    {slot.label}
                  </span>
                  <span className="text-right text-sm tabular-nums text-muted-foreground">
                    {durationLabel(slot.start, slot.end)}
                  </span>
                </div>
              );
            })}
          </>
        ) : (
          <>
            <div className="grid grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-border px-4 py-3 text-xs font-bold uppercase tracking-wider text-muted-foreground sm:grid-cols-[160px_1fr_150px_90px]">
              <span>City Session</span>
              <span className="text-right sm:text-left">IST Hours</span>
              <span className="hidden sm:block">Local Hours</span>
              <span className="text-right">Status</span>
            </div>
            {FOREX_SESSIONS.map((session) => {
              const segments = sessionSegments(session.id);
              const isActive = isLiveDay && activeIds.has(session.id);
              return (
                <div
                  key={session.id}
                  className={`grid min-h-16 grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-border/70 px-4 py-3.5 last:border-b-0 sm:grid-cols-[160px_1fr_150px_90px] ${
                    isActive ? "bg-active-row" : ""
                  }`}
                >
                  <span className="flex items-center gap-2 text-sm font-bold sm:text-base">
                    <span
                      className={`size-2 shrink-0 rounded-full ${
                        isActive ? "bg-emerald-400" : "bg-muted-foreground/30"
                      }`}
                    />
                    <span>{session.name}</span>
                    <span className="text-xs text-muted-foreground font-normal">
                      ({session.code})
                    </span>
                    {isActive && (
                      <span className="hidden border border-status-prime px-1.5 py-0.5 text-xs font-bold uppercase text-status-prime sm:inline">
                        Live
                      </span>
                    )}
                  </span>
                  <span className="text-right text-sm tabular-nums sm:text-left sm:text-base">
                    {segments.length
                      ? segments.map((segment) => range(segment.start, segment.end)).join(" · ")
                      : "Market closed"}
                  </span>
                  <span className="hidden text-sm text-muted-foreground sm:block">
                    {session.localHours} local
                  </span>
                  <span
                    className={`text-right text-sm font-bold ${
                      isActive ? "text-status-prime" : "text-muted-foreground"
                    }`}
                  >
                    {isActive ? "OPEN" : "CLOSED"}
                  </span>
                </div>
              );
            })}
          </>
        )}
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
