import { useCallback, useEffect, useState } from "react";
import type { TradeEntry } from "./discipline";

// Everything is stored in this browser (localStorage): no account, no server, nothing to keep running.

export type JournalDay = {
  date: string;
  mood?: 1 | 2 | 3 | 4 | 5;
  plan: string;
  review: string;
  lesson: string;
  lockedAt?: number;
  lockReason?: string;
  notes: Record<string, string>;
};

const TRADES_KEY = "th-trades-v1";
const JOURNAL_KEY = "th-journal-v1";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private window or storage full: the page still works for this visit
  }
}

/** One localStorage value as React state, kept in sync across tabs. `ready` is false until it has loaded. */
function useStored<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(fallback);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setValue(read(key, fallback));
    setReady(true);
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) setValue(read(key, fallback));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
    // fallback is a constant at every call site
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const update = useCallback(
    (fn: (old: T) => T) => {
      setValue((old) => {
        const next = fn(old);
        write(key, next);
        return next;
      });
    },
    [key],
  );
  return [value, update, ready] as const;
}

const NO_TRADES: TradeEntry[] = [];
const NO_DAYS: Record<string, JournalDay> = {};

export const useTrades = () => useStored<TradeEntry[]>(TRADES_KEY, NO_TRADES);
export const useJournal = () => useStored<Record<string, JournalDay>>(JOURNAL_KEY, NO_DAYS);

export const emptyDay = (date: string): JournalDay => ({
  date,
  plan: "",
  review: "",
  lesson: "",
  notes: {},
});
export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
