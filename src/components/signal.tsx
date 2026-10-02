import { Link } from "@tanstack/react-router";
import type { CheckState } from "@/lib/discipline";
import { formatCountdown } from "@/lib/format";
import { DAYS } from "@/lib/timetable";
import type { GateState } from "@/lib/use-gate";

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

/** The one-glance answer: can I trade right now, until when, and why not. Read-only. */
export function Signal({ g, today }: { g: GateState; today: (typeof DAYS)[number] | null }) {
  if (!today || !g.ready)
    return <section className="mt-6 h-44 border border-border bg-panel" aria-hidden="true" />;

  const closed = g.windowStatus === "CLOSED";
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
  const problem = g.checks.find((c) => c.state !== "pass");
  const reason = closed
    ? "Market shut."
    : (problem?.detail ??
      `${g.windowStatus} window${g.windowEnd ? ` until ${g.windowEnd} IST` : ""}.`);
  const next = g.live.next;

  return (
    <section className={`mt-6 border bg-panel p-5 sm:p-7 ${edge}`} aria-label="Trading signal">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className={`text-6xl font-bold leading-none sm:text-7xl ${color}`}>{word}</p>
          <p className="mt-3 text-lg">{reason}</p>
          {g.lock.locked && (
            <Link
              to="/journal"
              className="mt-1 inline-block text-base font-semibold text-status-stop hover:underline"
            >
              Day locked. Open the journal →
            </Link>
          )}
        </div>
        <div className="shrink-0 text-base sm:text-right">
          {!closed && g.live.current && (
            <p className="tabular-nums">
              <span className="text-muted-foreground">Window ends </span>
              <span className="font-semibold">{formatCountdown(g.live.endsIn)}</span>
            </p>
          )}
          {next && (
            <p className="mt-1 text-muted-foreground">
              Next: <span className="font-semibold text-foreground">{next.window.status}</span> in{" "}
              {formatCountdown(next.startsIn)}
            </p>
          )}
        </div>
      </div>
      <ul
        className="mt-6 flex flex-wrap gap-x-5 gap-y-2 border-t border-border pt-4 text-sm"
        aria-label="Checks"
      >
        {g.checks.map((c) => (
          <li key={c.id} title={c.detail} className="flex items-center gap-2">
            <span className={`size-2.5 rounded-full ${dot[c.state]}`} />
            <span className={c.state === "pass" ? "text-muted-foreground" : "font-semibold"}>
              {SHORT[c.id]}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
