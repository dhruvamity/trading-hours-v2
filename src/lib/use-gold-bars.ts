import { useEffect, useState } from "react";
import type { Bar } from "./day-filter";

// Live 5-minute gold candles straight from Binance's public futures API (it allows browser calls).
// The day filter needs about a month of them: 20 sessions for the norm, plus last week.

const API = "https://fapi.binance.com/fapi/v1/klines";
const SYMBOL = "XAUUSDT";
const BAR_MS = 5 * 60_000;
const HISTORY_DAYS = 33;
const PAGE = 1500; // bars per request, the API maximum
const HISTORY_BARS = (HISTORY_DAYS * 86_400_000) / BAR_MS;

export type GoldBars = {
  bars: Bar[];
  status: "loading" | "ok" | "error";
  fetchedAt: number | null;
};

async function fetchBars(startTime: number, limit: number): Promise<Bar[]> {
  const res = await fetch(
    `${API}?symbol=${SYMBOL}&interval=5m&startTime=${startTime}&limit=${limit}`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) throw new Error(String(res.status));
  const rows = (await res.json()) as [number, string, string, string, string][];
  return rows.map((r) => [r[0], Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4])] as const);
}

/** Newer copies of a candle replace older ones (the last one is still forming when fetched). */
function merge(old: Bar[], fresh: Bar[]): Bar[] {
  const byTime = new Map(old.map((b) => [b[0], b]));
  for (const b of fresh) byTime.set(b[0], b);
  return [...byTime.values()].sort((a, b) => a[0] - b[0]).slice(-HISTORY_BARS);
}

/** About a month of 5m candles, topped up every `pollMs`. Includes the candle still forming. */
export function useGoldBars(pollMs = 30_000): GoldBars {
  const [state, setState] = useState<GoldBars>({ bars: [], status: "loading", fetchedAt: null });
  useEffect(() => {
    let alive = true;
    let bars: Bar[] = [];
    const load = async () => {
      try {
        if (bars.length === 0) {
          const start = Math.floor(Date.now() / BAR_MS) * BAR_MS - HISTORY_BARS * BAR_MS;
          const pages = Array.from({ length: Math.ceil(HISTORY_BARS / PAGE) }, (_, i) =>
            fetchBars(start + i * PAGE * BAR_MS, PAGE),
          );
          bars = merge([], (await Promise.all(pages)).flat());
        } else {
          bars = merge(bars, await fetchBars(bars[bars.length - 1]![0] - 2 * BAR_MS, PAGE));
        }
        if (alive) setState({ bars, status: "ok", fetchedAt: Date.now() });
      } catch {
        // keep the last good candles on screen, but say the feed is down
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
