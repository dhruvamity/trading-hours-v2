import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { marketOpen, readFilter } from "@/lib/day-filter";
import {
  CHOP_A,
  CHOP_APLUS,
  DAY_FILTER_STOP,
  EVENING,
  EVIDENCE,
  QUIET_BELOW,
  chop15,
  gradeOf,
  newsHit,
  quietMode,
  type Grade,
} from "@/lib/compiled-filter";
import { buildBlocks } from "@/lib/news-feed";
import { useGoldBars } from "@/lib/use-gold-bars";
import { useGoldHours } from "@/lib/use-gold-hours";
import { useNews } from "@/lib/use-news";

export const Route = createFileRoute("/grade")({
  head: () => ({
    meta: [
      { title: "Market Grade — IST Session Terminal" },
      {
        name: "description",
        content:
          "One live grade for gold: hours, choppiness, news, day filter and quiet mode.",
      },
    ],
  }),
  component: GradePage,
});

const look: Record<Grade, { text: string; edge: string; fill: string }> = {
  "A+": {
    text: "text-status-prime",
    edge: "border-status-prime/50",
    fill: "bg-status-prime",
  },
  A: {
    text: "text-status-prime",
    edge: "border-status-prime/50",
    fill: "bg-status-prime",
  },
  B: {
    text: "text-status-small",
    edge: "border-status-small/50",
    fill: "bg-status-small",
  },
  "NO TRADE": {
    text: "text-status-stop",
    edge: "border-status-stop/60",
    fill: "bg-status-stop",
  },
};

const istClock = (ms: number, seconds = false) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" as const } : {}),
    hourCycle: "h23",
  }).format(new Date(ms));
const istDay = (ms: number) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
  }).format(new Date(ms));
