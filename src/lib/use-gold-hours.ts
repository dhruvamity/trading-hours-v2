import { useEffect, useState } from "react";
import type { Bar } from "./day-filter";

// Hourly gold candles from Binance's public futures API, for regime-bot's quiet mode:
// it needs the daily range of the last 60 complete sessions, plus a run-in for its on/off buffer.

const API = "https://fapi.binance.com/fapi/v1/klines";
const SYMBOL = "XAUUSDT";
const BAR_MS = 3_600_000;
const HISTORY_BARS = 160 * 24;
const PAGE = 1500;

export type GoldHours = { bars: Bar[]; status: "loading" | "ok" | "error" };

async function fetchBars(startTime: number, limit: number): Promise<Bar[]> {
  const res = await fetch(
    `${API}?symbol=${SYMBOL}&interval=1h&startTime=${startTime}&limit=${limit}`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) throw new Error(String(res.status));
  const rows = (await res.json()) as [number, string, string, string, string][];
  return rows.map(
    (r) =>
      [r[0], Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4])] as const,
  );
}

/** About 160 days of 1h candles, reloaded every `pollMs` (the mode only changes once a session closes). */
export function useGoldHours(pollMs = 10 * 60_000): GoldHours {
  const [state, setState] = useState<GoldHours>({
    bars: [],
    status: "loading",
  });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const start =
          Math.floor(Date.now() / BAR_MS) * BAR_MS - HISTORY_BARS * BAR_MS;
        const pages = Array.from(
          { length: Math.ceil(HISTORY_BARS / PAGE) },
          (_, i) => fetchBars(start + i * PAGE * BAR_MS, PAGE),
        );
        const byTime = new Map(
          (await Promise.all(pages)).flat().map((b) => [b[0], b]),
        );
        const bars = [...byTime.values()].sort((a, b) => a[0] - b[0]);
        if (alive) setState({ bars, status: "ok" });
      } catch {
        if (alive) setState((old) => ({ ...old, status: "error" }));
      }
    };
    void load();
    const timer = window.setInterval(load, pollMs);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [pollMs]);
  return state;
}
