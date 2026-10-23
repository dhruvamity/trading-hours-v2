/**
 * Forex-session clock based on BabyPips' published local session hours.
 *
 * Sessions are defined in their home time zones so browser Intl data applies
 * daylight-saving changes automatically (including the short US/UK mismatch
 * periods). All returned timestamps are real instants, displayed by the UI in
 * IST.
 */

export const FOREX_SOURCE_URL = "https://www.babypips.com/tools/forex-market-hours";

export const FOREX_SESSIONS = [
  {
    id: "sydney",
    name: "Sydney",
    timeZone: "Australia/Sydney",
    localHours: "07:00 — 16:00",
    startHour: 7,
    endHour: 16,
    color: "bg-status-small",
  },
  {
    id: "tokyo",
    name: "Tokyo",
    timeZone: "Asia/Tokyo",
    localHours: "09:00 — 18:00",
    startHour: 9,
    endHour: 18,
    color: "bg-status-swing",
  },
  {
    id: "london",
    name: "London",
    timeZone: "Europe/London",
    localHours: "08:00 — 17:00",
    startHour: 8,
    endHour: 17,
    color: "bg-status-prime",
  },
  {
    id: "new-york",
    name: "New York",
    timeZone: "America/New_York",
    localHours: "08:00 — 17:00",
    startHour: 8,
    endHour: 17,
    color: "bg-status-stop",
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
