import { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";
import { recomputeConsultantRating, type ScoringTx } from "@/lib/reviews";
import { withSerializableRetry } from "@/lib/db/serializable-retry";

/**
 * Recompute every consultant's rating aggregates. Shared by
 * `npm run db:recompute-ratings` and the seed; see
 * docs/reviews/02-two-track-scoring.md for what a run does and why it is a
 * script rather than a migration. With no prior and no decay (#1566) a score
 * only moves on a review mutation, so this is a bootstrap and a drift check,
 * not a scheduled job.
 */

// The columns a run writes that are FUNCTIONS OF THE DATA, so a dry run can diff
// them against what is stored. `ratingAggregatedAt` is omitted on purpose: it
// changes on every run, so it would report every profile as changed.
const SCORE_COLUMNS = {
  publishedRatingOneToOne: true,
  publishedRatingGroup: true,
  ratedClientsOneToOne: true,
  ratedEventsGroup: true,
  rating: true,
  publishedRating: true,
  ratingUnitCount: true,
  reviewCount: true,
} as const;

type StoredScore = Record<keyof typeof SCORE_COLUMNS, number | null>;

// Runs the REAL scoring function against a capturing transaction and returns
// what it would have written — never a second copy of the arithmetic.
async function previewConsultantRating(
  consultantProfileId: string,
  now: Date,
): Promise<StoredScore> {
  let captured: StoredScore | null = null;
  // Typed as ScoringTx so a delegate the scorer starts using is a compile error
  // here; only the one swallowed write is cast.
  const capturingTx: ScoringTx = {
    consultantReview: prisma.consultantReview,
    consultantProfile: {
      update: (async ({ data }: { data: StoredScore }) => {
        captured = data;
        return {};
      }) as unknown as ScoringTx["consultantProfile"]["update"],
    },
  };
  await recomputeConsultantRating(capturingTx, consultantProfileId, now);
  if (!captured) throw new Error("preview captured no write");
  return captured;
}

const differs = (a: StoredScore, b: StoredScore) =>
  (Object.keys(SCORE_COLUMNS) as (keyof typeof SCORE_COLUMNS)[]).some(
    (k) => a[k] !== b[k],
  );

export type RecomputeAllResult = {
  profiles: number;
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

  const profiles = await prisma.consultantProfile.findMany({
    select: { id: true, ...SCORE_COLUMNS },
    orderBy: { id: "asc" },
  });

  let recomputed = 0;
  let wouldChange = 0;
  const failed: { id: string; error: string }[] = [];

  for (const { id, ...stored } of profiles) {
    try {
      if (dryRun) {
        const preview = await previewConsultantRating(id, now);
        if (differs(preview, stored as StoredScore)) wouldChange += 1;
        continue;
      }
      // Serializable + retry, matching the mutation paths: a review landing
      // mid-run must not lose-update the average this writes.
      await withSerializableRetry(() =>
        prisma.$transaction(
          async (tx) => recomputeConsultantRating(tx, id, now),
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
    recomputed,
    wouldChange,
    failed,
    timestamp: now.toISOString(),
  };
}