const dash = "—";
const signedNum = (v: number, unit: string) =>
  unit === "$"
    ? `${v > 0 ? "+" : v < 0 ? "−" : ""}$${Math.abs(v).toFixed(1)}`
    : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}R`;

function Check({
  label,
  value,
  ok,
  note,
}: {
  label: string;
  value: string;
  ok: boolean | null;
  note: string;
}) {
  const tone = ok === null ? "" : ok ? "text-status-prime" : "text-status-stop";
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className={`text-xl font-bold tabular-nums ${tone}`}>
          {value}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

function GradePage() {
  const [now, setNow] = useState<number | null>(null);
  const gold = useGoldBars();
  const hours = useGoldHours();
  const feed = useNews();

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // recompute when candles arrive or the minute turns, not every second
  const minute = now === null ? null : Math.floor(now / 60_000);
  const read = useMemo(() => {
    if (minute === null || gold.bars.length === 0) return null;
    const t = Date.now();
    const chop = chop15(gold.bars, t);
    const quiet = hours.bars.length ? quietMode(hours.bars, t) : null;
    const dayFilter =
      readFilter(gold.bars, t, DAY_FILTER_STOP)?.now?.verdict ?? null;
    const news = newsHit(feed.events, t);
    return {
      chop,
      quiet,
      dayFilter,
      news,
      g: gradeOf({
        now: t,
        chop,
        news,
        dayFilter,
        quiet: quiet?.quiet ?? null,
      }),
    };
  }, [gold.bars, hours.bars, feed.events, minute]);

  // today's IST day: shut hours, the evening window and the news windows, 00:00–24:00
  const day = useMemo(() => {
    if (minute === null) return null;
    const t = minute * 60_000;
    const start =
      t - ((((t + 330 * 60_000) % 86_400_000) + 86_400_000) % 86_400_000);
    const shut: [number, number][] = [];
    for (let s = 0; s < 288; s++) {
      const at = start + s * 300_000;
      if (marketOpen(at)) continue;
      const last = shut[shut.length - 1];
      if (last && last[1] === s) last[1] = s + 1;
      else shut.push([s, s + 1]);
    }
    const blocks = buildBlocks(feed.events, "GOLD").filter(
      (b) => b.to > start && b.from < start + 86_400_000,
    );
    return { start, shut, blocks, nowPct: ((t - start) / 86_400_000) * 100 };
  }, [feed.events, minute]);

  const g = read?.g ?? null;
  const pctOfDay = (ms: number) =>
    Math.min(100, Math.max(0, (ms / 86_400_000) * 100));

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-6 sm:py-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-2xl font-bold">Market grade · Gold</h1>
          <div className="flex items-center gap-5">
            <Link
              to="/"
              className="text-sm font-semibold text-muted-foreground hover:text-foreground"
            >
              ← Trading hours
            </Link>
            <Link
              to="/filter"
              className="text-sm font-semibold text-muted-foreground hover:text-foreground"
            >
              Day filter →
            </Link>
            <div className="text-right" aria-live="polite">
              <span className="text-2xl font-bold tabular-nums">
                {now ? istClock(now, true) : "--:--:--"}
              </span>
              <span className="ml-2 text-sm font-medium text-muted-foreground">
                IST · {now ? istDay(now) : ""}
              </span>
            </div>
          </div>
        </header>

        {!read || !g ? (
          <section
            className="mt-6 border border-border bg-panel p-5 sm:p-7"
            aria-live="polite"
          >
            <p className="text-lg text-muted-foreground">
              {gold.status === "error"
                ? "Live gold candles could not be loaded from Binance. Retrying every 30 seconds."
                : "Loading gold candles…"}
            </p>
          </section>
        ) : (
          <>
            <section
              className={`mt-6 border bg-panel p-5 sm:p-7 ${look[g.grade].edge}`}
              aria-label="Market grade"
            >
              <p className="text-base font-bold uppercase tracking-wide">
                Right now
              </p>
              <div className="mt-2 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <p
                  className={`text-6xl font-bold leading-none sm:text-7xl ${look[g.grade].text}`}
                >
                  {g.grade}
                </p>
                <div className="shrink-0 tabular-nums sm:text-right">
                  <p className="text-3xl font-bold">
                    {g.size === 0
                      ? "No entries"
                      : g.size === 1
                        ? "Full size"
                        : "Half size"}
                    {g.target && (
                      <span className="ml-2 text-lg font-semibold text-muted-foreground">
                        1:{g.target}
                      </span>
                    )}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {g.grade === "B"
                      ? "Only your best setups"
                      : g.size
                        ? "Stop beyond the sweep, $6–12"
                        : "Wait for the next A"}
                  </p>
                </div>
              </div>
              <p className="mt-3 text-lg">{g.reason}</p>

              <div className="mt-6 grid gap-5 border-t border-border pt-5 sm:grid-cols-3">
                <Check
                  label="Evening window"
                  value={g.inWindow ? "Inside" : "Outside"}
                  ok={g.inWindow}
                  note={`17:00–22:30 IST`}
                />
                <Check
                  label="15m choppiness"
                  value={read.chop === null ? dash : read.chop.toFixed(0)}
                  ok={read.chop === null ? null : read.chop < CHOP_A}
                  note={`under ${CHOP_A}: calm · under ${CHOP_APLUS}: A+`}
                />
                <Check
                  label="Quiet mode"
                  value={
                    read.quiet?.quiet == null
                      ? dash
                      : read.quiet.quiet
                        ? "On"
                        : "Off"
                  }
                  ok={null}
                  note={
                    read.quiet?.ratio != null
                      ? `2-session range ${read.quiet.ratio.toFixed(2)}× normal · on under ${QUIET_BELOW}`
                      : hours.status === "error"
                        ? "hourly candles unavailable"
                        : "loading hourly candles"
                  }
                />
              </div>
              <div className="mt-5 grid gap-5 border-t border-border pt-5 sm:grid-cols-3">
                <Check
                  label="Market"
                  value={now && marketOpen(now) ? "Open" : "Shut"}
                  ok={now ? marketOpen(now) : null}
                  note="shut 17:00–18:00 New York and weekends"
                />
                <Check
                  label="US news"
                  value={
                    read.news
                      ? `until ${istClock(read.news.until)}`
                      : feed.ok
                        ? "Clear"
                        : dash
                  }
                  ok={feed.ok || read.news ? !read.news : null}
                  note={
                    read.news
                      ? read.news.name
                      : feed.ok
                        ? "no release window now"
                        : "news feed unavailable"
                  }
                />
                <Check
                  label="Day filter"
                  value={read.dayFilter ?? dash}
                  ok={
                    read.dayFilter === null
                      ? null
                      : read.dayFilter !== "NO TRADE"
                  }
                  note="only its NO TRADE is used, as a veto"
                />
              </div>
            </section>

            {day && (
              <section
                className="mt-6 border border-border bg-panel p-4 sm:p-5"
                aria-label="Today"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="terminal-label">Today · IST</p>
                  <p className="text-sm text-muted-foreground">
                    A or A+ is only possible inside the green window, outside
                    news and when calm
                  </p>
                </div>
                <div className="relative mt-4 h-10 bg-secondary">
                  {day.shut.map(([a, b]) => (
                    <div
                      key={a}
                      className="absolute inset-y-0 bg-status-closed/40"
                      style={{
                        left: `${(a / 288) * 100}%`,
                        width: `${((b - a) / 288) * 100}%`,
                      }}
                      title="Gold shut"
                    />
                  ))}
                  <div
                    className="absolute inset-y-0 bg-status-prime/70"
                    style={{
                      left: `${(EVENING.from / 1440) * 100}%`,
                      width: `${((EVENING.to - EVENING.from) / 1440) * 100}%`,
                    }}
                    title="17:00–22:30 IST"
                  />
                  {day.blocks.map((b) => (
                    <div
                      key={b.from}
                      className="absolute inset-y-0 bg-status-stop/80"
                      style={{
                        left: `${pctOfDay(b.from - day.start)}%`,
                        width: `${pctOfDay(b.to - day.start) - pctOfDay(b.from - day.start)}%`,
                      }}
                      title={`${b.names.join(", ")} · ${istClock(b.from)}–${istClock(b.to)} IST`}
                    />
                  ))}
                  <div
                    className="absolute -inset-y-1 z-10 w-0.5 bg-live-marker"
                    style={{ left: `${day.nowPct}%` }}
                  />
                </div>
                <div className="relative mt-2 h-5 text-xs font-medium text-muted-foreground">
                  {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
                    <span
                      key={h}
                      className="absolute tabular-nums"
                      style={{ left: `${(h / 24) * 100}%` }}
                    >
                      {String(h).padStart(2, "0")}:00
                    </span>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
                  {[
                    ["bg-status-prime", "Evening window"],
                    ["bg-status-stop", "News"],
                    ["bg-status-closed", "Shut"],
                  ].map(([c, l]) => (
                    <div key={l} className="flex items-center gap-2">
                      <span className={`size-2.5 rounded-full ${c}`} />
                      <span className="text-xs font-semibold text-muted-foreground">
                        {l}
                      </span>
                    </div>
                  ))}
                  {day.blocks
                    .filter((b) => b.to > (now ?? 0))
                    .slice(0, 3)
                    .map((b) => (
                      <span
                        key={b.from}
                        className="text-xs text-muted-foreground"
                      >
                        {b.event.name} {istClock(b.event.time)}
                      </span>
                    ))}
                </div>
              </section>
            )}

            <section
              className="mt-6 border border-border bg-panel p-4 sm:p-5"
              aria-label="The grades"
            >
              <p className="terminal-label">The grades</p>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[34rem] text-sm tabular-nums sm:text-base">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-3 font-semibold">Grade</th>
                      <th className="py-2 pr-3 font-semibold">When</th>
                      <th className="py-2 pr-3 text-right font-semibold">
                        Size
                      </th>
                      <th className="py-2 text-right font-semibold">Target</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      [
                        [
                          "A+",
                          "17:00–22:30 IST and choppiness under 50",
                          "Full",
                          "1:3 · quiet 1:2",
                        ],
                        [
                          "A",
                          "17:00–22:30 IST and choppiness under 55",
                          "Full",
                          "1:3 · quiet 1:2",
                        ],
                        ["B", "Only one of the two", "Half", "1:2"],
                        [
                          "NO TRADE",
                          "Neither, or shut, news, day filter NO TRADE",
                          "None",
                          dash,
                        ],
                      ] as [Grade, string, string, string][]
                    ).map(([gr, when, size, tgt]) => (
                      <tr key={gr} className="border-t border-border/70">
                        <td className={`py-2 pr-3 font-bold ${look[gr].text}`}>
                          {gr}
                        </td>
                        <td className="py-2 pr-3">{when}</td>
                        <td className="py-2 pr-3 text-right">{size}</td>
                        <td className="py-2 text-right">{tgt}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section
              className="mt-6 border border-border bg-panel p-4 sm:p-5"
              aria-label="How this was tested"
            >
              <p className="terminal-label">How this was tested</p>
              <ul className="mt-3 space-y-2 text-base">
                <li>
                  Three filters were run on the same trades: this site&apos;s
                  timetable and day filter, regime-bot&apos;s score and quiet
                  mode, and a live-tape read. A rule was kept only if it
                  improved every one of four groups: 351 own gold trades before
                  and after 21 Sep 2026, and 4,773 mechanical sweep-reversal
                  trades, Dec–Jun and Jul–Oct.
                </li>
                <li>
                  <span className="font-bold text-status-prime">Kept:</span> 15m
                  choppiness, the evening window, the news windows, the day
                  filter&apos;s NO TRADE as a veto, quiet mode for the target.
                </li>
                <li>
                  <span className="font-bold text-status-stop">Dropped:</span>{" "}
                  regime-bot&apos;s score pointed the wrong way for reversal
                  entries in all four groups.
                </li>
                <li>
                  A/A+ minus NO TRADE on own trades:{" "}
                  <span className="font-semibold tabular-nums">
                    +${EVIDENCE.diff.early[0].toFixed(1)}
                  </span>{" "}
                  a trade before 21 Sep (95% interval +${EVIDENCE.diff.early[1]}{" "}
                  to +$
                  {EVIDENCE.diff.early[2]}),{" "}
                  <span className="font-semibold tabular-nums">
                    +${EVIDENCE.diff.late[0].toFixed(1)}
                  </span>{" "}
                  after (+${EVIDENCE.diff.late[1]} to +${EVIDENCE.diff.late[2]}
                  ). NO TRADE trades lost −$
                  {Math.abs(EVIDENCE.totals.noTrade).toLocaleString(
                    "en-US",
                  )}{" "}
                  over {EVIDENCE.totals.noTradeN} trades at{" "}
                  {EVIDENCE.totals.noTradeWin}% winners.
                </li>
              </ul>

              <p className="mt-5 border-t border-border pt-4 text-base font-semibold">
                Average result per trade by grade
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[36rem] text-sm tabular-nums">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-3 font-semibold">Group</th>
                      {(["A+", "A", "B", "NO TRADE"] as Grade[]).map((gr) => (
                        <th
                          key={gr}
                          className={`py-2 pr-3 text-right font-semibold ${look[gr].text}`}
                        >
                          {gr}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {EVIDENCE.groups.map((row) => (
                      <tr key={row.id} className="border-t border-border/70">
                        <td className="py-2 pr-3 text-muted-foreground">
                          {row.label}
                        </td>
                        {(["A+", "A", "B", "NO TRADE"] as const).map((gr) => {
                          const [v, n] = row.cells[gr];
                          return (
                            <td key={gr} className="py-2 pr-3 text-right">
                              <span className="font-bold">
                                {signedNum(v, row.unit)}
                              </span>
                              <span className="ml-1 text-xs text-muted-foreground">
                                {n}
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="mt-5 border-t border-border pt-4 text-base font-semibold">
                Stop and target by grade · same entries, fixed exits
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[36rem] text-sm tabular-nums">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-3 font-semibold">Grade</th>
                      <th className="py-2 pr-3 font-semibold">Best bracket</th>
                      <th className="py-2 pr-3 text-right font-semibold">
                        Own entries, recent
                      </th>
                      <th className="py-2 text-right font-semibold">
                        Mechanical test
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {EVIDENCE.rr.map((row) => (
                      <tr key={row.grade} className="border-t border-border/70">
                        <td className="py-2 pr-3 font-bold">{row.grade}</td>
                        <td className="py-2 pr-3">{row.bracket}</td>
                        <td className="py-2 pr-3 text-right">{row.own}</td>
                        <td className="py-2 text-right">{row.mech}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                Limits. The edge is on own trades; on mechanical trades the
                order holds but is not significant, so the grade keeps you out
                of bad conditions rather than finding trades. The choppiness cut
                was chosen after seeing all four groups: trades from 21 Oct 2026
                on are the first clean test. Most own trades fall in a
                range-bound Sep–Oct 2026.
              </p>
            </section>
          </>
        )}

        <footer className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
          <span>Statistical read of conditions · not trading advice</span>
          <span className="sm:ml-auto">
            {gold.status === "error" && gold.bars.length > 0
              ? "Live feed down · "
              : ""}
            Binance XAUUSDT 5m + 1h
            {gold.fetchedAt
              ? ` · updated ${istClock(gold.fetchedAt, true)}`
              : ""}
          </span>
        </footer>
      </div>
    </main>
  );
}
