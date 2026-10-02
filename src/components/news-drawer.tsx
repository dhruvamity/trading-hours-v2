import { useState } from "react";
import { Newspaper, X } from "lucide-react";
import { formatCountdown } from "@/lib/format";
import type { NewsFeed } from "@/lib/use-news";

const dayLabel = (ms: number) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "2-digit",
    month: "short",
  }).format(new Date(ms));
const hhmm = (ms: number) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
const tone = ["", "text-status-stop", "text-status-small"];

/** Floating tab on the right edge: collapsed by default, opens a list of the next releases. */
export function NewsDrawer({ feed, now }: { feed: NewsFeed; now: Date | null }) {
  const [open, setOpen] = useState(false);
  if (!now) return null;
  const t = now.getTime();
  const events = feed.events.filter((e) => e.tier <= 2 && e.time > t - 30 * 60_000).slice(0, 12);
  const today = events.filter((e) => dayLabel(e.time) === dayLabel(t)).length;

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed right-0 top-1/3 z-40 flex items-center gap-2 border border-r-0 border-border bg-panel px-3 py-3 text-sm font-bold shadow-lg"
          aria-label="Open news list"
        >
          <Newspaper className="size-4" aria-hidden="true" />
          News{today > 0 && <span className="bg-status-stop px-1.5 text-background">{today}</span>}
        </button>
      )}
      {open && (
        <aside
          className="fixed right-0 top-0 z-40 flex h-full w-80 max-w-[90vw] flex-col border-l border-border bg-panel shadow-2xl"
          aria-label="Upcoming US news"
        >
          <div className="flex items-center justify-between border-b border-border p-4">
            <p className="terminal-label">Next US releases · IST</p>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close news list"
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="size-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {events.length === 0 ? (
              <p className="text-base text-muted-foreground">
                {feed.ok || feed.loading
                  ? "Nothing scheduled."
                  : "Feed unreachable. Check a live calendar."}
              </p>
            ) : (
              <ul className="divide-y divide-border/60">
                {events.map((e) => (
                  <li key={`${e.time}-${e.name}`} className="py-2.5">
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="text-muted-foreground">
                        {dayLabel(e.time)} ·{" "}
                        <span className="font-semibold text-foreground tabular-nums">
                          {hhmm(e.time)}
                        </span>
                      </span>
                      <span className="tabular-nums text-muted-foreground">
                        {e.time > t
                          ? `in ${formatCountdown((e.time - t) / 60_000).replace(/:\d\d$/, "")}`
                          : "now"}
                      </span>
                    </div>
                    <p className={`mt-0.5 text-base font-semibold ${tone[e.tier]}`}>{e.name}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      )}
    </>
  );
}
