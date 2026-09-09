/**
 * @jest-environment node
 */

/**
 * The guard that stops a sibling worktree reverting a schema push.
 *
 * Pinned against the ACTUAL plan `prisma migrate diff` produced for this
 * repository on 2026-09-10, from a branch one release behind. Every statement in
 * it is a statement Prisma was willing to run without prompting: the two column
 * drops target values that are NULL (or would be counted as such) on every row,
 * and neither `DROP INDEX` nor `ALTER INDEX … RENAME TO` warns under any
 * circumstance. A test that fabricated its input would not have caught that.
 */

import { findDestructive, planStatements } from "@/scripts/db/preflight-push";

/** Verbatim output of
 *  `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
 *  run on `dev` while the live database carried #1268's schema. */
const REAL_REVERTING_PLAN = `
-- DropForeignKey
ALTER TABLE "AppointmentFeedback" DROP CONSTRAINT "AppointmentFeedback_slotOfAppointmentId_fkey";

-- DropIndex
DROP INDEX "AppointmentFeedback_appointmentId_userId_idx";

-- DropIndex
DROP INDEX "AppointmentFeedback_slotOfAppointmentId_userId_key";

-- DropIndex
DROP INDEX "ConsultantReview_consultantProfileId_consulteeProfileId_key";

-- AlterTable
ALTER TABLE "AppointmentFeedback" DROP COLUMN "slotOfAppointmentId";

-- AlterTable
ALTER TABLE "ConsultantReview" DROP COLUMN "isAnonymous";

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentFeedback_appointmentId_userId_key" ON "AppointmentFeedback"("appointmentId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsultantReview_appointmentId_consulteeProfileId_key" ON "ConsultantReview"("appointmentId", "consulteeProfileId");
`;

/** A genuinely additive plan — the shape every step of this train produces. */
const ADDITIVE_PLAN = `
-- AlterTable
ALTER TABLE "ConsultantReview" ADD COLUMN "track" "ReviewTrack";

-- CreateTable
CREATE TABLE "ConsultantReviewRevision" ("id" TEXT NOT NULL, CONSTRAINT "ConsultantReviewRevision_pkey" PRIMARY KEY ("id"));

-- CreateIndex
CREATE INDEX "ConsultantReview_createdAt_idx" ON "ConsultantReview"("createdAt");
`;

describe("db:push preflight", () => {
  it("refuses the plan that actually reverted a schema push here", () => {
    const found = findDestructive(REAL_REVERTING_PLAN);
    const labels = found.map((f) => f.label);
    // The two column drops are the data loss.
    expect(labels).toContain("DROP COLUMN");
    // The foreign key goes with one of them.
    expect(labels).toContain("DROP a foreign key");
    // And the unique that carried "one review per relationship".
    expect(labels).toContain("DROP a unique index");
    expect(found.length).toBeGreaterThanOrEqual(4);
  });

  it("does not gate an ordinary index replacement", () => {
    // `_idx` drops are routine — a composite changes shape and Prisma rebuilds
    // it. Refusing those would refuse every legitimate push and the guard would
    // be disabled within a week.
    const found = findDestructive(
      `-- DropIndex\nDROP INDEX "AppointmentFeedback_appointmentId_userId_idx";`,
    );
    expect(found).toEqual([]);
  });

  it("lets an additive plan through untouched", () => {
    expect(findDestructive(ADDITIVE_PLAN)).toEqual([]);
    expect(planStatements(ADDITIVE_PLAN)).toHaveLength(3);
  });

  it("catches the index rename that transplants a partial predicate", () => {
    // Not a drop, and it never prompts — but it is how a `WHERE`-clause index
    // gets renamed onto a constraint the schema declares as total, which is the
    // #1268 trap. A drop-only gate waves it through.
    const found = findDestructive(
      `-- AlterIndex\nALTER INDEX "consultant_review_legacy_pair_key" RENAME TO "ConsultantReview_consultantProfileId_consulteeProfileId_key";`,
    );
    expect(found).toHaveLength(1);
    expect(found[0].label).toBe("index rename");
  });

  it("reads an empty plan as nothing to do, not as a pass on garbage", () => {
    expect(planStatements("-- This is an empty migration.")).toEqual([]);
  });
});
