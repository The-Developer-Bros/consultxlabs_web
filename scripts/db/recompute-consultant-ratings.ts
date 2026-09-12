/**
 * #1300 — recompute every consultant's rating aggregates.
 *
 * Not a backfill migration: it calls the same `recomputeConsultantRating` every
 * review mutation calls, is idempotent, touches no DDL, and nothing in the schema
 * depends on it having run. Until it runs after a push the new score columns are
 * NULL, which renders as "suppressed". docs/reviews/02-two-track-scoring.md
 * explains the run; nothing schedules it, because a score only moves on a review mutation (#1566).
 *
 * Usage: `npm run db:recompute-ratings`
 *        `npm run db:recompute-ratings -- --dry-run`  report what would change
 */
import prisma from "../../lib/prisma";
import { recomputeAllConsultantRatings } from "../../lib/reviews-recompute";

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const { wouldChange, recomputed, ...result } =
    await recomputeAllConsultantRatings({ dryRun });

  console.log(
    JSON.stringify({
      event: dryRun ? "rating_recompute_dry_run" : "rating_recompute_complete",
      ...result,
      ...(dryRun
        ? { inspected: result.profiles - result.failed.length, wouldChange }
        : { recomputed }),
    }),
  );
  if (result.failed.length > 0) process.exit(1);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
