/**
 * Postgres error predicates — structured SQLSTATE detection, not message sniffing.
 *
 * Classifying a database error by substring-matching its human-readable message
 * is fragile (wording changes, i18n, refactors) and is the anti-pattern these
 * helpers exist to replace. Prefer the structured signal: Prisma's `code`
 * (e.g. P2002) for modelled constraints, and the underlying Postgres SQLSTATE in
 * `meta.code` for raw-query paths (P2010).
 *
 * Exclusion constraints are the one unavoidable exception. Prisma has a
 * documented gap (prisma/prisma#25562, #26366): a violation of a constraint it
 * does not model — like the `slot_no_confirmed_overlap` btree_gist EXCLUDE that
 * lives in the raw-SQL sidecar — surfaces as a `PrismaClientUnknownRequestError`
 * with no `.code` and an undefined `.cause`. The SQLSTATE is then only present in
 * the message text, so a NARROW text probe (the SQLSTATE token and the constraint
 * name) is the only signal available. That heuristic is quarantined here, behind
 * a structured check and a name, rather than scattered through business logic.
 */

type MaybePgError = {
  code?: unknown;
  meta?: { code?: unknown };
  message?: unknown;
};

/** The Postgres SQLSTATE, when Prisma exposes it structurally (raw-query/P2010). */
function sqlState(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as MaybePgError).meta?.code;
  return typeof code === "string" ? code : undefined;
}

function message(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const m = (error as MaybePgError).message;
  return typeof m === "string" ? m : "";
}

/** Postgres 23505 / Prisma P2002 — unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ((error as MaybePgError).code === "P2002") return true;
  return sqlState(error) === "23505";
}

/**
 * Postgres 23P01 — exclusion-constraint violation (e.g. `slot_no_confirmed_overlap`).
 * Structured SQLSTATE first; narrow text probe second, only for Prisma's
 * unmodelled-constraint gap (see the module note).
 */
export function isExclusionViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (sqlState(error) === "23P01") return true;
  const msg = message(error);
  return msg.includes("23P01") || msg.includes("slot_no_confirmed_overlap");
}
