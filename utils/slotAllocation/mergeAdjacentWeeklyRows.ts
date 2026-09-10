import type { DayOfWeek, Prisma } from "@prisma/client";
import type { Tx } from "@/lib/prisma";
import { MAX_DURATION_MINUTES } from "@/utils/timeSlotValidation";
import { weeklyRowLocalColumns } from "@/utils/schedule/weekly-projection";

/**
 * #1320 — availability is one row per contiguous published window.
 *
 * Consultants enter availability as free-text ranges, so "3:30–4:30" and
 * "4:30–5:30" landed as two 60-minute rows. The expert-page grid merged them
 * for display, but the booking generator and checkout validated against ONE
 * row, so a two-hour plan could never be booked inside a window the grid
 * promised. Merging on every save (and once, idempotently, for existing rows)
 * makes storage match the picture the customer sees; the generator and
 * checkout are fixed alongside so no surface depends on row boundaries.
 */

export interface WeeklyRowShape {
  startDay: DayOfWeek;
  endDay: DayOfWeek;
  startTimeUtc: number;
  endTimeUtc: number;
  utcOffsetMinutes?: number | null;
  /** #872 — the dual-written IANA zone, when the row carries one. */
  timezone?: string | null;
}

/**
 * Merge exactly-adjacent same-day rows (a.endTimeUtc === b.startTimeUtc on
 * the same day, same offset). Overnight rows and rows with different offsets
 * are left untouched — the overnight day-shift math is per row, and merging
 * across offsets would change the day a minute belongs to. Pure; stable
 * ordering by day then start.
 *
 * The fold stops at MAX_DURATION_MINUTES: `isValidTimeRange` rejects anything
 * longer, and the settings loader filters its rows through that validator, so
 * a thirteen-hour merged row would vanish from the form and the next save
 * would delete it. A fold that would cross the bound starts a new row.
 */
/** Same shape the overlap validators use: a row crossing midnight is overnight. */
function isOvernight(r: WeeklyRowShape): boolean {
  return r.startDay !== r.endDay || r.startTimeUtc > r.endTimeUtc;
}

export function mergeAdjacentWeeklyRows<T extends WeeklyRowShape>(
  rows: T[],
): T[] {
  const dayOrder: DayOfWeek[] = [
    "SUNDAY",
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
  ];
  const sorted = [...rows].sort(
    (a, b) =>
      dayOrder.indexOf(a.startDay) - dayOrder.indexOf(b.startDay) ||
      a.startTimeUtc - b.startTimeUtc,
  );
  const out: T[] = [];
  for (const row of sorted) {
    const prev = out[out.length - 1];
    const sameDay = row.startDay === row.endDay;
    const canMerge =
      prev !== undefined &&
      sameDay &&
      prev.startDay === prev.endDay &&
      prev.startDay === row.startDay &&
      !isOvernight(prev) &&
      !isOvernight(row) &&
      (prev.utcOffsetMinutes ?? 0) === (row.utcOffsetMinutes ?? 0) &&
      prev.endTimeUtc === row.startTimeUtc &&
      row.endTimeUtc - prev.startTimeUtc <= MAX_DURATION_MINUTES;
    if (canMerge) {
      out[out.length - 1] = { ...prev, endTimeUtc: row.endTimeUtc };
    } else {
      out.push({ ...row });
    }
  }
  return out;
}

/**
 * Rewrite one consultant's weekly rows as their merged form. No-op when
 * nothing is adjacent, so it is safe after every write path. Returns how many
 * rows were folded away. Runs inside the caller's transaction when given one.
 */
export async function coalesceConsultantWeeklyRows(
  db: Pick<Tx, "slotOfAvailabilityWeekly">,
  consultantProfileId: string,
): Promise<{ before: number; after: number }> {
  const rows = await db.slotOfAvailabilityWeekly.findMany({
    where: { consultantProfileId },
    select: {
      id: true,
      startDay: true,
      endDay: true,
      startTimeUtc: true,
      endTimeUtc: true,
      utcOffsetMinutes: true,
      timezone: true,
    },
  });
  const merged = mergeAdjacentWeeklyRows(rows);
  if (merged.length === rows.length) {
    return { before: rows.length, after: rows.length };
  }
  // #872 — this pass deletes and recreates every row, so the dual-written DST
  // columns have to be carried across or the next coalesce silently unwrites
  // them. They are recomputed rather than copied because a fold moves the
  // row's end. A row written before the dual-write has no zone to recompute
  // from and keeps its nulls.
  const data: Prisma.SlotOfAvailabilityWeeklyCreateManyInput[] = merged.map(
    (r) => ({
      consultantProfileId,
      startDay: r.startDay,
      endDay: r.endDay,
      startTimeUtc: r.startTimeUtc,
      endTimeUtc: r.endTimeUtc,
      utcOffsetMinutes: r.utcOffsetMinutes ?? 0,
      ...(r.timezone
        ? weeklyRowLocalColumns(r, r.timezone, r.utcOffsetMinutes ?? 0)
        : {}),
    }),
  );
  await db.slotOfAvailabilityWeekly.deleteMany({
    where: { consultantProfileId },
  });
  await db.slotOfAvailabilityWeekly.createMany({ data });
  return { before: rows.length, after: merged.length };
}

