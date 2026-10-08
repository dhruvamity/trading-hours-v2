import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_STOP,
  STOPS,
  readFilter,
  tablesFor,
  type FilterVerdict,
  type FilterView,
  type Read,
  type VerdictRow,
} from "@/lib/day-filter";
import { DAY_FILTER } from "@/lib/day-filter.generated";
import { useGoldBars } from "@/lib/use-gold-bars";
import { useNews } from "@/lib/use-news";

export const Route = createFileRoute("/filter")({
  head: () => ({
    meta: [
      { title: "Day Filter — IST Session Terminal" },
      {
        name: "description",
        content: "Is gold moving enough for the plan today? Live movement read in stop-widths.",
      },
    ],
  }),
  component: Filter,
});

const STOP_KEY = "th-filter-stop-v1";
const BAR = 5 * 60_000;
const P = DAY_FILTER.params;
const RULES = DAY_FILTER.rules;

const look: Record<FilterVerdict, { word: string; text: string; edge: string; fill: string }> = {
  TRADE: {
    word: "TRADE",
    text: "text-status-prime",
    edge: "border-status-prime/50",
    fill: "bg-status-prime",
  },
  "TRADE (fast)": {
    word: "TRADE · FAST",
    text: "text-status-swing",
    edge: "border-status-swing/60",
    fill: "bg-status-swing",
  },
  "1:1 ONLY": {
    word: "1:1 ONLY",
    text: "text-status-small",
    edge: "border-status-small/50",
    fill: "bg-status-small",
  },
  "NO TRADE": {
    word: "NO TRADE",
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
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", weekday: "short" }).format(
    new Date(ms),
  );
const istDate = (ms: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(ms));

const usd = (v: number) => `$${Math.round(v)}`;
const signedUsd = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}$${Math.abs(Math.round(v))}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const signed = (v: number) => `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(2)}`;
const dash = "—";

/** The sentence under the verdict: what the number means for a stop of `stop` dollars. */
function explain(r: Read, stop: number): string {
  const size = `About ${usd(r.usd)} of range in 3 hours, ${r.r.toFixed(1)} stops.`;
  if (r.verdict === "NO TRADE")
    return `${size} Too little for a ${usd(stop)} stop: a 1R move came within the hour from only ${pct(r.reach1)} of entries.`;
  if (r.verdict === "1:1 ONLY")
    return `${size} 1R is usually there (${pct(r.reach1)} within the hour). 2R came within 3 hours only ${pct(r.reach2)} of the time. Bank 1R.`;
  if (r.verdict === "TRADE (fast)")
    return `${size} Plenty of room, but a ${usd(stop)} stop is inside the noise: both sides were hit within the hour ${pct(r.whip)} of the time. Widest stop, smaller size.`;
  return `${size} Enough for the 2R plan: a ${usd(2 * stop)} move came within 3 hours from ${pct(r.reach2)} of entries.`;
}

/** One line on what the session has been like. Describes, does not forecast. */
function describe(view: FilterView): string {
  const { today, norm } = view.soFar;
  if (!today || !norm.range || !norm.rv) return "";
  const range = today.range / norm.range;
  const activity = today.rv / norm.rv;
  if (range < 0.7 && activity >= 0.8)
    return "Choppy so far: bars are as busy as usual but price is stuck in a tight range.";
  if (range < 0.7) return "Quiet so far: small range and little activity.";
  if (norm.er !== null && today.er > 2 * norm.er && range >= 0.9)
    return "One-way so far: most of the movement went in one direction.";
  if (range > 1.4) return "Wide so far: a bigger range than usual by this hour.";
  return "Ordinary so far.";
}

function Meter({
  label,
  value,
  rule,
  ruleLabel,
  hit,
}: {
  label: string;
  value: number;
  rule: number;
  ruleLabel: string;
  hit: string;
}) {
  const reached = value >= rule;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className={`text-xl font-bold tabular-nums ${reached ? hit : ""}`}>{pct(value)}</span>
      </div>
      <div className="relative mt-1.5 h-1.5 bg-secondary">
        <div
          className={`absolute inset-y-0 left-0 ${reached ? hit.replace("text-", "bg-") : "bg-muted-foreground"}`}
          style={{ width: `${Math.min(100, value * 100)}%` }}
        />
        <div
          className="absolute -inset-y-1 w-0.5 bg-foreground"
          style={{ left: `${rule * 100}%` }}
        />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{ruleLabel}</p>
    </div>
  );
}

