import prisma from "../../lib/prisma";
import {
  PLATFORM_CANCELLATION_POLICY_ID,
  PLATFORM_DEFAULT_TIER_ROWS,
} from "../../lib/payments/operations/cancellation-policy-store";

/**
 * #1499 — the platform default cancellation policy, at a fixed id.
 *
 * Every booking that is not governed by an org's own published version points at
 * this row, so a database without it cannot quote a refund. The upsert is keyed on
 * the fixed id and never rewrites an existing row: a published version is immutable,
 * and re-seeding must not silently re-cut terms that bookings already cite. The
 * runtime guarantee is `ensurePlatformCancellationPolicy`, which provisions the same
 * row on first use for a database nobody seeded.
 */
export async function createPlatformCancellationPolicy() {
  await prisma.cancellationPolicy.upsert({
    where: { id: PLATFORM_CANCELLATION_POLICY_ID },
    create: {
      id: PLATFORM_CANCELLATION_POLICY_ID,
      organizationId: null,
      version: 1,
      status: "ACTIVE",
      consultantInitiatedBps: 10_000,
      tiers: { create: PLATFORM_DEFAULT_TIER_ROWS },
    },
    update: {},
  });
  console.log("✅ Seeded the platform CancellationPolicy");
}
