import { useEffect, useState } from "react";
import type { LiveEvent } from "./news-feed";

export type NewsFeed = {
  events: LiveEvent[];
  fetchedAt: number | null;
  ok: boolean;
  loading: boolean;
};

/** Live US releases from /api/news, refreshed every minute. */
export function useNews(pollMs = 60_000): NewsFeed {
  const [feed, setFeed] = useState<NewsFeed>({
    events: [],
    fetchedAt: null,
    ok: false,
    loading: true,
  });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/news");
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as { events: LiveEvent[]; fetchedAt: number };
        if (alive)
          setFeed({ events: json.events, fetchedAt: json.fetchedAt, ok: true, loading: false });
      } catch {
        // keep the last good events on screen, but say the feed is down
        if (alive) setFeed((old) => ({ ...old, ok: false, loading: false }));
      }
    };
    void load();
    const timer = window.setInterval(load, pollMs);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [pollMs]);
  return feed;
}
