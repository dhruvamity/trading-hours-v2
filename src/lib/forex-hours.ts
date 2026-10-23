/**
 * Forex-session clock based on BabyPips' published local session hours.
 *
 * Sessions are defined in their home time zones so browser Intl data applies
 * daylight-saving changes automatically (including the short US/UK mismatch
 * periods). All returned timestamps are real instants, displayed by the UI in
 * IST.
 */

import type { Day, Status } from "./timetable";

export const FOREX_SOURCE_URL = "https://www.babypips.com/tools/forex-market-hours";

export const FOREX_SESSIONS = [
  {
    id: "sydney",
    name: "Sydney",
    code: "SYD",
    timeZone: "Australia/Sydney",
    localHours: "07:00 — 16:00",
    startHour: 7,
    endHour: 16,
  },
  {
    id: "tokyo",
    name: "Tokyo",
    code: "TYO",
    timeZone: "Asia/Tokyo",
    localHours: "09:00 — 18:00",
    startHour: 9,
    endHour: 18,
  },
  {
    id: "london",
    name: "London",
    code: "LDN",
    timeZone: "Europe/London",
    localHours: "08:00 — 17:00",
    startHour: 8,
    endHour: 17,
  },
  {
    id: "new-york",
    name: "New York",
    code: "NYC",
    timeZone: "America/New_York",
    localHours: "08:00 — 17:00",
    startHour: 8,
    endHour: 17,
  },
] as const;

export type ForexSession = (typeof FOREX_SESSIONS)[number];

export type ForexSessionSegment = {
  session: ForexSession;
  start: Date;
  end: Date;
};

type DateParts = { year: number; month: number; day: number };

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function zonedParts(date: Date, timeZone: string): DateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
  };
}

function zoneOffsetMs(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return (
    Date.UTC(
      value("year"),
      value("month") - 1,
      value("day"),
      value("hour"),
      value("minute"),
      value("second"),
    ) - date.getTime()
  );
}

/** Converts a wall-clock time in `timeZone` into an instant. Session boundaries
 * are well away from DST transition hours, but two passes keep this stable. */
