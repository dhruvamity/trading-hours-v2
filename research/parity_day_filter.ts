// Checks that src/lib/day-filter.ts reproduces research/day_filter.py's live() on the same bars.
//   python3 research/day_filter.py && bun research/parity_day_filter.ts
import { readFileSync } from "node:fs";
import { DAY_FILTER } from "../src/lib/day-filter.generated";
import { readFilter, type Bar } from "../src/lib/day-filter";

type Case = { bars: Bar[] | null; now: number; stop: number; expected: Record<string, unknown> };
const fixture = JSON.parse(
  readFileSync(new URL("./output/day_filter_fixture.json", import.meta.url), "utf8"),
) as { model: Record<string, unknown>; cases: Case[] };

const TOLERANCE = 1e-9;
let checked = 0;
const problems: string[] = [];

function compare(path: string, want: unknown, got: unknown) {
  if (want === null || typeof want !== "object") {
    checked += 1;
    const same =
      typeof want === "number" && typeof got === "number"
        ? Math.abs(want - got) <= TOLERANCE * Math.max(1, Math.abs(want))
        : want === got;
    if (!same)
      problems.push(`${path}: python ${JSON.stringify(want)} vs ts ${JSON.stringify(got)}`);
    return;
  }
  if (got === null || typeof got !== "object") {
    problems.push(`${path}: python has an object, ts has ${JSON.stringify(got)}`);
    return;
  }
  for (const [key, value] of Object.entries(want))
    compare(`${path}.${key}`, value, (got as Record<string, unknown>)[key]);
}

// the page must be running on the model the fixture was made with
for (const key of ["now", "tonight", "calib"] as const)
  if (JSON.stringify(fixture.model[key]) !== JSON.stringify(DAY_FILTER[key]))
    problems.push(`model.${key} differs: re-run research/day_filter.py`);

const ist = (ms: number) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));

let bars: Bar[] = [];
for (const [index, c] of fixture.cases.entries()) {
  if (c.bars) bars = c.bars;
  const before = problems.length;
  const got = readFilter(bars, c.now, c.stop);
  compare(`case ${index}`, c.expected, got);
  const e = c.expected as {
    slot: number;
    now: { verdict: string } | null;
    tonight: { verdict: string } | null;
  };
  console.log(
    `${problems.length === before ? "ok  " : "FAIL"} ${ist(c.now)} IST  stop $${c.stop}  slot ${String(e.slot).padStart(3)}  now ${e.now?.verdict ?? "-"}  tonight ${e.tonight?.verdict ?? "-"}`,
  );
}

console.log(`\n${checked} values compared, ${problems.length} differ`);
for (const p of problems.slice(0, 40)) console.log("  " + p);
process.exit(problems.length ? 1 : 0);
