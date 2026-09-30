// Discipline rules and the GO / NO-GO gate. Pure functions, no browser APIs.
// The numbers below are the rules: change them here and the gate, journal and review all follow.

import type { NewsState } from "./news-feed";
import type { Status } from "./timetable";

/** Day is locked after this many losing trades… */
export const LOCK_LOSSES = 2;
/** …or when the day's logged P&L reaches this % of the account. */
export const LOCK_DAY_PCT = -1;
/** Minutes to wait after a win / a loss before the next entry. */
export const COOLDOWN_AFTER_WIN_MIN = 45;
export const COOLDOWN_AFTER_LOSS_MIN = 60;
/** Open positions allowed across ALL accounts. The same trade on a second account counts. */
export const MAX_OPEN = 1;
/** Trades held shorter than this lost money in the trader's logs. */
export const MIN_HOLD_MIN = 15;

const MIN = 60_000;

export type TradeEntry = {
  id: string;
  instrument: "BTCUSDT" | "XAUUSDT";
  side: "long" | "short";
  openedAt: number;
  closedAt?: number;
  result?: "win" | "loss";
  /** P&L in % of the account, optional */
  pct?: number;
  note: string;
  /** what the gate said at the moment of entry */
  verdict: Verdict;
  failed: CheckId[];
  warned: CheckId[];
};

export type CheckId = "window" | "news" | "losses" | "cooldown" | "open";
export type Verdict = "GO" | "CAUTION" | "NO-GO";
export type CheckState = "pass" | "warn" | "fail";
export type GateCheck = { id: CheckId; title: string; state: CheckState; detail: string };

/** Propr, HyperPNL and Lighter all reset their daily numbers on the UTC date. */
export const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export type DayStats = {
  date: string;
  trades: number;
  wins: number;
  losses: number;
  pct: number;
  lastClose: number | null;
  lastResult: "win" | "loss" | null;
  lastLoss: number | null;
};

export function dayStats(trades: readonly TradeEntry[], date: string): DayStats {
  const closed = trades.filter((t) => t.closedAt != null && dayKey(t.closedAt) === date);
  const last = closed.reduce<TradeEntry | undefined>(
    (b, t) => (!b || t.closedAt! > b.closedAt! ? t : b),
    undefined,
  );
  const lossTimes = closed.filter((t) => t.result === "loss").map((t) => t.closedAt!);
  return {
    date,
    trades: closed.length,
    wins: closed.filter((t) => t.result === "win").length,
    losses: lossTimes.length,
    pct: closed.reduce((s, t) => s + (t.pct ?? 0), 0),
    lastClose: last?.closedAt ?? null,
    lastResult: last?.result ?? null,
    lastLoss: lossTimes.length ? Math.max(...lossTimes) : null,
  };
}

export function lockStatus(s: DayStats): { locked: boolean; text: string } {
  if (s.losses >= LOCK_LOSSES)
    return { locked: true, text: `${s.losses} losing trades today. Done for the day.` };
  if (s.pct <= LOCK_DAY_PCT)
    return {
      locked: true,
      text: `Day is ${s.pct.toFixed(2)}% (limit ${LOCK_DAY_PCT}%). Done for the day.`,
    };
  return { locked: false, text: "" };
}

const hhmm = (ms: number) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));

export type GateInput = {
  now: number;
  window: { status: Status; end: string | null };
  /** null = the live feed could not be reached */
  news: NewsState | null;
  day: DayStats;
  openCount: number;
};

export function evaluateGate(i: GateInput): { verdict: Verdict; checks: GateCheck[] } {
  const w = i.window;
  const until = w.end ? ` until ${w.end} IST` : "";
  const windowCheck: GateCheck =
    w.status === "PRIME" || w.status === "SWING ENTRY"
      ? {
          id: "window",
          title: "Timetable window",
          state: "pass",
          detail: `${w.status} window${until}.`,
        }
      : w.status === "SMALL TRADES"
        ? {
            id: "window",
            title: "Timetable window",
            state: "warn",
            detail: `SMALL TRADES window${until}. Half size, quick targets.`,
          }
        : {
            id: "window",
            title: "Timetable window",
            state: "fail",
            detail: `${w.status} window${until}. This market does not move cleanly now.`,
          };

  const n = i.news;
  const newsCheck: GateCheck = !n
    ? {
        id: "news",
        title: "US news",
        state: "warn",
        detail: "Live feed unreachable. Check a live calendar before trading.",
      }
    : n.state === "blocked"
      ? {
          id: "news",
          title: "US news",
          state: "fail",
          detail: `${n.block.event.name}: stand aside until ${hhmm(n.block.to)} IST (${n.minutesLeft} min).`,
        }
      : n.state === "soon"
        ? {
            id: "news",
            title: "US news",
            state: "warn",
            detail: `${n.block.event.name} window starts ${hhmm(n.block.from)} IST (${n.minutesAway} min). Be flat before it.`,
          }
        : {
            id: "news",
            title: "US news",
            state: "pass",
            detail: n.next
              ? `Clear. Next: ${n.next.event.name} at ${hhmm(n.next.event.time)} IST.`
              : "Clear. Nothing else in the feed.",
          };

  const lock = lockStatus(i.day);
  const lossesCheck: GateCheck = lock.locked
    ? { id: "losses", title: "Losses today", state: "fail", detail: lock.text }
    : {
        id: "losses",
        title: "Losses today",
        state: i.day.losses > 0 && i.day.losses >= LOCK_LOSSES - 1 ? "warn" : "pass",
        detail: `${i.day.losses} of ${LOCK_LOSSES} allowed losses, day ${i.day.pct >= 0 ? "+" : ""}${i.day.pct.toFixed(2)}% (stop at ${LOCK_DAY_PCT}%).`,
      };

  const need = i.day.lastResult === "loss" ? COOLDOWN_AFTER_LOSS_MIN : COOLDOWN_AFTER_WIN_MIN;
  const sinceClose = i.day.lastClose == null ? null : Math.floor((i.now - i.day.lastClose) / MIN);
  const sinceLoss = i.day.lastLoss == null ? null : Math.floor((i.now - i.day.lastLoss) / MIN);
  const cooldownCheck: GateCheck =
    sinceClose == null || sinceClose >= need
      ? {
          id: "cooldown",
          title: "Cooldown",
          state: "pass",
          detail:
            sinceLoss == null ? "No trade closed today." : `${sinceLoss} min since the last loss.`,
        }
      : {
          id: "cooldown",
          title: "Cooldown",
          state: "fail",
          detail: `Last trade closed ${sinceClose} min ago${i.day.lastResult === "loss" ? " (a loss)" : ""}. Wait ${need - sinceClose} more min.`,
        };

  const openCheck: GateCheck =
    i.openCount >= MAX_OPEN
      ? {
          id: "open",
          title: "One position, one account",
          state: "fail",
          detail: `${i.openCount} position open. Close it first. The same trade on a second account counts.`,
        }
      : {
          id: "open",
          title: "One position, one account",
          state: "pass",
          detail: `No open position. Limit is ${MAX_OPEN} across all accounts.`,
        };

  const checks = [windowCheck, newsCheck, lossesCheck, cooldownCheck, openCheck];
  const verdict: Verdict = checks.some((c) => c.state === "fail")
    ? "NO-GO"
    : checks.some((c) => c.state === "warn")
      ? "CAUTION"
      : "GO";
  return { verdict, checks };
}
