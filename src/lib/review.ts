// Weekly review from the trades you logged: which rules each entry broke, and done right / done wrong.
// Weeks run Monday → Sunday, IST.

import { MIN_HOLD_MIN, type CheckId, type TradeEntry } from "./discipline";

export type FlagId = CheckId | "too_short";

export const FLAGS: Record<FlagId, { label: string; rule: string }> = {
  window: {
    label: "Entered in a NO TRADE / closed window",
    rule: "Only enter in PRIME, SWING ENTRY or SMALL TRADES windows",
  },
  news: {
    label: "Entered inside a news window",
    rule: "No entries inside a stand-aside news window",
  },
  losses: {
    label: "Traded after the day was locked",
    rule: "Stop after 2 losses or -1% on the day",
  },
  cooldown: { label: "Re-entered too fast", rule: "Wait 45 min after a win, 60 min after a loss" },
  open: { label: "Second position at the same time", rule: "1 position across all accounts" },
  too_short: { label: `Held under ${MIN_HOLD_MIN} min`, rule: `Give trades ${MIN_HOLD_MIN}+ min` },
};
const IDS = Object.keys(FLAGS) as FlagId[];

export const flagsOf = (t: TradeEntry): FlagId[] => {
  const f: FlagId[] = [...t.failed];
  if (t.closedAt != null && (t.closedAt - t.openedAt) / 60_000 < MIN_HOLD_MIN) f.push("too_short");
  return f;
};

export function weekKey(ms: number): string {
  const d = new Date(ms + 5.5 * 3600_000); // IST wall clock, read through UTC getters
  const back = (d.getUTCDay() + 6) % 7; // Mon → 0 … Sun → 6
  return new Date(d.getTime() - back * 86_400_000).toISOString().slice(0, 10);
}

type Bucket = { n: number; pct: number };
export type Week = {
  week: string;
  trades: number;
  wins: number;
  pct: number;
  clean: Bucket;
  broken: Bucket;
  byFlag: Record<FlagId, Bucket>;
  list: TradeEntry[];
};

export function summarizeWeeks(trades: readonly TradeEntry[]): Week[] {
  const weeks = new Map<string, Week>();
  for (const t of trades) {
    if (t.closedAt == null) continue;
    const key = weekKey(t.closedAt);
    const w =
      weeks.get(key) ??
      ({
        week: key,
        trades: 0,
        wins: 0,
        pct: 0,
        clean: { n: 0, pct: 0 },
        broken: { n: 0, pct: 0 },
        byFlag: Object.fromEntries(IDS.map((i) => [i, { n: 0, pct: 0 }])) as Week["byFlag"],
        list: [],
      } as Week);
    const flags = flagsOf(t);
    const v = t.pct ?? 0;
    w.trades++;
    w.wins += t.result === "win" ? 1 : 0;
    w.pct += v;
    const b = flags.length ? w.broken : w.clean;
    b.n++;
    b.pct += v;
    for (const f of flags) {
      w.byFlag[f].n++;
      w.byFlag[f].pct += v;
    }
    w.list.push(t);
    weeks.set(key, w);
  }
  return [...weeks.values()].sort((a, b) => (a.week < b.week ? 1 : -1));
}

const p = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}%`;

export function rightAndWrong(cur: Week, prev?: Week): { right: string[]; wrong: string[] } {
  const right: string[] = [];
  const wrong: string[] = [];
  if (!cur.trades) return { right, wrong: ["No trades logged this week."] };
  if (cur.clean.n)
    right.push(
      `${cur.clean.n} trade${cur.clean.n > 1 ? "s" : ""} taken on a clean gate: ${p(cur.clean.pct)}.`,
    );
  const kept = IDS.filter((i) => cur.byFlag[i].n === 0);
  if (kept.length)
    right.push(`Never broken this week: ${kept.map((i) => FLAGS[i].label).join("; ")}.`);
  if (prev) {
    for (const i of IDS)
      if (cur.byFlag[i].n === 0 && prev.byFlag[i].n > 0)
        right.push(`Fixed since last week: "${FLAGS[i].label}" (was ${prev.byFlag[i].n}×).`);
    if (cur.pct > prev.pct) right.push(`Result improved: ${p(prev.pct)} → ${p(cur.pct)}.`);
  }
  for (const i of IDS.filter((x) => cur.byFlag[x].n > 0).sort(
    (a, b) => cur.byFlag[a].pct - cur.byFlag[b].pct,
  )) {
    const b = cur.byFlag[i];
    wrong.push(
      `${FLAGS[i].label}: ${b.n} trade${b.n > 1 ? "s" : ""}, ${p(b.pct)}. Rule: ${FLAGS[i].rule}.`,
    );
  }
  if (cur.broken.n && cur.clean.n && cur.broken.pct < cur.clean.pct)
    wrong.push(
      `Trades that broke a rule made ${p(cur.broken.pct)}; clean trades made ${p(cur.clean.pct)}.`,
    );
  if (prev) {
    for (const i of IDS)
      if (cur.byFlag[i].n > prev.byFlag[i].n && prev.trades)
        wrong.push(
          `Worse than last week: "${FLAGS[i].label}" ${prev.byFlag[i].n}× → ${cur.byFlag[i].n}×.`,
        );
    if (cur.pct < prev.pct) wrong.push(`Result got worse: ${p(prev.pct)} → ${p(cur.pct)}.`);
  }
  return { right, wrong };
}
