import { createFileRoute } from "@tanstack/react-router";
import { NEWS_FEED_URLS, mergeFeeds, parseFeed, type LiveEvent } from "@/lib/news-feed";

// Server route: the public calendar feed can't be read straight from the browser (no CORS),
// so the server fetches it, keeps only the US High/Medium releases and lets the edge cache it.

async function pull(url: string): Promise<LiveEvent[] | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    // next week's file only exists late in the week; a 404 is normal, not an error
    return res.ok ? parseFeed(await res.json()) : null;
  } catch {
    return null;
  }
}

// The feed rate-limits repeat callers, so each server instance keeps one copy for a minute
// and falls back to the last good copy (marked stale) if the feed stops answering.
let cache: { at: number; events: LiveEvent[] } | null = null;
const TTL_MS = 60_000;

export const Route = createFileRoute("/api/news")({
  server: {
    handlers: {
      GET: async () => {
        const now = Date.now();
        if (cache && now - cache.at < TTL_MS) {
          return Response.json({ events: cache.events, fetchedAt: cache.at, stale: false });
        }
        const [thisWeek, nextWeek] = await Promise.all(NEWS_FEED_URLS.map(pull));
        if (thisWeek) {
          cache = { at: now, events: mergeFeeds([thisWeek, nextWeek ?? []]) };
          return Response.json({ events: cache.events, fetchedAt: cache.at, stale: false });
        }
        if (cache) return Response.json({ events: cache.events, fetchedAt: cache.at, stale: true });
        return Response.json({ error: "News feed unreachable" }, { status: 502 });
      },
    },
  },
});