function fromZonedWallTime(date: DateParts, hour: number, timeZone: string) {
  const wall = Date.UTC(date.year, date.month - 1, date.day, hour);
  let instant = wall;
  for (let i = 0; i < 2; i += 1) instant = wall - zoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

function shiftDate(date: DateParts, days: number): DateParts {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

export function istDateKey(date: Date) {
  const p = zonedParts(date, "Asia/Kolkata");
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function istDayBounds(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const start = new Date(Date.UTC(year!, month! - 1, day!) - IST_OFFSET_MS);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/** Session segments that overlap the supplied IST calendar day. */
export function forexSessionsForIstDate(dateKey: string): ForexSessionSegment[] {
  const { start: dayStart, end: dayEnd } = istDayBounds(dateKey);
  const output: ForexSessionSegment[] = [];

  for (const session of FOREX_SESSIONS) {
    const localAnchor = zonedParts(
      new Date(dayStart.getTime() + 12 * 60 * 60 * 1000),
      session.timeZone,
    );
    for (const offset of [-1, 0, 1]) {
      const localDay = shiftDate(localAnchor, offset);
      const localWeekday = new Date(
        Date.UTC(localDay.year, localDay.month - 1, localDay.day),
      ).getUTCDay();
      if (localWeekday === 0 || localWeekday === 6) continue;

      const start = fromZonedWallTime(localDay, session.startHour, session.timeZone);
      const end = fromZonedWallTime(localDay, session.endHour, session.timeZone);
      if (end > dayStart && start < dayEnd) {
        output.push({
          session,
          start: new Date(Math.max(start.getTime(), dayStart.getTime())),
          end: new Date(Math.min(end.getTime(), dayEnd.getTime())),
        });
      }
    }
  }

  return output.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Retail forex is available from Sunday 17:00 through Friday 17:00 New York time. */
export function isForexMarketOpen(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = value("weekday");
  const minutes = Number(value("hour")) * 60 + Number(value("minute"));
  if (weekday === "Sat") return false;
  if (weekday === "Sun") return minutes >= 17 * 60;
  if (weekday === "Fri") return minutes < 17 * 60;
  return true;
}

export function activeForexSessions(date: Date) {
  return FOREX_SESSIONS.filter((session) => {
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone: session.timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const value = (type: string) => p.find((part) => part.type === type)?.value ?? "";
    const weekday = value("weekday");
    const minutes = Number(value("hour")) * 60 + Number(value("minute"));
    return (
      weekday !== "Sat" &&
      weekday !== "Sun" &&
      minutes >= session.startHour * 60 &&
      minutes < session.endHour * 60
    );
  });
}

export type ForexWindow = {
  start: string;
  end: string;
  status: Status;
  score: number | null;
  label: string;
  activeSessions: ForexSession[];
};

export type ForexDaySchedule = {
  windows: ForexWindow[];
  profile: (number | null)[];
  profileStatuses: Status[];
};

export function evaluateForexInstant(date: Date): {
  status: Status;
  score: number | null;
  label: string;
  activeSessions: ForexSession[];
} {
  const open = isForexMarketOpen(date);
  if (!open) {
    return {
      status: "CLOSED",
      score: null,
      label: "Market closed",
      activeSessions: [],
    };
  }

  const active = activeForexSessions(date);
  const ids = new Set(active.map((s) => s.id));

  if (ids.has("london") && ids.has("new-york")) {
    return {
      status: "PRIME",
      score: 2.15,
      label: "London + NY overlap",
      activeSessions: active,
    };
  }
  if (ids.has("london")) {
    if (ids.has("tokyo")) {
      return {
        status: "SWING ENTRY",
        score: 1.55,
        label: "Tokyo + London crossover",
        activeSessions: active,
      };
    }
    return {
      status: "SWING ENTRY",
      score: 1.7,
      label: "London main session",
      activeSessions: active,
    };
  }
  if (ids.has("new-york")) {
    return {
      status: "SMALL TRADES",
      score: 1.2,
      label: "New York session",
      activeSessions: active,
    };
  }
  if (ids.has("tokyo")) {
    if (ids.has("sydney")) {
      return {
        status: "SMALL TRADES",
        score: 1.1,
        label: "Tokyo + Sydney overlap",
        activeSessions: active,
      };
    }
    return {
      status: "NO TRADE",
      score: 0.85,
      label: "Tokyo session",
      activeSessions: active,
    };
  }
  if (ids.has("sydney")) {
    return {
      status: "NO TRADE",
      score: 0.65,
      label: "Sydney session",
      activeSessions: active,
    };
  }
  return {
    status: "NO TRADE",
    score: 0.45,
    label: "Inter-session transition",
    activeSessions: active,
  };
}

/** Computes the 24-hour composite Forex windows and 48 half-hour profile for an IST date. */
export function forexScheduleForIstDate(dateKey: string): ForexDaySchedule {
  const { start: dayStart } = istDayBounds(dateKey);

  // 48 profile half-hours across the day (at midpoint of each 30m)
  const profile: (number | null)[] = [];
  const profileStatuses: Status[] = [];
  for (let i = 0; i < 48; i += 1) {
    const midInstant = new Date(dayStart.getTime() + (i * 30 + 15) * 60 * 1000);
    const evalResult = evaluateForexInstant(midInstant);
    profile.push(evalResult.score);
    profileStatuses.push(evalResult.status);
  }

  // Windows evaluated in 5-minute increments and merged
  const windows: ForexWindow[] = [];
  let current: ForexWindow | null = null;

  for (let min = 0; min < 1440; min += 5) {
    const instant = new Date(dayStart.getTime() + min * 60 * 1000);
    const info = evaluateForexInstant(instant);
    const hh = String(Math.floor(min / 60)).padStart(2, "0");
    const mm = String(min % 60).padStart(2, "0");
    const timeStr = `${hh}:${mm}`;

    if (!current || current.status !== info.status || current.label !== info.label) {
      if (current) {
        current.end = timeStr;
        windows.push(current);
      }
      current = {
        start: timeStr,
        end: "24:00",
        status: info.status,
        score: info.score,
        label: info.label,
        activeSessions: info.activeSessions,
      };
    }
  }

  if (current) {
    current.end = "24:00";
    windows.push(current);
  }

  return { windows, profile, profileStatuses };
}

export type ForexTimelineWindow = ForexWindow & {
  day: Day;
  from: number;
  to: number;
};

const WEEK_MINUTES = 7 * 1440;

function toMinutesHelper(time: string) {
  if (time === "24:00") return 1440;
  const [hours = "0", minutes = "0"] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

const WEEK_DAYS: Day[] = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

export function forexWeekTimeline(now: Date): ForexTimelineWindow[] {
  const [year, month, day] = istDateKey(now).split("-").map(Number);
  const currentDay = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
  }).format(now) as Day;

  const out: ForexTimelineWindow[] = [];

  WEEK_DAYS.forEach((d, index) => {
    const offset = WEEK_DAYS.indexOf(d) - WEEK_DAYS.indexOf(currentDay);
    const dKey = new Date(Date.UTC(year!, month! - 1, day! + offset)).toISOString().slice(0, 10);
    const sched = forexScheduleForIstDate(dKey);
    for (const w of sched.windows) {
      const from = index * 1440 + toMinutesHelper(w.start);
      const to = index * 1440 + toMinutesHelper(w.end);
      const last = out[out.length - 1];
      if (last && last.status === w.status && last.label === w.label && last.to === from) {
        last.to = to;
      } else {
        out.push({ ...w, day: d, from, to });
      }
    }
  });

  return out;
}

export function locateForex(timeline: ForexTimelineWindow[], at: number) {
  const index = timeline.findIndex((w) => at >= w.from && at < w.to);
  const upcoming = (predicate: (w: ForexTimelineWindow) => boolean) => {
    for (let step = 1; step <= timeline.length; step += 1) {
      const w = timeline[(index + step) % timeline.length]!;
      if (predicate(w)) {
        const startsIn = (w.from - at + WEEK_MINUTES) % WEEK_MINUTES;
        return { window: w, startsIn };
      }
    }
    return undefined;
  };
  const current = index >= 0 ? timeline[index] : undefined;
  return {
    current,
    endsIn: current ? current.to - at : 0,
    next: upcoming(() => true),
    nextPrime: upcoming((w) => w.status === "PRIME"),
  };
}