/**
 * After a single-row create/update: fold adjacent rows and return the row that
 * now covers the written window (its id changes when it was merged).
 *
 * `endDay` is part of the window because the minute comparison below is only a
 * containment test WITHIN one day pair: an overnight row stores
 * endTimeUtc < startTimeUtc, so a same-day row would otherwise satisfy
 * `startTimeUtc <= 1320 AND endTimeUtc >= 120` and answer for an edit that was
 * never its own. The ordering makes the answer deterministic either way.
 *
 * A miss throws rather than returning null: the fold only ever extends the row
 * holding the written window, so nothing covering it means the rewrite dropped
 * it. The caller's only alternative is to answer with the pre-coalesce row,
 * whose id this same transaction may have just deleted.
 */
export async function coalesceAndResolve<
  Db extends Pick<Tx, "slotOfAvailabilityWeekly">,
>(
  db: Db,
  consultantProfileId: string,
  window: {
    startDay: DayOfWeek;
    endDay: DayOfWeek;
    startTimeUtc: number;
    endTimeUtc: number;
  },
) {
  await coalesceConsultantWeeklyRows(db, consultantProfileId);
  const covering = await db.slotOfAvailabilityWeekly.findFirst({
    where: {
      consultantProfileId,
      startDay: window.startDay,
      endDay: window.endDay,
      startTimeUtc: { lte: window.startTimeUtc },
      endTimeUtc: { gte: window.endTimeUtc },
    },
    orderBy: [{ startTimeUtc: "asc" }, { id: "asc" }],
    include: {
      consultantProfile: {
        select: { id: true, user: { select: { name: true, email: true } } },
      },
    },
  });
  if (!covering) {
    throw new Error(
      `coalesceAndResolve: no weekly row covers the saved window for consultant ${consultantProfileId}`,
    );
  }
  return covering;
}

/**
 * #1320 — the CUSTOM twin of everything above. Custom rows are date-anchored
 * absolute instants and purely additive (there is no isAvailable / deletedAt
 * column, so a row is never a blackout), which makes the merge rule simpler
 * than the weekly one: no day, offset or overnight predicate is needed, only
 * the instants themselves.
 */
export interface CustomRowShape {
  startsAt: Date;
  endsAt: Date;
}

/** The weekly bound in the units custom rows are stored in. */
const MAX_DURATION_MS = MAX_DURATION_MINUTES * 60_000;

/**
 * Fold b into a when b starts exactly where a ends (exact adjacency, no
 * tolerance) or inside a (an overlap the bulk save paths already reject but
 * older rows can still carry), keeping the later end. Pure; stable ordering by
 * start.
 *
 * A fold that would push the surviving row past MAX_DURATION_MS starts a new
 * row instead, for the same reason as the weekly twin. A row already contained
 * in its predecessor still collapses: it extends nothing, so it cannot cross
 * the bound, and leaving it out is the whole point of the pass.
 */
export function mergeAdjacentCustomRows<T extends CustomRowShape>(
  rows: T[],
): T[] {
  const sorted = [...rows].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
  );
  const out: T[] = [];
  for (const row of sorted) {
    const prev = out[out.length - 1];
    if (prev !== undefined && row.startsAt.getTime() <= prev.endsAt.getTime()) {
      if (row.endsAt.getTime() <= prev.endsAt.getTime()) {
        continue;
      }
      if (row.endsAt.getTime() - prev.startsAt.getTime() <= MAX_DURATION_MS) {
        out[out.length - 1] = { ...prev, endsAt: row.endsAt };
        continue;
      }
    }
    out.push({ ...row });
  }
  return out;
}

/**
 * Rewrite one consultant's custom rows as their merged form. No-op when
 * nothing touches, so it is safe after every write path. Unlike the weekly
 * twin this keeps the surviving row's id — a booking names a custom row, so
 * re-creating every row would orphan ids that are still in flight.
 */
export async function coalesceConsultantCustomRows(
  db: Pick<Tx, "slotOfAvailabilityCustom">,
  consultantProfileId: string,
): Promise<{ before: number; after: number }> {
  const rows = await db.slotOfAvailabilityCustom.findMany({
    where: { consultantProfileId },
    select: { id: true, startsAt: true, endsAt: true },
  });
  const merged = mergeAdjacentCustomRows(rows);
  if (merged.length === rows.length) {
    return { before: rows.length, after: rows.length };
  }
  const survivors = new Map(merged.map((r) => [r.id, r]));
  const foldedIds = rows.filter((r) => !survivors.has(r.id)).map((r) => r.id);
  await db.slotOfAvailabilityCustom.deleteMany({
    where: { id: { in: foldedIds } },
  });
  for (const original of rows) {
    const survivor = survivors.get(original.id);
    if (survivor && survivor.endsAt.getTime() !== original.endsAt.getTime()) {
      await db.slotOfAvailabilityCustom.update({
        where: { id: original.id },
        data: { endsAt: survivor.endsAt },
      });
    }
  }
  return { before: rows.length, after: merged.length };
}

/**
 * After a single custom-row create/update: fold touching rows and return the
 * row that now covers the written window. A miss throws, for the reason the
 * weekly twin gives.
 */
export async function coalesceAndResolveCustom<
  Db extends Pick<Tx, "slotOfAvailabilityCustom">,
>(db: Db, consultantProfileId: string, window: CustomRowShape) {
  await coalesceConsultantCustomRows(db, consultantProfileId);
  const covering = await db.slotOfAvailabilityCustom.findFirst({
    where: {
      consultantProfileId,
      startsAt: { lte: window.startsAt },
      endsAt: { gte: window.endsAt },
    },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    include: {
      consultantProfile: {
        select: { id: true, user: { select: { name: true, email: true } } },
      },
    },
  });
  if (!covering) {
    throw new Error(
      `coalesceAndResolveCustom: no custom row covers the saved window for consultant ${consultantProfileId}`,
    );
  }
  return covering;
}
