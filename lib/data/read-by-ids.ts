/**
 * Guard for reads keyed on a derived id list.
 *
 * Prisma renders an empty `in` as `WHERE id IN (NULL)` and still round-trips —
 * a guaranteed-empty result bought at the price of a real query, plus one
 * follow-up SELECT per nested relation in the include graph. Sentry
 * FAMILIARISE_WEB-G caught the consultant Home paying 4,624ms for nine of them
 * because a consultant had nothing upcoming.
 *
 * Note where that time goes, because it is not the SQL: the selects run in
 * 63-68ms once a connection is warm, and the bulk is pg-pool.connect plus the
 * first query queued behind it — the PG_POOL_MAX=1 serialisation of #1117. So
 * statement count is the lever, and not issuing the statement is the cheapest
 * way to pull it. (#1121)
 */
export function readByIds<T>(
  ids: readonly string[],
  read: () => Promise<T[]>,
): Promise<T[]> {
  return ids.length > 0 ? read() : Promise.resolve([]);
}
