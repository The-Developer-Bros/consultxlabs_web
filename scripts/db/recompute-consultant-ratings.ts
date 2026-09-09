/**
 * #1300 — recompute every consultant's rating aggregates, and pin the run.
 *
 * NOT a backfill migration. It is ordinary application code calling the same
 * `recomputeConsultantRating` every review mutation calls, it is idempotent, it
 * is re-runnable, it touches no DDL, and nothing in the schema depends on it
 * having run. What it prevents is a visible gap: the score columns arrive
 * NULL/0, and NULL means "suppressed", so until this runs every consultant's
 * public score is hidden.
 *
 * It is now also a RECURRING job, not a one-off. With a recency term in the
 * weighting, a consultant who receives no new reviews still drifts, so
 * recompute-on-mutation is no longer sufficient on its own and
 * `ratingAggregatedAt` has become this job's work queue rather than a drift
 * audit. The half-life ships high enough to make that drift immaterial at
 * current volumes — see SCORE_HALF_LIFE_DAYS — but the job is what makes
 * lowering it a config change rather than a migration.
 *
 * ONE `ScoringSnapshot` is minted per run and every profile in the run
 * references it. Without that, the first profile in the walk is shrunk toward the
 * platform mean as it stood at the start and the last toward the mean as it stood
 * at the end, so two consultants' scores are not comparable and neither is
 * reproducible after the constants move.
 *
 * Serializable + retry per profile, matching the mutation paths — a review
 * landing mid-run must not lose-update the average this writes.
 *
 * Usage: `npm run db:recompute-ratings`
 *        `npm run db:recompute-ratings -- --dry-run`  report what would change
 */
import { Prisma } from "@prisma/client";

import prisma from "../../lib/prisma";
import {
  SCORING_PARAMS,
  computePlatformPriors,
  recomputeConsultantRating,
  type ScoringPriors,
} from "../../lib/reviews";
import { withSerializableRetry } from "../../lib/db/serializable-retry";

/**
 * The columns a run writes that are FUNCTIONS OF THE DATA, so the dry run can diff
 * them against what is stored.
 *
 * `recomputeConsultantRating` writes fourteen columns; these are the twelve whose
 * value is determined by the reviews. The two omitted ones are omitted on purpose:
 * `ratingAggregatedAt` is `now` on every run and `scoringSnapshotId` is the id of
 * the snapshot this run minted (null in a dry run), so either would report every
 * profile as changed and `wouldChange` would degrade to the profile count.
 *
 * `effectiveSampleOneToOne` and `effectiveSampleGroup` were the ones missing by
 * accident, and they were the ones that mattered: on the first run after these
 * columns ship every profile moves them from NULL to a number, so a dry run could
 * print `wouldChange: 0` for a run that would write every row — the wrong direction
 * for the pre-flight check on a manual step against production data.
 */
const SCORE_COLUMNS = {
  publishedRatingOneToOne: true,
  publishedRatingGroup: true,
  ratedClientsOneToOne: true,
  ratedEventsGroup: true,
  rawRatingOneToOne: true,
  rawRatingGroup: true,
  effectiveSampleOneToOne: true,
  effectiveSampleGroup: true,
  rating: true,
  publishedRating: true,
  ratingUnitCount: true,
  reviewCount: true,
} as const;

type StoredScore = Record<keyof typeof SCORE_COLUMNS, number | null>;

/**
 * Run the REAL scoring function and capture what it would have written.
 *
 * The previous dry run reimplemented the arithmetic, which made it a fourth copy
 * of the formula and therefore able to agree with a version of the code that no
 * longer existed. Reads go to the live client; the one write is swallowed.
 */
async function previewConsultantRating(
  consultantProfileId: string,
  run: { priors: ScoringPriors; snapshotId: string | null; now: Date },
): Promise<StoredScore> {
  let captured: StoredScore | null = null;
  const capturingTx = {
    consultantReview: prisma.consultantReview,
    scoringSnapshot: prisma.scoringSnapshot,
    consultantProfile: {
      update: async ({ data }: { data: StoredScore }) => {
        captured = data;
        return {};
      },
    },
  };
  await recomputeConsultantRating(
    capturingTx as never,
    consultantProfileId,
    run,
  );
  if (!captured) throw new Error("preview captured no write");
  return captured;
}

const differs = (a: StoredScore, b: StoredScore) =>
  (Object.keys(SCORE_COLUMNS) as (keyof typeof SCORE_COLUMNS)[]).some(
    (k) => a[k] !== b[k],
  );

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const now = new Date();

  // Measured over the whole corpus, once, before anything is written — so every
  // profile in this run is shrunk toward the same mean.
  const priors = await computePlatformPriors(prisma);

  // A dry run pins nothing: a run that invented its own priors must not leave a
  // snapshot claiming it produced the stored scores.
  const snapshot = dryRun
    ? null
    : await prisma.scoringSnapshot.create({
        data: { ...priors, ...SCORING_PARAMS, computedAt: now },
        select: { id: true },
      });

  const profiles = await prisma.consultantProfile.findMany({
    select: { id: true, ...SCORE_COLUMNS },
    orderBy: { id: "asc" },
  });

  const run = { priors, snapshotId: snapshot?.id ?? null, now };
  let done = 0;
  let wouldChange = 0;
  const failed: { id: string; error: string }[] = [];

  for (const { id, ...stored } of profiles) {
    try {
      if (dryRun) {
        const preview = await previewConsultantRating(id, run);
        if (differs(preview, stored as StoredScore)) wouldChange += 1;
        done += 1;
        continue;
      }
      await withSerializableRetry(() =>
        prisma.$transaction(
          async (tx) => recomputeConsultantRating(tx, id, run),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      );
      done += 1;
    } catch (error) {
      // One bad profile must not abandon the rest: a partial run that reports
      // which rows are still stale is far more useful than a crash that leaves
      // you guessing.
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
      priors,
      params: SCORING_PARAMS,
      snapshotId: snapshot?.id ?? null,
      ...(dryRun ? { inspected: done, wouldChange } : { recomputed: done }),
      failed,
      timestamp: now.toISOString(),
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
