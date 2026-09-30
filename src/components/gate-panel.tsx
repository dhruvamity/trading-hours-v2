import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { NotebookPen, ShieldAlert, ShieldCheck } from "lucide-react";
import { assetOf } from "@/lib/events";
import {
  COOLDOWN_AFTER_LOSS_MIN,
  LOCK_DAY_PCT,
  LOCK_LOSSES,
  MAX_OPEN,
  dayKey,
  dayStats,
  evaluateGate,
  lockStatus,
  type CheckState,
  type TradeEntry,
} from "@/lib/discipline";
import { buildBlocks, newsState } from "@/lib/news-feed";
import type { Instrument, Status } from "@/lib/timetable";
import { newId, useTrades } from "@/lib/trade-log";
import type { NewsFeed } from "@/lib/use-news";

const tone: Record<CheckState, { text: string; label: string; border: string }> = {
  pass: { text: "text-status-prime", label: "Pass", border: "border-border" },
  warn: { text: "text-status-small", label: "Careful", border: "border-status-small/50" },
  fail: { text: "text-status-stop", label: "Blocked", border: "border-status-stop/60" },
};

export function GatePanel({
  now,
  instrument,
  feed,
  windowStatus,
  windowEnd,
}: {
  now: Date | null;
  instrument: Instrument;
  feed: NewsFeed;
  windowStatus: Status;
  windowEnd: string | null;
}) {
  const [trades, setTrades, ready] = useTrades();
  const [confirming, setConfirming] = useState(false);
  const [side, setSide] = useState<"long" | "short">("long");
  const [pct, setPct] = useState("");
  const t = now?.getTime() ?? 0;

  const gate = useMemo(() => {
    const blocks = buildBlocks(feed.events, assetOf(instrument));
    const news = feed.ok ? newsState(blocks, t) : null;
    const day = dayStats(trades, dayKey(t));
    const open = trades.filter((x) => x.closedAt == null);
    return {
      ...evaluateGate({
        now: t,
        window: { status: windowStatus, end: windowEnd },
        news,
        day,
        openCount: open.length,
      }),
      day,
      open,
    };
  }, [feed, instrument, t, trades, windowStatus, windowEnd]);

  if (!now || !ready) return null;
  const lock = lockStatus(gate.day);
  const nogo = gate.verdict === "NO-GO";
  const go = gate.verdict === "GO";
  const color = nogo ? "text-status-stop" : go ? "text-status-prime" : "text-status-small";
  const border = nogo
    ? "border-status-stop/50"
    : go
      ? "border-status-prime/40"
      : "border-status-small/40";
  const open = gate.open[0];
  const reasons = gate.checks.filter((c) => c.state !== "pass");

  const take = () => {
    const entry: TradeEntry = {
      id: newId(),
      instrument,
      side,
      openedAt: t,
      note: "",
      verdict: gate.verdict,
      failed: gate.checks.filter((c) => c.state === "fail").map((c) => c.id),
      warned: gate.checks.filter((c) => c.state === "warn").map((c) => c.id),
    };
    setTrades((old) => [...old, entry]);
    setConfirming(false);
  };
  const close = (result: "win" | "loss") => {
    const value = pct.trim() === "" ? undefined : Number(pct);
    const signed =
      value === undefined || Number.isNaN(value)
        ? undefined
        : result === "loss"
          ? -Math.abs(value)
          : Math.abs(value);
    setTrades((old) =>
      old.map((x) =>
        x.id === open?.id
          ? { ...x, closedAt: Date.now(), result, ...(signed === undefined ? {} : { pct: signed }) }
          : x,
      ),
    );
    setPct("");
  };

  return (
    <section
      className={`mt-4 grid gap-px border bg-border lg:grid-cols-[1.4fr_1fr] ${border}`}
      aria-label="GO / NO-GO gate"
    >
      <div className="bg-panel p-5">
        <div className="flex items-center justify-between gap-3">
          <p className="terminal-label flex items-center gap-2">
            {nogo ? (
              <ShieldAlert className="size-4" aria-hidden="true" />
            ) : (
              <ShieldCheck className="size-4" aria-hidden="true" />
            )}
            Gate · before every trade
          </p>
          <Link
            to="/journal"
            className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            <NotebookPen className="size-4" aria-hidden="true" /> Journal & weekly review →
          </Link>
        </div>
        <p className={`mt-2.5 text-3xl font-bold ${color}`}>{gate.verdict}</p>
        <p className="mt-2 text-base">
          {go
            ? "Every check passes. One position, one account."
            : reasons
                .map((c) => c.detail)
                .slice(0, 2)
                .join(" ")}
        </p>
        {lock.locked && (
          <Link
            to="/journal"
            className="mt-2 inline-block text-sm font-semibold text-status-stop hover:underline"
          >
            Day locked. Write today's journal →
          </Link>
        )}

        <div className="mt-4 border-t border-border pt-4">
          {open ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold">
                Open: {open.instrument === "XAUUSDT" ? "Gold" : "BTC"} {open.side}
              </span>
              <input
                value={pct}
                onChange={(e) => setPct(e.target.value)}
                inputMode="decimal"
                placeholder="result % of account (optional)"
                aria-label="Result in percent of account"
                className="w-56 border border-border bg-background px-2 py-1.5 text-sm"
              />
              <button
                onClick={() => close("win")}
                className="border border-status-prime px-3 py-1.5 font-semibold text-status-prime"
              >
                Closed: win
              </button>
              <button
                onClick={() => close("loss")}
                className="border border-status-stop px-3 py-1.5 font-semibold text-status-stop"
              >
                Closed: loss
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-sm">
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
                    Enter anyway (logs a rule break)
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
                  onClick={() => (nogo ? setConfirming(true) : take())}
                  className={`border px-3 py-1.5 font-semibold ${nogo ? "border-border text-muted-foreground" : "border-foreground"}`}
                >
                  Log entry on {instrument === "XAUUSDT" ? "gold" : "BTC"}
                </button>
              )}
              <span className="text-muted-foreground">
                Logging an entry records what the gate said.
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="bg-panel p-5">
        <div className="grid gap-2">
          {gate.checks.map((c) => (
            <div key={c.id} className={`border bg-background/30 p-3 ${tone[c.state].border}`}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold">{c.title}</span>
                <span className={`text-xs font-bold uppercase ${tone[c.state].text}`}>
                  {tone[c.state].label}
                </span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{c.detail}</p>
            </div>
          ))}
        </div>
        <div className="mt-4 text-sm text-muted-foreground">
          <p className="font-semibold text-foreground">Same trade on more than one account? No.</p>
          <p className="mt-1">
            {MAX_OPEN} position across all accounts. In the trader's logs, the same position on 2+
            accounts lost money and breached several accounts on one bad move.
          </p>
          <p className="mt-3 font-semibold text-foreground">Anti-revenge</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>
              {LOCK_LOSSES} losses or {LOCK_DAY_PCT}% on the day: stop, write the journal.
            </li>
            <li>Wait {COOLDOWN_AFTER_LOSS_MIN} min after a loss.</li>
            <li>Never bigger size than the trade that just lost.</li>
            <li>No new account to win it back.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
