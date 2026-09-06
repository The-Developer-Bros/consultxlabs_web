/**
 * Loading and publishing cancellation policies (#1499).
 *
 * The maths lives in `cancellation-policy.ts` and stays Prisma-free; everything
 * that talks to the database about a policy lives here, so there is exactly one
 * select shape, one platform-row provisioner and one publish routine.
 *
 * Two rules shape this module. A published version is immutable — an edit
 * publishes a new row at `version + 1` and archives the previous one, because
 * `Appointment.cancellationPolicyId` points at the exact row that governed a sale
 * and rewriting it would rewrite terms a buyer already agreed to. And a scope has
 * at most one ACTIVE version, which the Serializable rotation in
 * `publishOrgCancellationPolicy` enforces until the staged partial unique index in
 * `prisma/sql/check-constraints.sql` is applied at the pre-MVP reset.
 */

import { Prisma } from "@prisma/client";

import type { PrismaLike, Tx } from "@/lib/prisma";
import {
  isTwoDecimalPercent,
  PLATFORM_DEFAULT_TERMS,
  tiersFromBps,
  validateTierLadder,
  type CancellationPolicyTerms,
  type RefundTier,
} from "@/lib/payments/operations/cancellation-policy";

/**
 * The platform default lives at a fixed id rather than "the row where
 * organizationId is null", so `ensurePlatformCancellationPolicy` can be an idempotent
 * upsert instead of a read-then-write race, and so the seed and the runtime
 * provisioner cannot create two of it.
 */
export const PLATFORM_CANCELLATION_POLICY_ID =
  "00000000-0000-4000-8000-00000c471499";

/** Platform ladder as stored: 100% a day out, 50% inside the day, nothing inside two hours. */
export const PLATFORM_DEFAULT_TIER_ROWS: {
  hoursBefore: number;
  refundBps: number;
}[] = [
  { hoursBefore: 24, refundBps: 10_000 },
  { hoursBefore: 2, refundBps: 5_000 },
  { hoursBefore: 0, refundBps: 0 },
];

/**
 * The one select every reader uses. Tiers arrive highest-notice first, which is the
 * order `computeRefundPct` sorts into anyway — sorting at the source keeps the
 * editor, the API response and the maths reading the same ladder.
 */
export const POLICY_TERMS_INCLUDE = {
  select: {
    id: true,
    organizationId: true,
    version: true,
    consultantInitiatedBps: true,
    tiers: {
      orderBy: { hoursBefore: "desc" },
      select: { hoursBefore: true, refundBps: true },
    },
  },
} satisfies { select: Prisma.CancellationPolicySelect };

/** The shape `POLICY_TERMS_INCLUDE` returns. */
export type PolicyRow = {
  id: string;
  organizationId: string | null;
  version: number;
  consultantInitiatedBps: number;
  tiers: { hoursBefore: number; refundBps: number }[];
};

/**
 * A loaded row (or the absence of one) as the terms the quote reads. A booking with
 * no policy row is a pre-#1499 booking or a personal booking whose org never
 * published, and both mean the platform ladder.
 */
export function termsFromPolicyRow(
  row: PolicyRow | null | undefined,
): CancellationPolicyTerms {
  if (!row) return PLATFORM_DEFAULT_TERMS;
  return {
    policyId: row.id,
    source: row.organizationId ? "ORG" : "PLATFORM",
    version: row.version,
    tiers: tiersFromBps(row.tiers),
    consultantInitiatedPct: row.consultantInitiatedBps / 100,
  };
}

/**
 * Make sure the platform default row exists, and answer its id.
 *
 * A fresh database must never fail a checkout because nobody ran the seed, so
 * checkout calls this rather than assuming. The P2002 catch covers two checkouts
 * racing on an empty database: the loser re-reads the winner's row instead of
 * failing the sale.
 *
 * Call it on the GLOBAL Prisma client only, never through a `tx` (#1513 review).
 * Inside a Serializable transaction a P2002 aborts the whole transaction, so the
 * recovery below cannot run: the loser's re-read would fail with
 * "current transaction is aborted" and take the sale down with it. On the global
 * client each statement is its own autocommit unit, so the loser really does get
 * to re-read the winner's row.
 */
export async function ensurePlatformCancellationPolicy(
  db: PrismaLike,
): Promise<string> {
  const existing = await db.cancellationPolicy.findUnique({
    where: { id: PLATFORM_CANCELLATION_POLICY_ID },
    select: { id: true },
  });
  if (existing) return existing.id;
  try {
    const created = await db.cancellationPolicy.create({
      data: {
        id: PLATFORM_CANCELLATION_POLICY_ID,
        organizationId: null,
        version: 1,
        status: "ACTIVE",
        consultantInitiatedBps: 10_000,
        tiers: { create: PLATFORM_DEFAULT_TIER_ROWS },
      },
      select: { id: true },
    });
    return created.id;
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return PLATFORM_CANCELLATION_POLICY_ID;
    }
    throw err;
  }
}

