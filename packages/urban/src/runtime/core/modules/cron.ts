// A small, dependency-free 5-field crontab evaluator (ADR 0025 §2) — the schedule engine
// behind `cron` triggers. Specs are evaluated in **UTC**. Fields, in order:
//
//   minute (0-59)  hour (0-23)  day-of-month (1-31)  month (1-12)  day-of-week (0-6, 0=Sun)
//
// Each field supports `*`, a number, `a-b` ranges, `*/n` and `a-b/n` steps, and comma lists
// of any of those. Month and day-of-week also accept three-letter names (jan…dec, sun…sat).
// Day-of-month and day-of-week follow the standard cron rule: when **both** are restricted
// (neither is `*`), a day matches if it satisfies **either** field.

/** A parsed schedule: the allowed value set per field, plus whether dom/dow are wildcards. */
export interface CronSchedule {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** dom / dow were `*` (unrestricted) — controls the OR-vs-AND day rule. */
  domWildcard: boolean;
  dowWildcard: boolean;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DOWS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function nameToNumber(token: string, names: string[], offset: number): string {
  const i = names.indexOf(token.toLowerCase());
  return i >= 0 ? String(i + offset) : token;
}

/** Parse one field into the set of matching integers in [min,max]. */
function parseField(field: string, min: number, max: number, names?: string[]): Set<number> {
  const out = new Set<number>();
  for (const partRaw of field.split(",")) {
    const part = partRaw.trim();
    if (part === "") throw new Error(`cron: empty term in "${field}"`);
    let step = 1;
    let range = part;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      range = part.slice(0, slash);
      step = Number(part.slice(slash + 1));
      if (!Number.isInteger(step) || step <= 0) throw new Error(`cron: bad step in "${part}"`);
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else {
      const dash = range.indexOf("-", range.startsWith("-") ? 1 : 0);
      if (dash > 0) {
        lo = Number(names ? nameToNumber(range.slice(0, dash), names, min) : range.slice(0, dash));
        hi = Number(names ? nameToNumber(range.slice(dash + 1), names, min) : range.slice(dash + 1));
      } else {
        lo = hi = Number(names ? nameToNumber(range, names, min) : range);
      }
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`cron: value out of range [${min},${max}] in "${part}"`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Parse a 5-field crontab spec into a `CronSchedule`. Throws on a malformed spec. */
export function parseCron(spec: string): CronSchedule {
  const fields = spec.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron: expected 5 fields, got ${fields.length} in "${spec}"`);
  }
  const [min, hr, dom, mon, dow] = fields;
  // Normalise day-of-week 7 → 0 (both are Sunday in common cron dialects).
  const daysOfWeek = parseField(dow, 0, 7, DOWS);
  if (daysOfWeek.delete(7)) daysOfWeek.add(0);
  return {
    minutes: parseField(min, 0, 59),
    hours: parseField(hr, 0, 23),
    daysOfMonth: parseField(dom, 1, 31),
    months: parseField(mon, 1, 12, MONTHS),
    daysOfWeek,
    domWildcard: dom.trim() === "*",
    dowWildcard: dow.trim() === "*",
  };
}

/** Does `date` (read in UTC) match the schedule? */
export function cronMatches(s: CronSchedule, date: Date): boolean {
  if (!s.minutes.has(date.getUTCMinutes())) return false;
  if (!s.hours.has(date.getUTCHours())) return false;
  if (!s.months.has(date.getUTCMonth() + 1)) return false;
  const domHit = s.daysOfMonth.has(date.getUTCDate());
  const dowHit = s.daysOfWeek.has(date.getUTCDay());
  // Standard cron day rule: both restricted → OR; otherwise the restricted one(s) must hit.
  if (!s.domWildcard && !s.dowWildcard) return domHit || dowHit;
  if (!s.domWildcard) return domHit;
  if (!s.dowWildcard) return dowHit;
  return true;
}

/** Ceiling to the start of the next minute (UTC), so scheduling lands on minute boundaries. */
function nextMinute(after: Date): Date {
  const d = new Date(after.getTime());
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);
  return d;
}

/**
 * The first fire strictly after `after`. Scans minute-by-minute (UTC) up to a bounded
 * horizon; returns `undefined` if nothing matches within ~4 years (an impossible spec,
 * e.g. Feb 30). The bound keeps a pathological spec from spinning forever.
 */
export function nextCronFire(s: CronSchedule, after: Date): Date | undefined {
  let cur = nextMinute(after);
  const limit = 4 * 366 * 24 * 60; // minutes in ~4 years
  for (let i = 0; i < limit; i++) {
    if (cronMatches(s, cur)) return cur;
    cur = new Date(cur.getTime() + 60_000);
  }
  return undefined;
}

/**
 * The fire instants strictly between `after` and `until` (both exclusive on `after`,
 * inclusive on `until`). Used by the `onMissed` catch-up policy to enumerate fires that
 * were due while the app was down. Bounded to avoid unbounded output on a huge gap.
 */
export function cronFiresBetween(
  s: CronSchedule,
  after: Date,
  until: Date,
  max = 10_000,
): Date[] {
  const fires: Date[] = [];
  let next = nextCronFire(s, after);
  while (next && next.getTime() <= until.getTime() && fires.length < max) {
    fires.push(next);
    next = nextCronFire(s, next);
  }
  return fires;
}
