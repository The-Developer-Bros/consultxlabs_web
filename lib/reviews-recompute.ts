import { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";
import {
  SCORING_PARAMS,
  computePlatformPriors,
  recomputeConsultantRating,
  type ScoringPriors,
  type ScoringTx,
} from "@/lib/reviews";
import { withSerializableRetry } from "@/lib/db/serializable-retry";

/**
 * Recompute every consultant's rating aggregates under ONE `ScoringSnapshot`,
 * so every profile in the run is shrunk toward the same platform mean. Shared by
 * `npm run db:recompute-ratings` and the seed; see
 * docs/reviews/02-two-track-scoring.md for what a run does and why it is a
 * script rather than a migration.
 */

// The columns a run writes that are FUNCTIONS OF THE DATA, so a dry run can diff
// them against what is stored. `ratingAggregatedAt` and `scoringSnapshotId` are
// omitted on purpose: both change on every run, so either would report every
// profile as changed.
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

type Run = { priors: ScoringPriors; snapshotId: string | null; now: Date };

// Runs the REAL scoring function against a capturing transaction and returns
// what it would have written — never a second copy of the arithmetic.
async function previewConsultantRating(
  consultantProfileId: string,
  run: Run,
): Promise<StoredScore> {
  let captured: StoredScore | null = null;
  // Typed as ScoringTx so a delegate the scorer starts using is a compile error
  // here; only the one swallowed write is cast.
  const capturingTx: ScoringTx = {
    consultantReview: prisma.consultantReview,
    scoringSnapshot: prisma.scoringSnapshot,
    consultantProfile: {
      update: (async ({ data }: { data: StoredScore }) => {
        captured = data;
        return {};
      }) as unknown as ScoringTx["consultantProfile"]["update"],
    },
  };
  await recomputeConsultantRating(capturingTx, consultantProfileId, run);
  if (!captured) throw new Error("preview captured no write");
  return captured;
}

const differs = (a: StoredScore, b: StoredScore) =>
  (Object.keys(SCORE_COLUMNS) as (keyof typeof SCORE_COLUMNS)[]).some(
    (k) => a[k] !== b[k],
  );

export type RecomputeAllResult = {
  profiles: number;
  priors: ScoringPriors;
  params: typeof SCORING_PARAMS;
  snapshotId: string | null;
  recomputed: number;
  wouldChange: number;
  failed: { id: string; error: string }[];
  timestamp: string;
};

export async function recomputeAllConsultantRatings(
  options: {
    dryRun?: boolean;
    now?: Date;
  } = {},
): Promise<RecomputeAllResult> {
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? new Date();

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

  const run: Run = { priors, snapshotId: snapshot?.id ?? null, now };
  let recomputed = 0;
  let wouldChange = 0;
  const failed: { id: string; error: string }[] = [];

  for (const { id, ...stored } of profiles) {
    try {
      if (dryRun) {
        const preview = await previewConsultantRating(id, run);
        if (differs(preview, stored as StoredScore)) wouldChange += 1;
        continue;
      }
      // Serializable + retry, matching the mutation paths: a review landing
      // mid-run must not lose-update the average this writes.
      await withSerializableRetry(() =>
        prisma.$transaction(
          async (tx) => recomputeConsultantRating(tx, id, run),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      );
      recomputed += 1;
    } catch (error) {
      // One bad profile must not abandon the rest.
      failed.push({
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    profiles: profiles.length,
    priors,
    params: SCORING_PARAMS,
    snapshotId: snapshot?.id ?? null,
    recomputed,
    wouldChange,
    failed,
    timestamp: now.toISOString(),
  };
}