/**
 * Which policy version governs a booking being sold right now.
 *
 * An org's ladder governs the bookings the ORG FUNDS — its money is what the refund
 * moves — so the caller passes the organization id only on the org-sponsored path.
 * A personal booking merely tagged to an org keeps the platform ladder. An org that
 * has never published falls through to the platform row for the same reason.
 *
 * `version: desc` with `take: 1` rather than a bare "the ACTIVE one": until the
 * staged partial unique lands, two ACTIVE rows are prevented only by the Serializable
 * rotation, and the newest version is the deterministic answer if that ever slips.
 *
 * This resolver is READ-ONLY (#1513 review), because its one caller runs it inside
 * checkout's Serializable transaction and a write that recovers from P2002 cannot
 * survive there. Provisioning the platform row is `ensurePlatformCancellationPolicy`,
 * which `handleCheckout` awaits on the global client just before opening that
 * transaction — so by the time this runs the row exists and the throw below is
 * unreachable. It is a loud failure rather than a silent null because a sale that
 * cites no policy version has no terms to refund under.
 */
export async function resolveCheckoutCancellationPolicyId(
  db: PrismaLike,
  params: { organizationId: string | null },
): Promise<string> {
  if (params.organizationId) {
    const orgPolicy = await db.cancellationPolicy.findFirst({
      where: { organizationId: params.organizationId, status: "ACTIVE" },
      orderBy: { version: "desc" },
      select: { id: true },
    });
    if (orgPolicy) return orgPolicy.id;
  }
  const platform = await db.cancellationPolicy.findUnique({
    where: { id: PLATFORM_CANCELLATION_POLICY_ID },
    select: { id: true },
  });
  if (!platform) throw new Error("PLATFORM_CANCELLATION_POLICY_MISSING");
  return platform.id;
}

/** Load the terms a booking was sold under, by policy id. */
export async function loadPolicyTerms(
  db: PrismaLike,
  policyId: string | null | undefined,
): Promise<CancellationPolicyTerms> {
  if (!policyId) return PLATFORM_DEFAULT_TERMS;
  const row = await db.cancellationPolicy.findUnique({
    where: { id: policyId },
    ...POLICY_TERMS_INCLUDE,
  });
  return termsFromPolicyRow(row);
}

/**
 * Publish a new immutable version of an org's ladder and archive the previous one.
 *
 * Read-then-write (find the current ACTIVE version → archive it → insert at
 * version + 1), so the caller must run it under `withSerializableRetry` with a
 * Serializable transaction, exactly as `bumpRateCard` is run: two concurrent
 * publishes would otherwise both read version N and both insert version N + 1.
 */
export async function publishOrgCancellationPolicy(
  tx: Tx,
  params: {
    organizationId: string;
    tiers: RefundTier[];
    consultantInitiatedPct: number;
    policyText?: string | null;
    publishedByUserId?: string | null;
  },
) {
  const invalid = validateTierLadder(params.tiers);
  if (invalid) throw Object.assign(new Error(invalid), { httpStatus: 400 });
  if (
    params.consultantInitiatedPct < 0 ||
    params.consultantInitiatedPct > 100 ||
    !isTwoDecimalPercent(params.consultantInitiatedPct)
  ) {
    throw Object.assign(
      new Error(
        "The consultant-initiated refund must be between 0 and 100 percent, with at most two decimal places",
      ),
      { httpStatus: 400 },
    );
  }

  const current = await tx.cancellationPolicy.findFirst({
    where: { organizationId: params.organizationId },
    orderBy: { version: "desc" },
    select: { version: true },
  });

  await tx.cancellationPolicy.updateMany({
    where: { organizationId: params.organizationId, status: "ACTIVE" },
    data: { status: "ARCHIVED", archivedAt: new Date() },
  });

  return tx.cancellationPolicy.create({
    data: {
      organizationId: params.organizationId,
      version: (current?.version ?? 0) + 1,
      status: "ACTIVE",
      consultantInitiatedBps: Math.round(params.consultantInitiatedPct * 100),
      policyText: params.policyText ?? null,
      publishedByUserId: params.publishedByUserId ?? null,
      tiers: {
        create: params.tiers.map((tier) => ({
          hoursBefore: tier.hoursBefore,
          refundBps: Math.round(tier.refundPct * 100),
        })),
      },
    },
    ...POLICY_TERMS_INCLUDE,
  });
}
