import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { dayKey, dayStats, lockStatus, LOCK_DAY_PCT, LOCK_LOSSES } from "@/lib/discipline";
import { FLAGS, flagsOf, rightAndWrong, summarizeWeeks, weekKey } from "@/lib/review";
import { emptyDay, newId, useJournal, useTrades, type JournalDay } from "@/lib/trade-log";
import { useGate } from "@/lib/use-gate";
import { useNews } from "@/lib/use-news";
import type { Instrument } from "@/lib/timetable";
import type { TradeEntry } from "@/lib/discipline";

export const Route = createFileRoute("/journal")({
  head: () => ({ meta: [{ title: "Journal & Weekly Review — IST Session Terminal" }] }),
  component: Journal,
});

const pct = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}%`;
const tone = (v: number) => (v > 0 ? "text-status-prime" : v < 0 ? "text-status-stop" : "");
const when = (ms: number) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
const box = "w-full border border-border bg-background px-3 py-2 text-base";

function Journal() {
  const [trades, setTrades, tradesReady] = useTrades();
  const [days, setDays, daysReady] = useJournal();
  const [now, setNow] = useState<number | null>(null);
  const [date, setDate] = useState<string | null>(null);
  useEffect(() => {
    const t = Date.now();
    setNow(t);
    setDate(dayKey(t));
  }, []);

  const feed = useNews();
  const [instrument, setInstrument] = useState<Instrument>("XAUUSDT");
  const [side, setSide] = useState<"long" | "short">("long");
  const [confirming, setConfirming] = useState(false);
  const [resultPct, setResultPct] = useState("");
  const gate = useGate(now ? new Date(now) : null, instrument, feed);
  const take = () => {
    const entry: TradeEntry = {
      id: newId(),
      instrument,
      side,
      openedAt: Date.now(),
      note: "",
      verdict: gate.verdict,
      failed: gate.checks.filter((c) => c.state === "fail").map((c) => c.id),
      warned: gate.checks.filter((c) => c.state === "warn").map((c) => c.id),
    };
    setTrades((old) => [...old, entry]);
    setConfirming(false);
  };
  const closeTrade = (result: "win" | "loss") => {
    const v = resultPct.trim() === "" ? NaN : Number(resultPct);
    const signed = Number.isNaN(v) ? undefined : result === "loss" ? -Math.abs(v) : Math.abs(v);
    setTrades((old) =>
      old.map((x) =>
        x.id === gate.open?.id
          ? { ...x, closedAt: Date.now(), result, ...(signed === undefined ? {} : { pct: signed }) }
          : x,
      ),
    );
    setResultPct("");
  };

  const day = date ? (days[date] ?? emptyDay(date)) : null;
  const stats = useMemo(() => (date ? dayStats(trades, date) : null), [trades, date]);
  const lock = stats ? lockStatus(stats) : { locked: false, text: "" };
  const save = (patch: Partial<JournalDay>) =>
    date && setDays((old) => ({ ...old, [date]: { ...(old[date] ?? emptyDay(date)), ...patch } }));

  // remember when today's lock first appeared
  useEffect(() => {
    if (!date || !daysReady || !lock.locked || days[date]?.lockedAt) return;
    setDays((old) => ({
      ...old,
      [date]: { ...(old[date] ?? emptyDay(date)), lockedAt: Date.now(), lockReason: lock.text },
    }));
  }, [date, daysReady, lock.locked, lock.text, days, setDays]);

  const weeks = useMemo(() => summarizeWeeks(trades), [trades]);
  const thisKey = now ? weekKey(now) : null;
  const cur = weeks.find((w) => w.week === thisKey) ?? weeks[0];
  const prev = cur ? weeks.find((w) => w.week < cur.week) : undefined;
  const verdict = cur ? rightAndWrong(cur, prev) : null;
  const dayTrades = date
    ? trades.filter((t) => dayKey(t.openedAt) === date).sort((a, b) => a.openedAt - b.openedAt)
    : [];
  const history = useMemo(() => {
    const keys = new Set([...Object.keys(days), ...trades.map((t) => dayKey(t.openedAt))]);
    return [...keys].sort().reverse().slice(0, 21);
  }, [days, trades]);

  if (!day || !stats || !tradesReady || !daysReady)
    return <main className="p-6 text-muted-foreground">Loading…</main>;

  return (
    <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-2xl font-bold">
          Journal · {date}
          {date === dayKey(now ?? 0) ? " (today)" : ""}
        </h1>
        <Link to="/" className="text-sm font-medium text-muted-foreground hover:text-foreground">
          ← Timetable
        </Link>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Saved in this browser only. Nothing is sent anywhere.
      </p>

      {lock.locked && (
        <div className="mt-4 border border-status-stop/60 bg-status-stop/10 p-4">
          <p className="font-bold text-status-stop">Day locked: {lock.text}</p>
          <p className="mt-1 text-base">
            No more entries today. Write what happened and what you do differently. The lock clears
            at the next daily reset (00:00 UTC, 05:30 IST). This page cannot block orders, so the
            lock only holds if you keep it.
          </p>
        </div>
      )}

      <section className="mt-4 grid grid-cols-2 gap-px border border-border bg-border md:grid-cols-4">
        {[
          ["Trades", String(stats.trades), ""],
          [
            "Wins / losses",
            `${stats.wins} / ${stats.losses}`,
            stats.losses >= LOCK_LOSSES ? "text-status-stop" : "",
          ],
          ["Day", pct(stats.pct), stats.pct <= LOCK_DAY_PCT ? "text-status-stop" : tone(stats.pct)],
          ["Open now", String(trades.filter((t) => t.closedAt == null).length), ""],
        ].map(([label, value, cls]) => (
          <div key={label} className="bg-panel p-4">
            <p className="terminal-label">{label}</p>
            <p className={`mt-1 text-2xl font-bold tabular-nums ${cls}`}>{value}</p>
          </div>
        ))}
      </section>

      <section className="mt-4 border border-border bg-panel p-5">
        <h2 className="text-lg font-bold">Log a trade</h2>
        <p className="mt-1 text-base">
          Gate now:{" "}
          <span
            className={
              gate.verdict === "GO"
                ? "font-bold text-status-prime"
                : gate.verdict === "NO-GO"
                  ? "font-bold text-status-stop"
                  : "font-bold text-status-small"
            }
          >
            {gate.verdict}
          </span>
          {gate.checks.filter((c) => c.state !== "pass").map((c) => ` · ${c.detail}`)}
        </p>
        {gate.open ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-base">
            <span className="font-semibold">
              Open: {gate.open.instrument === "XAUUSDT" ? "Gold" : "BTC"} {gate.open.side}
            </span>
            <input
              value={resultPct}
              onChange={(e) => setResultPct(e.target.value)}
              inputMode="decimal"
              placeholder="result % of account (optional)"
              aria-label="Result in percent of account"
              className="w-64 border border-border bg-background px-2 py-1.5"
            />
            <button
              onClick={() => closeTrade("win")}
              className="border border-status-prime px-3 py-1.5 font-semibold text-status-prime"
            >
              Closed: won
            </button>
            <button
              onClick={() => closeTrade("loss")}
              className="border border-status-stop px-3 py-1.5 font-semibold text-status-stop"
            >
              Closed: lost
            </button>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-base">
            {(["XAUUSDT", "BTCUSDT"] as const).map((i) => (
              <button
                key={i}
                onClick={() => setInstrument(i)}
                className={`border px-3 py-1.5 font-semibold ${instrument === i ? "border-foreground" : "border-border text-muted-foreground"}`}
              >
                {i === "XAUUSDT" ? "Gold" : "BTC"}
              </button>
            ))}
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
                onClick={() => (gate.verdict === "NO-GO" ? setConfirming(true) : take())}
                className="border border-foreground px-3 py-1.5 font-semibold"
              >
                Log entry
              </button>
            )}
          </div>
        )}
        <p className="mt-2 text-sm text-muted-foreground">
          Log right before you enter. It records what the gate said.
        </p>
      </section>

      <section className="mt-4 border border-border bg-panel p-5">
        <h2 className="text-lg font-bold">Before trading: the plan</h2>
        <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
          Mood:
          {([1, 2, 3, 4, 5] as const).map((m) => (
            <button
              key={m}
              onClick={() => save({ mood: m })}
              aria-label={`Mood ${m} of 5`}
              className={`size-9 border text-base font-semibold ${day.mood === m ? "border-foreground text-foreground" : "border-border"}`}
            >
              {m}
            </button>
          ))}
          <span>1 = tilted, 5 = calm</span>
        </div>
        <textarea
          className={`${box} mt-3`}
          rows={3}
          placeholder="Bias, the one setup I trade today, where I am wrong, which account."
          value={day.plan}
          onChange={(e) => save({ plan: e.target.value })}
        />
      </section>

      <section className="mt-4 border border-border bg-panel p-5">
        <h2 className="text-lg font-bold">Trades ({dayTrades.length})</h2>
        {dayTrades.length === 0 ? (
          <p className="mt-2 text-base text-muted-foreground">
            No entries logged. Use "Log entry" above right before you trade.
          </p>
        ) : (
          <div className="mt-3 grid gap-3">
            {dayTrades.map((t) => {
              const flags = flagsOf(t);
              return (
                <div key={t.id} className="border border-border bg-background/30 p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-base">
                      <strong>{t.instrument === "XAUUSDT" ? "Gold" : "BTC"}</strong> {t.side} ·{" "}
                      {when(t.openedAt)}
                      {t.closedAt ? ` → ${when(t.closedAt)}` : " · open"} · gate said {t.verdict}
                    </span>
                    <span className={`font-bold tabular-nums ${tone(t.pct ?? 0)}`}>
                      {t.result ? `${t.result}${t.pct !== undefined ? ` ${pct(t.pct)}` : ""}` : ""}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-sm">
                    {flags.length === 0 ? (
                      <span className="text-status-prime">Followed every rule</span>
                    ) : (
                      flags.map((f) => (
                        <span
                          key={f}
                          title={FLAGS[f].rule}
                          className="border border-status-stop/50 px-2 py-0.5 text-status-stop"
                        >
                          {FLAGS[f].label}
                        </span>
                      ))
                    )}
                  </div>
                  <input
                    className={`${box} mt-2`}
                    placeholder="Why I took it / what I'd change"
                    value={day.notes[t.id] ?? t.note}
                    onChange={(e) => save({ notes: { ...day.notes, [t.id]: e.target.value } })}
                  />
                  <button
                    onClick={() => setTrades((old) => old.filter((x) => x.id !== t.id))}
                    className="mt-2 text-sm text-muted-foreground hover:text-foreground"
                  >
                    Delete this entry
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="mt-4 border border-border bg-panel p-5">
        <h2 className="text-lg font-bold">End of day</h2>
        <textarea
          className={`${box} mt-2`}
          rows={4}
          placeholder={
            lock.locked
              ? "Why did I hit the limit? What was I feeling on the trade that broke the plan?"
              : "What went right, what went wrong, in plain words."
          }
          value={day.review}
          onChange={(e) => save({ review: e.target.value })}
        />
        <input
          className={`${box} mt-2`}
          placeholder="One rule for tomorrow"
          value={day.lesson}
          onChange={(e) => save({ lesson: e.target.value })}
        />
      </section>

      <section className="mt-4 border border-border bg-panel p-5">
        <h2 className="text-lg font-bold">Weekly review{cur ? ` · week of ${cur.week}` : ""}</h2>
        {!cur || !verdict ? (
          <p className="mt-2 text-base text-muted-foreground">
            Nothing yet. Log entries and closes above and this fills itself in.
          </p>
        ) : (
          <>
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <div>
                <p className="font-bold text-status-prime">Done right</p>
                <ul className="mt-1 list-disc space-y-1.5 pl-5 text-base">
                  {verdict.right.length ? (
                    verdict.right.map((l, i) => <li key={i}>{l}</li>)
                  ) : (
                    <li className="list-none text-muted-foreground">Nothing to praise yet.</li>
                  )}
                </ul>
              </div>
              <div>
                <p className="font-bold text-status-stop">Done wrong</p>
                <ul className="mt-1 list-disc space-y-1.5 pl-5 text-base">
                  {verdict.wrong.length ? (
                    verdict.wrong.map((l, i) => <li key={i}>{l}</li>)
                  ) : (
                    <li className="list-none text-muted-foreground">No rule broken.</li>
                  )}
                </ul>
              </div>
            </div>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-base">
                <thead>
                  <tr className="text-left text-sm text-muted-foreground">
                    <th className="py-1.5 pr-4 font-medium" />
                    <th className="py-1.5 pr-4 font-medium">This week</th>
                    <th className="py-1.5 font-medium">Last week</th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ["Trades", (w) => String(w.trades)],
                      [
                        "Win rate",
                        (w) => (w.trades ? `${Math.round((100 * w.wins) / w.trades)}%` : "–"),
                      ],
                      ["Result", (w) => pct(w.pct)],
                      ["Clean entries", (w) => `${w.clean.n} (${pct(w.clean.pct)})`],
                      ["Rule-breaking entries", (w) => `${w.broken.n} (${pct(w.broken.pct)})`],
                    ] as [string, (w: NonNullable<typeof cur>) => string][]
                  ).map(([label, f]) => (
                    <tr key={label} className="border-t border-border/60">
                      <td className="py-1.5 pr-4 text-muted-foreground">{label}</td>
                      <td className="py-1.5 pr-4 tabular-nums">{f(cur)}</td>
                      <td className="py-1.5 tabular-nums">{prev ? f(prev) : "–"}</td>
                    </tr>
                  ))}
                  {(Object.keys(FLAGS) as (keyof typeof FLAGS)[]).map((id) => (
                    <tr key={id} className="border-t border-border/60">
                      <td className="py-1.5 pr-4 text-muted-foreground" title={FLAGS[id].rule}>
                        {FLAGS[id].label}
                      </td>
                      <td
                        className={`py-1.5 pr-4 tabular-nums ${cur.byFlag[id].n ? "text-status-stop" : "text-status-prime"}`}
                      >
                        {cur.byFlag[id].n
                          ? `${cur.byFlag[id].n}× (${pct(cur.byFlag[id].pct)})`
                          : "0"}
                      </td>
                      <td className="py-1.5 tabular-nums">
                        {prev
                          ? prev.byFlag[id].n
                            ? `${prev.byFlag[id].n}× (${pct(prev.byFlag[id].pct)})`
                            : "0"
                          : "–"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <p className="mt-3 text-sm text-muted-foreground">
          Built from the entries you log here. For a review built straight from your Propr account
          trades, use the Propr tracker.
        </p>
      </section>

      <section className="mt-4 border border-border bg-panel p-5">
        <h2 className="text-lg font-bold">Past days</h2>
        <div className="mt-2 divide-y divide-border/60">
          {history.map((d) => {
            const s = dayStats(trades, d);
            const j = days[d];
            return (
              <button
                key={d}
                onClick={() => setDate(d)}
                className={`flex w-full flex-wrap items-baseline gap-x-4 gap-y-1 py-2 text-left text-base ${d === date ? "text-foreground" : "text-muted-foreground"}`}
              >
                <span className="w-28 tabular-nums">{d}</span>
                <span className="w-24">{s.trades} trades</span>
                <span className={`w-24 tabular-nums ${tone(s.pct)}`}>{pct(s.pct)}</span>
                {j?.lockedAt && <span className="text-sm text-status-stop">locked</span>}
                <span className="min-w-0 flex-1 truncate text-sm">
                  {j?.lesson || j?.review || ""}
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </main>
  );
}
