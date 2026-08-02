import { test } from "node:test";
import assert from "node:assert/strict";
import { cronFiresBetween, cronMatches, nextCronFire, parseCron } from "./cron.ts";

const utc = (s: string) => new Date(s);

test("parseCron rejects malformed specs", () => {
  assert.throws(() => parseCron("* * * *"), /expected 5 fields/);
  assert.throws(() => parseCron("* * * * * *"), /expected 5 fields/);
  assert.throws(() => parseCron("60 * * * *"), /out of range/);
  assert.throws(() => parseCron("* 24 * * *"), /out of range/);
  assert.throws(() => parseCron("* * 0 * *"), /out of range/);
  assert.throws(() => parseCron("*/0 * * * *"), /bad step/);
  assert.throws(() => parseCron("5-3 * * * *"), /out of range/);
  assert.throws(() => parseCron("1,,2 * * * *"), /empty term/);
});

test("parseCron handles wildcards, lists, ranges, steps and names", () => {
  const daily = parseCron("0 6 * * *");
  assert.equal(daily.minutes.has(0), true);
  assert.equal(daily.hours.has(6), true);
  assert.equal(daily.domWildcard, true);
  assert.equal(daily.dowWildcard, true);

  const s = parseCron("*/15 9-17 1,15 jan-mar mon-fri");
  assert.deepEqual([...s.minutes].sort((a, b) => a - b), [0, 15, 30, 45]);
  assert.deepEqual([...s.hours].sort((a, b) => a - b), [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual([...s.daysOfMonth].sort((a, b) => a - b), [1, 15]);
  assert.deepEqual([...s.months].sort((a, b) => a - b), [1, 2, 3]);
  assert.deepEqual([...s.daysOfWeek].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.equal(s.domWildcard, false);
  assert.equal(s.dowWildcard, false);
});

test("day-of-week 7 normalises to 0 (Sunday)", () => {
  const s = parseCron("0 0 * * 7");
  assert.equal(s.daysOfWeek.has(0), true);
  assert.equal(s.daysOfWeek.has(7), false);
});

test("cronMatches evaluates in UTC on minute boundaries", () => {
  const s = parseCron("30 14 * * *");
  assert.equal(cronMatches(s, utc("2026-08-01T14:30:00Z")), true);
  assert.equal(cronMatches(s, utc("2026-08-01T14:31:00Z")), false);
  assert.equal(cronMatches(s, utc("2026-08-01T13:30:00Z")), false);
});

test("standard cron day rule: both dom+dow restricted → OR", () => {
  // 15th of the month OR any Monday.
  const s = parseCron("0 0 15 * 1");
  assert.equal(cronMatches(s, utc("2026-08-15T00:00:00Z")), true); // the 15th (a Saturday)
  assert.equal(cronMatches(s, utc("2026-08-17T00:00:00Z")), true); // a Monday
  assert.equal(cronMatches(s, utc("2026-08-18T00:00:00Z")), false); // Tuesday, not the 15th
});

test("only dom restricted → dow ignored (AND with wildcard)", () => {
  const s = parseCron("0 0 1 * *");
  assert.equal(cronMatches(s, utc("2026-08-01T00:00:00Z")), true);
  assert.equal(cronMatches(s, utc("2026-08-02T00:00:00Z")), false);
});

test("nextCronFire returns the first fire strictly after 'after'", () => {
  const s = parseCron("0 6 * * *");
  const next = nextCronFire(s, utc("2026-08-01T06:00:00Z"));
  assert.equal(next?.toISOString(), "2026-08-02T06:00:00.000Z"); // strictly after, so next day
  const next2 = nextCronFire(s, utc("2026-08-01T05:59:00Z"));
  assert.equal(next2?.toISOString(), "2026-08-01T06:00:00.000Z");
});

test("nextCronFire returns undefined for an impossible spec", () => {
  const s = parseCron("0 0 30 2 *"); // Feb 30 never exists
  assert.equal(nextCronFire(s, utc("2026-01-01T00:00:00Z")), undefined);
});

test("cronFiresBetween enumerates due fires in a window", () => {
  const s = parseCron("0 * * * *"); // top of every hour
  const fires = cronFiresBetween(
    s,
    utc("2026-08-01T00:15:00Z"),
    utc("2026-08-01T03:00:00Z"),
  );
  assert.deepEqual(
    fires.map((d) => d.toISOString()),
    [
      "2026-08-01T01:00:00.000Z",
      "2026-08-01T02:00:00.000Z",
      "2026-08-01T03:00:00.000Z",
    ],
  );
});
