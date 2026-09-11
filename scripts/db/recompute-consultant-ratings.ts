/**
 * #705 — recompute every consultant's rating aggregates once, after the push
 * that adds `publishedRating`, `ratingUnitCount` and `reviewCount`.
 *
 * NOT a backfill migration. It is ordinary application code calling the same
 * `recomputeConsultantRating` every review mutation calls, it is idempotent,
 * it is re-runnable, it touches no DDL, and nothing in the schema depends on it
 * having run. What it prevents is a visible gap: those columns arrive NULL/0,
 * and NULL means "suppressed", so until this runs every consultant's public
 * score is hidden.
 *
 * Serializable + retry per profile, matching the mutation paths — a review
 * landing mid-run must not lose-update the average this writes.
 *
 * Usage: `npx tsx -r dotenv/config scripts/db/recompute-consultant-ratings.ts`
 *        add `--dry-run` to report how many profiles would change, without
 *        writing anything.
 */
import { Prisma } from "@prisma/client";

import prisma from "../../lib/prisma";
import {
  MIN_RATED_UNITS_FOR_PUBLIC_SCORE,
  recomputeConsultantRating,
} from "../../lib/reviews";
import { withSerializableRetry } from "../../lib/db/serializable-retry";

/**
 * The same arithmetic `recomputeConsultantRating` performs, without the write —
 * so `--dry-run` can say which profiles a real run would actually move.
 */
async function previewConsultantRating(consultantProfileId: string) {
  const [units, legacy] = await Promise.all([
    prisma.consultantReview.groupBy({
      by: ["ratingUnitId"],
      where: {
        consultantProfileId,
        deletedAt: null,
        ratingUnitId: { not: null },
      },
      _avg: { rating: true },
      _count: { _all: true },
    }),
    prisma.consultantReview.aggregate({
      where: { consultantProfileId, deletedAt: null, ratingUnitId: null },
      _avg: { rating: true },
      _count: { _all: true },
    }),
  ]);
  const legacyCount = legacy._count._all;
  const unitSum =
    units.reduce((sum, u) => sum + (u._avg.rating ?? 0), 0) +
    (legacy._avg.rating ?? 0) * legacyCount;
  const ratingUnitCount = units.length + legacyCount;
  const mean = ratingUnitCount
    ? Math.round((unitSum / ratingUnitCount) * 100) / 100
    : 0;
  return {
    rating: mean,
    ratingUnitCount,
    reviewCount: units.reduce((sum, u) => sum + u._count._all, 0) + legacyCount,
    publishedRating:
      ratingUnitCount >= MIN_RATED_UNITS_FOR_PUBLIC_SCORE ? mean : null,
  };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const profiles = await prisma.consultantProfile.findMany({
    // Every aggregate the real run writes, so the dry run cannot report "no
    // change" for a profile whose review count moved without crossing the
    // publish threshold.
    select: {
      id: true,
      rating: true,
      publishedRating: true,
      ratingUnitCount: true,
      reviewCount: true,
    },
    orderBy: { id: "asc" },
  });

  let done = 0;
  let wouldChange = 0;
  const failed: { id: string; error: string }[] = [];

  for (const { id, ...stored } of profiles) {
    if (dryRun) {
      // Actually report what a real run would do. Counting rows and calling it
      // "recomputed" made the dry run useless as a pre-flight check on a shared
      // database, which is the only reason it exists.
      const preview = await previewConsultantRating(id);
      if (
        preview.rating !== stored.rating ||
        preview.publishedRating !== stored.publishedRating ||
        preview.ratingUnitCount !== stored.ratingUnitCount ||
        preview.reviewCount !== stored.reviewCount
      ) {
        wouldChange += 1;
      }
      done += 1;
      continue;
    }
    try {
      await withSerializableRetry(() =>
        prisma.$transaction(async (tx) => recomputeConsultantRating(tx, id), {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        }),
      );
      done += 1;
    } catch (error) {
      // One bad profile must not abandon the other eighty-two: a partial run
      // that reports which rows are still stale is far more useful than a
      // crash that leaves you guessing.
      failed.push({
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.log(
    JSON.stringify({
      event: dryRun ? "rating_recompute_dry_run" : "rating_recompute_complete",
      profiles: profiles.length,
      ...(dryRun ? { inspected: done, wouldChange } : { recomputed: done }),
      failed,
      timestamp: new Date().toISOString(),
    }),
  );
  if (failed.length > 0) process.exit(1);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
