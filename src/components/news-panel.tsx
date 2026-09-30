import { CalendarClock, Newspaper } from "lucide-react";
import type { Instrument } from "@/lib/timetable";
import {
  EVENTS_META,
  activeBlock,
  dayVerdict,
  eventTime,
  istClock,
  istDateKey,
  istDayLabel,
  upcomingEvents,
  type Verdict,
} from "@/lib/events";

const verdictTone: Record<Verdict, { text: string; dot: string; border: string }> = {
  CLEAR: { text: "text-status-prime", dot: "bg-status-prime", border: "border-status-prime/40" },
  CAUTION: { text: "text-status-small", dot: "bg-status-small", border: "border-status-small/40" },
  "NEWS DAY": { text: "text-status-stop", dot: "bg-status-stop", border: "border-status-stop/50" },
  "MARKET CLOSED": {
    text: "text-status-closed",
    dot: "bg-status-closed",
    border: "border-status-closed/40",
  },
};

const tierLabel = ["", "High", "Medium", "Low"];
const tierTone = ["", "text-status-stop", "text-status-small", "text-muted-foreground"];

function countdown(ms: number) {
  if (ms <= 0) return "released";
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `in ${d}d ${h % 24}h`;
  if (h > 0) return `in ${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `in ${m}m`;
}

export function NewsPanel({ now, instrument }: { now: Date | null; instrument: Instrument }) {
  if (!now) return null;
  const today = dayVerdict(now, instrument);
  const blocked = activeBlock(now, today.blocks);
  const tone = verdictTone[today.verdict];
  const todayKey = istDateKey(now);
  const upcoming = upcomingEvents(now, 7).filter(
    (e) => istDateKey(new Date(eventTime(e))) !== todayKey,
  );

  return (
    <section
      className={`mt-4 grid gap-px border bg-border lg:grid-cols-[1.4fr_1fr] ${tone.border}`}
      aria-label="News check"
    >
      <div className="bg-panel p-5">
        <div className="flex items-center justify-between gap-3">
          <p className="terminal-label flex items-center gap-2">
            <Newspaper className="size-4" aria-hidden="true" />
            News check · today
          </p>
          <a
            href="/news.html"
            className="text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            How each release behaves →
          </a>
        </div>
        <div className="mt-2.5 flex items-center gap-2.5">
          <span className={`size-3 rounded-full ${tone.dot}`} />
          <p className={`text-2xl font-bold ${tone.text}`}>
            {blocked ? "STAND ASIDE NOW" : today.verdict}
          </p>
        </div>
        <p className="mt-2 text-base">
          {blocked
            ? `${blocked.event.name} window until ${istClock(blocked.to)} IST. No new trades.`
            : today.headline}
        </p>
        {today.lines.length > 0 && (
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            {today.lines.map((line, index) => (
              <li key={`${index}-${line}`} className="flex gap-2">
                <span aria-hidden="true">·</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        )}
        {today.events.length > 0 && (
          <div className="mt-4 border-t border-border pt-3">
            {today.events.map((e) => (
              <div
                key={`${e.time}-${e.kind}`}
                className="flex items-baseline justify-between gap-3 py-1.5 text-sm"
              >
                <span className="tabular-nums">{istClock(eventTime(e))}</span>
                <span className="min-w-0 flex-1 truncate">{e.name}</span>
                <span className={`text-xs font-bold uppercase ${tierTone[e.tier]}`}>
                  {tierLabel[e.tier]}
                </span>
                <span className="w-24 text-right text-xs tabular-nums text-muted-foreground">
                  {countdown(eventTime(e) - now.getTime())}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="bg-panel p-5">
        <p className="terminal-label flex items-center gap-2">
          <CalendarClock className="size-4" aria-hidden="true" />
          Next 7 days · high & medium impact
        </p>
        {upcoming.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Nothing scheduled.</p>
        ) : (
          <div className="mt-2">
            {upcoming.map((e) => (
              <div
                key={`${e.time}-${e.kind}`}
                className="flex items-baseline justify-between gap-3 border-b border-border/60 py-2 text-sm last:border-b-0"
              >
                <span className="w-28 shrink-0 text-muted-foreground">
                  {istDayLabel(eventTime(e))}
                </span>
                <span className="w-12 shrink-0 font-semibold tabular-nums">
                  {istClock(eventTime(e))}
                </span>
                <span className="min-w-0 flex-1 truncate">{e.name}</span>
                <span className={`text-xs font-bold uppercase ${tierTone[e.tier]}`}>
                  {tierLabel[e.tier]}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          US releases from BLS / BEA / Fed schedules · calendar through{" "}
          {EVENTS_META.calendarThrough}. Fed speeches and surprise headlines are not listed — check
          a live calendar too.
        </p>
      </div>
    </section>
  );
}