function BacktestTable({ rows, unit }: { rows: VerdictRow[]; unit: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] text-sm tabular-nums">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="py-2 pr-3 font-semibold">Signal</th>
            <th className="py-2 pr-3 text-right font-semibold">{unit}</th>
            <th className="py-2 pr-3 text-right font-semibold">Range after</th>
            <th className="py-2 pr-3 text-right font-semibold">1R in 1h</th>
            <th className="py-2 pr-3 text-right font-semibold">2R in 3h</th>
            <th className="py-2 pr-3 text-right font-semibold">Both stops in 1h</th>
            <th className="py-2 text-right font-semibold">2R trade still open at 3h</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.verdict} className="border-t border-border/70">
              <td className={`py-2 pr-3 font-bold ${look[row.verdict].text}`}>
                {look[row.verdict].word}
              </td>
              <td className="py-2 pr-3 text-right">{pct(row.share)}</td>
              <td className="py-2 pr-3 text-right">{row.range.toFixed(1)}R</td>
              <td className="py-2 pr-3 text-right">{pct(row.reach1)}</td>
              <td className="py-2 pr-3 text-right">{pct(row.reach2)}</td>
              <td className="py-2 pr-3 text-right">{pct(row.whip)}</td>
              <td className="py-2 text-right">{pct(row.open12)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Filter() {
  const [now, setNow] = useState<number | null>(null);
  const [stop, setStop] = useState<number>(DEFAULT_STOP);
  const [scope, setScope] = useState<"evening" | "all">("evening");
  const gold = useGoldBars();
  const feed = useNews();

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    try {
      const saved = Number(window.localStorage.getItem(STOP_KEY));
      if ((STOPS as readonly number[]).includes(saved)) setStop(saved);
    } catch {
      // private window: the default stop is fine
    }
    return () => window.clearInterval(timer);
  }, []);
  const chooseStop = (value: number) => {
    setStop(value);
    try {
      window.localStorage.setItem(STOP_KEY, String(value));
    } catch {
      // not saved, still applied for this visit
    }
  };

  // recompute when candles arrive or the minute turns, not every second
  const minute = now === null ? null : Math.floor(now / 60_000);
  const view = useMemo(
    () =>
      minute === null || gold.bars.length === 0 ? null : readFilter(gold.bars, Date.now(), stop),
    [gold.bars, minute, stop],
  );

  const eveFrom = view ? view.openAt + view.eveSlot * BAR : 0;
  const eveTo = eveFrom + 7 * 3_600_000;
  const beforeEvening = view !== null && (!view.marketOpen || view.slot <= view.eveSlot);
  const head = view ? (beforeEvening ? (view.tonight ?? view.now) : view.now) : null;
  const headIsTonight = head !== null && head === view?.tonight;
  const windowFrom = headIsTonight ? eveFrom : (now ?? 0);
  const windowTo = headIsTonight ? eveTo : (now ?? 0) + 3 * 3_600_000;
  const sameDay = now !== null && istDate(eveFrom) === istDate(now);
  const headLabel = headIsTonight
    ? `${sameDay ? "Tonight" : istDay(eveFrom)} · ${istClock(eveFrom)}–24:00 IST`
    : `Next 3 hours · until ${istClock(windowTo)} IST`;
  const release = feed.events
    .filter((e) => e.tier <= 2 && e.time >= windowFrom && e.time <= windowTo)
    .sort((a, b) => a.tier - b.tier || a.time - b.time)[0];

  const tables = view ? tablesFor(stop, view.price) : null;
  const closeAt = view ? view.openAt + P.slots * BAR : 0;
  const { today, yesterday, lastWeek, norm } = view?.soFar ?? {
    today: null,
    yesterday: null,
    lastWeek: null,
    norm: null,
  };
  const ratio = (v: number | null | undefined) =>
    v != null && norm?.rv ? `${(v / norm.rv).toFixed(2)}×` : dash;
  const rank = (v: number | null | undefined) => (v == null ? dash : `${Math.round(v)}%`);
  const num = (v: number | null | undefined, digits = 0) => (v == null ? dash : v.toFixed(digits));
  const money = (v: number | null | undefined) => (v == null ? dash : usd(v));
  const eff = (v: number | null | undefined) => (v == null ? dash : pct(v));

  const ev = DAY_FILTER.evidence;
  const skill = DAY_FILTER.skill;
  const noon = tables?.tonight.find((t) => t.ist === "12:00");

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-6 sm:py-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-4">
            <h1 className="text-2xl font-bold">Day filter · Gold</h1>
            <div
              className="inline-flex border border-border bg-panel p-1"
              role="group"
              aria-label="Stop size"
            >
              {STOPS.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => chooseStop(value)}
                  className={`px-3 py-1.5 text-sm font-bold transition-colors ${stop === value ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
                  aria-pressed={stop === value}
                >
                  ${value} stop
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-5">
            <Link
              to="/"
              className="text-sm font-semibold text-muted-foreground hover:text-foreground"
            >
              ← Signal
            </Link>
            <Link
              to="/journal"
              className="text-sm font-semibold text-muted-foreground hover:text-foreground"
            >
              Journal →
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

        {!view ? (
          <section className="mt-6 border border-border bg-panel p-5 sm:p-7" aria-live="polite">
            <p className="text-lg text-muted-foreground">
              {gold.status === "error"
                ? "Live gold candles could not be loaded from Binance. Retrying every 30 seconds."
                : "Loading a month of gold candles…"}
            </p>
          </section>
        ) : (
          <>
            <section
              className={`mt-6 border bg-panel p-5 sm:p-7 ${head ? look[head.verdict].edge : "border-border"}`}
              aria-label="Movement signal"
            >
              <p className="text-base font-bold uppercase tracking-wide">
                {head ? headLabel : "No forecast"}
              </p>
              {head ? (
                <>
                  <div className="mt-2 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                    <p
                      className={`text-6xl font-bold leading-none sm:text-7xl ${look[head.verdict].text}`}
                    >
                      {look[head.verdict].word}
                    </p>
                    <div className="shrink-0 tabular-nums sm:text-right">
                      <p className="text-3xl font-bold">
                        {usd(head.usd)}
                        <span className="ml-2 text-lg font-semibold text-muted-foreground">
                          {head.r.toFixed(1)}R / 3h
                        </span>
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {headIsTonight ? "Usual evening" : "Usual for this time"}:{" "}
                        {usd((head.normPct / 100) * view.price)} · activity{" "}
                        {Math.exp(head.q).toFixed(2)}× normal
                      </p>
                    </div>
                  </div>
                  <p className="mt-3 text-lg">{explain(head, stop)}</p>
                  {release && (
                    <p className="mt-1 text-base font-semibold text-status-small">
                      {release.name} at {istClock(release.time)} IST is inside this window. The
                      forecast does not see releases: the news gate decides around it.
                    </p>
                  )}
                  <div className="mt-6 grid gap-5 border-t border-border pt-5 sm:grid-cols-3">
                    <Meter
                      label={`${usd(stop)} move within the hour`}
                      value={head.reach1}
                      rule={RULES.dead}
                      ruleLabel={`under ${pct(RULES.dead)}: no trade`}
                      hit="text-status-prime"
                    />
                    <Meter
                      label={`${usd(2 * stop)} move within 3 hours`}
                      value={head.reach2}
                      rule={RULES.full}
                      ruleLabel={`${pct(RULES.full)} or more: 2R plan`}
                      hit="text-status-prime"
                    />
                    <Meter
                      label="Both stops hit within the hour"
                      value={head.whip}
                      rule={RULES.fast}
                      ruleLabel={`${pct(RULES.fast)} or more: fast market`}
                      hit="text-status-swing"
                    />
                  </div>
                </>
              ) : (
                <p className="mt-3 text-lg">
                  {view.slot > P.slots - P.minHorizon
                    ? `Less than 2 hours to the daily close at ${istClock(closeAt)} IST. No new entries.`
                    : "Not enough recent sessions loaded to compare against."}
                </p>
              )}
              {headIsTonight && view.now && (
                <p className="mt-5 border-t border-border pt-4 text-base">
                  <span className="text-muted-foreground">Right now, next 3 hours: </span>
                  <span className={`font-bold ${look[view.now.verdict].text}`}>
                    {look[view.now.verdict].word}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {" "}
                    · {usd(view.now.usd)} · {view.now.r.toFixed(1)}R · 2R within 3h{" "}
                    {pct(view.now.reach2)}
                  </span>
                </p>
              )}
              {headIsTonight && (
                <p className="mt-2 text-sm text-muted-foreground">
                  An early read for the evening: it firms up as the day goes on. From 17:00 IST this
                  card switches to the live next-3-hours read.
                </p>
              )}
            </section>

            <section
              className="mt-6 border border-border bg-panel p-4 sm:p-5"
              aria-label="An ordinary day"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="terminal-label">An ordinary day · last 20 sessions</p>
                <p className="text-sm text-muted-foreground">
                  bar = usual 3-hour range from that time, in {usd(stop)} stops
                </p>
              </div>
              <div className="relative mt-4 h-28">
                {[RULES_LINES.full, RULES_LINES.dead].map((line) => (
                  <div
                    key={line}
                    className="pointer-events-none absolute inset-x-0 border-t border-dashed border-foreground/25"
                    style={{ bottom: `${(line / CHART_MAX) * 100}%` }}
                  />
                ))}
                {view.typical.map((bar) => (
                  <div
                    key={bar.slot}
                    className={`absolute bottom-0 ${look[bar.verdict].fill}`}
                    style={{
                      left: `${(bar.slot / P.slots) * 100}%`,
                      width: `calc(${(P.step / P.slots) * 100}% - 1px)`,
                      height: `${Math.min(100, (bar.r / CHART_MAX) * 100)}%`,
                      opacity: 0.8,
                    }}
                    title={`${istClock(bar.at)} IST · ${bar.r.toFixed(1)}R · ${look[bar.verdict].word}`}
                  />
                ))}
                {view.marketOpen && (
                  <div
                    className="absolute inset-y-0 z-10 w-0.5 bg-live-marker"
                    style={{ left: `${Math.min(100, (view.slot / P.slots) * 100)}%` }}
                  />
                )}
              </div>
              <div className="relative mt-2 h-5 text-xs font-medium text-muted-foreground">
                {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
                  const at = view.openAt + i * 3 * 3_600_000;
                  return (
                    <span
                      key={i}
                      className="absolute tabular-nums"
                      style={{ left: `${((i * 36) / P.slots) * 100}%` }}
                    >
                      {istClock(at)}
                    </span>
                  );
                })}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
                {(Object.keys(look) as FilterVerdict[]).map((verdict) => (
                  <div key={verdict} className="flex items-center gap-2">
                    <span className={`size-2.5 rounded-full ${look[verdict].fill}`} />
                    <span className="text-xs font-semibold text-muted-foreground">
                      {look[verdict].word}
                    </span>
                  </div>
                ))}
                <span className="text-xs text-muted-foreground">
                  The signal above moves off this picture when today is far from normal.
                </span>
              </div>
            </section>

            <section
              className="mt-6 border border-border bg-panel p-4 sm:p-5"
              aria-label="Today so far"
            >
              <p className="terminal-label">
                Today so far · {istClock(view.openAt)} to now, against the same hours
              </p>
              <p className="mt-2 text-lg">{describe(view) || "The session has not started."}</p>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[30rem] text-sm tabular-nums sm:text-base">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-3 font-semibold" />
                      <th className="py-2 pr-3 text-right font-semibold">Today</th>
                      <th className="py-2 pr-3 text-right font-semibold">Yesterday</th>
                      <th className="py-2 pr-3 text-right font-semibold">Last week</th>
                      <th className="py-2 pr-3 text-right font-semibold">20-day usual</th>
                      <th
                        className="py-2 text-right font-semibold"
                        title={`Share of the last ${DAY_FILTER.sixMonths.sessions} sessions that were lower at this hour`}
                      >
                        6-month rank
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-t border-border/70">
                      <td className="py-2 pr-3 text-muted-foreground">Range</td>
                      <td className="py-2 pr-3 text-right font-bold">{money(today?.range)}</td>
                      <td className="py-2 pr-3 text-right">{money(yesterday?.range)}</td>
                      <td className="py-2 pr-3 text-right">{money(lastWeek?.range)}</td>
                      <td className="py-2 pr-3 text-right">{money(norm?.range)}</td>
                      <td className="py-2 text-right">{rank(view.sixMonth.range)}</td>
                    </tr>
                    <tr className="border-t border-border/70">
                      <td className="py-2 pr-3 text-muted-foreground">Net move</td>
                      <td className="py-2 pr-3 text-right font-bold">
                        {today ? signedUsd(today.net) : dash}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {yesterday ? signedUsd(yesterday.net) : dash}
                      </td>
                      <td className="py-2 pr-3 text-right">{money(lastWeek?.absNet)}</td>
                      <td className="py-2 pr-3 text-right">{money(norm?.absNet)}</td>
                      <td className="py-2 text-right">{rank(view.sixMonth.net)}</td>
                    </tr>
                    <tr className="border-t border-border/70">
                      <td
                        className="py-2 pr-3 text-muted-foreground"
                        title="Net move as a share of the distance travelled on 5-minute closes. 100% = a straight line."
                      >
                        Straightness
                      </td>
                      <td className="py-2 pr-3 text-right font-bold">{eff(today?.er)}</td>
                      <td className="py-2 pr-3 text-right">{eff(yesterday?.er)}</td>
                      <td className="py-2 pr-3 text-right">{eff(lastWeek?.er)}</td>
                      <td className="py-2 pr-3 text-right">{eff(norm?.er)}</td>
                      <td className="py-2 text-right">{rank(view.sixMonth.er)}</td>
                    </tr>
                    <tr className="border-t border-border/70">
                      <td
                        className="py-2 pr-3 text-muted-foreground"
                        title="How much the 5-minute bars moved, against the 20-day usual"
                      >
                        Bar activity
                      </td>
                      <td className="py-2 pr-3 text-right font-bold">{ratio(today?.rv)}</td>
                      <td className="py-2 pr-3 text-right">{ratio(yesterday?.rv)}</td>
                      <td className="py-2 pr-3 text-right">{ratio(lastWeek?.rv)}</td>
                      <td className="py-2 pr-3 text-right">1.00×</td>
                      <td className="py-2 text-right text-muted-foreground">{dash}</td>
                    </tr>
                    <tr className="border-t border-border/70">
                      <td
                        className="py-2 pr-3 text-muted-foreground"
                        title={`A swing ends when price turns back by one stop (${usd(stop)})`}
                      >
                        Longest swing
                      </td>
                      <td className="py-2 pr-3 text-right font-bold">
                        {today ? `${today.longest.toFixed(1)} stops` : dash}
                      </td>
                      <td className="py-2 pr-3 text-right">{num(yesterday?.longest, 1)}</td>
                      <td className="py-2 pr-3 text-right">{num(lastWeek?.longest, 1)}</td>
                      <td className="py-2 pr-3 text-right">{num(norm?.longest, 1)}</td>
                      <td className="py-2 text-right text-muted-foreground">{dash}</td>
                    </tr>
                    <tr className="border-t border-border/70">
                      <td className="py-2 pr-3 text-muted-foreground">Swings of 3+ stops</td>
                      <td className="py-2 pr-3 text-right font-bold">
                        {today ? `${today.runners} of ${today.legs}` : dash}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {yesterday ? `${yesterday.runners} of ${yesterday.legs}` : dash}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {lastWeek?.runners != null && lastWeek.legs != null
                          ? `${lastWeek.runners.toFixed(1)} of ${lastWeek.legs.toFixed(0)}`
                          : dash}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {norm?.runners != null && norm.legs != null
                          ? `${num(norm.runners)} of ${num(norm.legs)}`
                          : dash}
                      </td>
                      <td className="py-2 text-right text-muted-foreground">{dash}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                This table describes the day. It is not part of the signal: in the test below, how
                choppy the last hours were said nothing about the next ones.
              </p>
            </section>

            <section
              className="mt-6 border border-border bg-panel p-4 sm:p-5"
              aria-label="How this was tested"
            >
              <p className="terminal-label">How this was tested</p>
              <ul className="mt-3 space-y-2 text-base">
                <li>
                  <span className="font-bold text-status-prime">Movement carries over.</span>{" "}
                  Activity in the last 4 hours against the range of the next 3:{" "}
                  <span className="font-semibold tabular-nums">{signed(ev.moveToMove)}</span> rank
                  correlation over {ev.points.toLocaleString("en-US")} half-hour checks, time of day
                  removed.
                </li>
                <li>
                  <span className="font-bold text-status-stop">Chop does not.</span> Straightness of
                  the last 4 hours against the next 3:{" "}
                  <span className="font-semibold tabular-nums">{signed(ev.chopToChop)}</span>. 1R
                  moves that ran on to 2R, same comparison:{" "}
                  <span className="font-semibold tabular-nums">{signed(ev.contToCont)}</span>. Both
                  are zero.
                </li>
                <li>
                  Day to day it leans the other way. After a trend day the next day trended{" "}
                  {pct(ev.trendAfterTrend)} of the time, after any other day{" "}
                  {pct(ev.trendAfterOther)}. A choppy day is no reason to skip the next one.
                </li>
                <li>
                  So the signal forecasts movement only. Over {skill.sessions} sessions, each
                  forecast made with data up to that minute, it ranked the next 3 hours with
                  correlation{" "}
                  <span className="font-semibold tabular-nums">{skill.rank.toFixed(2)}</span> (
                  {skill.rankNormOnly.toFixed(2)} from the clock time alone).
                </li>
                <li className="text-muted-foreground">
                  Limits. In the calm last third of the data, today&apos;s activity added nothing
                  over the usual for that clock time. The evening call made at noon is weak
                  {noon ? ` (correlation ${noon.rank.toFixed(2)})` : ""}. No signal here picks
                  direction or finds an edge: a coin-flip entry lost the fee in every row.
                </li>
              </ul>

              <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                <p className="text-base font-semibold">
                  What followed each signal · {usd(stop)} stop
                </p>
                <div
                  className="inline-flex border border-border p-1"
                  role="group"
                  aria-label="Hours"
                >
                  {(["evening", "all"] as const).map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => setScope(item)}
                      className={`px-3 py-1 text-sm font-semibold transition-colors ${scope === item ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                      aria-pressed={scope === item}
                    >
                      {item === "evening" ? "17:00–21:00 IST" : "All hours"}
                    </button>
                  ))}
                </div>
              </div>
              {tables && (
                <BacktestTable
                  rows={scope === "evening" ? tables.evening : tables.all}
                  unit="Share of time"
                />
              )}
              <p className="mt-3 text-sm text-muted-foreground">
                Percentages are shares of entry minutes in the 3 hours after each signal. Stop{" "}
                {tables?.stopPct}% of price, {DAY_FILTER.dataFrom} to {DAY_FILTER.dataThrough},
                first 60 sessions used only to start the model.
              </p>
            </section>
          </>
        )}

        <footer className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
          <span>Statistical read of movement · not trading advice</span>
          <span className="sm:ml-auto">
            {gold.status === "error" && gold.bars.length > 0 ? "Live feed down · " : ""}
            Binance XAUUSDT 5m
            {gold.fetchedAt ? ` · updated ${istClock(gold.fetchedAt, true)}` : ""} · research
            through {DAY_FILTER.dataThrough}
          </span>
        </footer>
      </div>
    </main>
  );
}

/** Chart scale: bars are drawn up to this many stops; dashed lines mark where the signal changes. */
const CHART_MAX = 8;
const crossing = (table: readonly number[], level: number) => {
  const f = DAY_FILTER.offer.f;
  const i = table.findIndex((v) => v >= level);
  if (i <= 0) return f[Math.max(i, 0)]!;
  return f[i - 1]! + ((f[i]! - f[i - 1]!) * (level - table[i - 1]!)) / (table[i]! - table[i - 1]!);
};
const RULES_LINES = {
  dead: crossing(DAY_FILTER.offer.reach1, RULES.dead),
  full: crossing(DAY_FILTER.offer.reach2, RULES.full),
};
