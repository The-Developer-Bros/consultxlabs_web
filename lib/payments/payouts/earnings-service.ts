/**
 * Earnings Service
 * Manages consultant and organization earnings from payments.
 *
 * For HOST / HYBRID orgs, implements a 3-way revenue split:
 *   Payment (100%) = Platform fee (configurable, default 10%)
 *                   + Org retain (configurable, default 5%)
 *                   + Consultant payout (configurable, default 85%)
 *
 * The split is controlled by the org's active `RateCard` row and can be
 * overridden per-membership via `Membership.rateCardOverrideId`.
 *
 * When `Membership.payoutRecipient = ORGANIZATION`, the consultant's share
 * is redirected to the org (internal / salaried consultant case) and the
 * consultant's personal payout for that booking is zero.
 */

import { reportSentryError } from "@/lib/observability/report";
import prisma, { type Tx } from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import {
  postLedgerTxn,
  type AccountRef,
  type Posting,
} from "@/lib/payments/ledger/post";
import {
  EarningRole,
  EarningStatus,
  Payment,
  Prisma,
  type CoveredPlanType,
} from "@prisma/client";
import { PAYOUT_CONSTANTS, AppointmentType } from "./constants";
import { calculateRevenueSplit } from "@/lib/collaborators/service";
import { recordTdsReversal } from "@/lib/payments/tax/tds-service";
import { ENABLE_HOST_ORGS } from "@/lib/feature-flags";
import { recordSystemError } from "@/lib/enterprise/system-events";
import type { RevenueSplit } from "@/types/collaborators";

// ============================================
// Types
// ============================================

export interface EarningsSummary {
  consultantProfileId: string;
  totalEarnings: number;
  pendingEarnings: number;
  readyEarnings: number;
  /** #837 — in a payout batch, cash not yet disbursed (distinct from PAID). */
  batchedEarnings: number;
  paidEarnings: number;
  heldEarnings: number;
  /**
   * Earnings accrued from a not-yet-verified INVOICE-funded org (see
   * EarningStatus.PENDING_TRUST). Deliberately EXCLUDED from
   * totalEarnings — the money isn't cleared until the org is verified
   * or pays; the dashboard surfaces it as its own bucket.
   */
  pendingTrustEarnings: number;
}

/** Resolved 3-way split for a canHost=true org consultant */
interface OrgEarningsSplit {
  organizationId: string;
  rateCardIdApplied: string | null;
  platformBps: number;
  orgBps: number;
  consultantBps: number;
  platformFeePaise: number; // in paise
  orgShare: number; // in paise (org retains this)
  consultantSharePaise: number; // in paise (goes to consultant, or 0 if internal)
  payoutRecipient: "SELF" | "ORGANIZATION";
}

/** Summary of an org's earnings across all statuses */
interface OrgEarningsSummary {
  organizationId: string;
  totalEarnings: number;
  pendingEarnings: number;
  readyEarnings: number;
  /** #837 — in a payout batch, cash not yet disbursed (distinct from PAID). */
  batchedEarnings: number;
  paidEarnings: number;
  heldEarnings: number;
}

// #780/#781 — payments arrive via the extended client (money as number, FX
// Decimal as number); the raw Payment model type still says bigint/Decimal.
type PaymentRow = Omit<
  Payment,
  | "amount"
  | "originalAmount"
  | "taxAmount"
  | "gstTcsCollectedPaise"
  | "exchangeRateAtCheckout"
> & {
  amount: number;
  originalAmount: number;
  taxAmount: number;
  gstTcsCollectedPaise: number | null;
  exchangeRateAtCheckout: number | null;
};

export interface CreateEarningsParams {
  payment: PaymentRow & {
    appointment?: {
      consultantProfile?: {
        id: string;
      };
      webinar?: {
        webinarPlanId: string;
      } | null;
      class?: {
        classPlanId: string;
      } | null;
    } | null;
  };
  appointmentType: AppointmentType;
}

// ============================================
// Status transition guard (#700 LED-2)
// ============================================
// The transition predicate lives in its own file so consumers (esp.
// unit tests) can import it without dragging in earnings-service's
// transitive Stream / Razorpay deps. We re-export here for ergonomics
// at existing call sites.
export {
  IllegalEarningStatusTransitionError,
  assertEarningStatusTransitionLegal,
} from "./earning-status";
import { assertEarningStatusTransitionLegal } from "./earning-status";
import { prorate, sumPaise } from "@/lib/payments/utils/money";

// ============================================
// Org Split Resolution
// ============================================

/**
 * #1335 — the rate card's plan vocabulary, keyed by the settlement's own.
 *
 * Written as an exhaustive `Record` rather than a cast so a new
 * `AppointmentType` or a renamed `CoveredPlanType` member is a compile error
 * here instead of a booking that silently settles on the wrong card.
 */
const RATE_CARD_PLAN_TYPE: Record<AppointmentType, CoveredPlanType> = {
  CONSULTATION: "CONSULTATION",
  WEBINAR: "WEBINAR",
  SUBSCRIPTION: "SUBSCRIPTION",
  CLASS: "CLASS",
};

/**
 * #1335 — the Contract governing this booking's settlement, or null.
 *
 * The only link a settling payment has to a `Contract` is the org-funded one:
 * `BookingUtilization` (unique on `paymentId`) → `ProgramAssignment` →
 * `Program` → `Contract`. A marketplace or self-funded booking has no contract
 * at all, and a SUBSCRIPTION meters its utilization at slot-allocation time,
 * which is after settlement, so it has none yet either. Both cases resolve
 * null and fall through to org scope.
 *
 * The contract is forwarded ONLY when it belongs to the settling org. A
 * contract-scoped card is created under `POST /organizations/{orgId}/rate-cards`
 * with the contract checked against that org, so `ownerContractId` alone
 * identifies its owner — and `resolveEffectiveRateCard` matches
 * `ownerContractId` without re-asserting the org. Forwarding a sponsor's
 * contract into a different host org's settlement would therefore pay one
 * tenant's booking on another tenant's negotiated split. The guard can only
 * ever select fewer cards, never a wrong-tenant one.
 */
async function resolveSettlementContractId(
  tx: Tx,
  paymentId: string,
  orgId: string,
): Promise<string | null> {
  const utilization = await tx.bookingUtilization.findUnique({
    where: { paymentId },
    select: {
      programAssignment: {
        select: {
          program: {
            select: {
              contract: { select: { id: true, organizationId: true } },
            },
          },
        },
      },
    },
  });
  const contract = utilization?.programAssignment.program.contract;
  return contract?.organizationId === orgId ? contract.id : null;
}

/**
 * Determine if a consultant's payment should use a 3-way org split.
 *
 * Returns an OrgEarningsSplit if the consultant is an active EXPERT
 * membership at a canHost org. Returns null for independent consultants
 * or when the HOST-orgs feature flag is off.
 *
 * For multi-org consultants the OWNING org wins when the plan has one — an
 * org that publishes a plan through its catalog is the seller, so it must be
 * the org that gets paid for it. Without that, an expert who is EXPERT at two
 * host orgs sends Org B's catalog revenue to Org A purely because they joined
 * Org A first. That was unreachable until the org catalog could set
 * `Plan.organizationId`; it is reachable now.
 *
 * With no owning org (a personal B2C plan) the previous rule stands: the
 * oldest active canHost membership. ADR 18 records that as known-crude, and it
 * remains the fallback rather than the primary rule.
 */
async function resolveOrgSplit(
  tx: Tx,
  consultantProfileId: string,
  grossAmount: number,
  /** Point in time at which the rate card is resolved. Default = now(),
   *  but callers processing a historical payment MUST pass
   *  `payment.createdAt` — otherwise a retroactive rate bump on the org
   *  would silently rewrite what the consultant was owed for bookings
   *  made before the bump. */
  at: Date = new Date(),
  /** The booked plan, when it is one of the two org-ownable kinds. Read
   *  inside this transaction rather than by the caller, so plan ownership and
   *  the earnings rows it decides are read and written under one snapshot. */
  plan: { id: string; kind: "webinar" | "class" } | null = null,
  /** #1335 — the booking this split settles, used only to widen the rate-card
   *  lookup beyond org scope when `RATE_CARD_SCOPED_RESOLUTION` is on. Null on
   *  the collaborator leg: ADR 18 makes collaborations org-blind, so the
   *  seller's contract and plan must not reach a collaborator's own org card. */
  booking: {
    paymentId: string;
    appointmentType: AppointmentType;
  } | null = null,
): Promise<OrgEarningsSplit | null> {
  if (!ENABLE_HOST_ORGS) return null;

  // Only Webinar and Class can be org-owned — Consultation and Subscription
  // require a consultantProfileId, so an org can never solely own one.
  const ownerOrgId = plan
    ? ((
        await (plan.kind === "webinar"
          ? tx.webinarPlan.findUnique({
              where: { id: plan.id },
              select: { organizationId: true },
            })
          : tx.classPlan.findUnique({
              where: { id: plan.id },
              select: { organizationId: true },
            }))
      )?.organizationId ?? null)
    : null;

  // Arch-4: Membership where role=EXPERT and parent org canHost=true.
  // Rate card resolved via the time-scoped resolver at the booking instant.
  //
  // The owning org is tried FIRST. The membership still has to exist and be
  // ACTIVE at a canHost org — an org cannot direct earnings to itself for
  // someone who is not its expert, and the catalog endpoint enforces the same
  // thing at publish time.
  const membership =
    (ownerOrgId
      ? await tx.membership.findFirst({
          where: {
            consultantProfileId,
            role: "EXPERT",
            status: "ACTIVE",
            organizationId: ownerOrgId,
            organization: { canHost: true, status: "ACTIVE" },
          },
          include: { organization: { select: { id: true } } },
        })
      : null) ??
    // Fallback: oldest membership wins, so multi-org consultants selling their
    // OWN plans route deterministically to the same org.
    (await tx.membership.findFirst({
      where: {
        consultantProfileId,
        role: "EXPERT",
        status: "ACTIVE",
        organization: { canHost: true, status: "ACTIVE" },
      },
      orderBy: { createdAt: "asc" },
      include: { organization: { select: { id: true } } },
    }));

  if (!membership) return null;

  const orgId = membership.organization.id;
  const payoutRecipient = membership.payoutRecipient;

  const { resolveEffectiveRateCard, isScopedRateCardResolutionEnabled } =
    await import("@/lib/api/organizations/rate-card");

  // #1335 — the resolver has always ranked contract- and plan-scoped cards
  // above the org default, but settlement only ever handed it the org, so
  // those tiers were unreachable and a scoped card could be created and never
  // chosen. Forwarding the scope changes which card settles live money, so it
  // is gated: off, this is the pre-#1335 call verbatim.
  const scoped =
    booking && isScopedRateCardResolutionEnabled()
      ? {
          contractId: await resolveSettlementContractId(
            tx,
            booking.paymentId,
            orgId,
          ),
          planType: RATE_CARD_PLAN_TYPE[booking.appointmentType],
          // Only Webinar and Class carry a plan id into settlement. A
          // consultation- or subscription-plan-scoped card therefore still
          // resolves at planType granularity, not plan granularity.
          planId: plan?.id ?? null,
        }
      : {};

  const resolved = await resolveEffectiveRateCard(tx, {
    orgId,
    membershipOverrideId: membership.rateCardOverrideId,
    at,
    ...scoped,
  });

  // Integer paise × basis-point math, no float drift.
  const platformFeePaise = Math.floor(
    (grossAmount * resolved.platformBps) / 10_000,
  );
  const consultantSharePaise = Math.floor(
    (grossAmount * resolved.consultantBps) / 10_000,
  );
  const orgShare = grossAmount - platformFeePaise - consultantSharePaise;

  const base = {
    organizationId: orgId,
    rateCardIdApplied: resolved.rateCardId,
    platformBps: resolved.platformBps,
    orgBps: resolved.orgBps,
    consultantBps: resolved.consultantBps,
    payoutRecipient,
  };

  if (payoutRecipient === "ORGANIZATION") {
    // Internal/salaried consultant: org absorbs the consultant slice.
    return {
      ...base,
      platformFeePaise,
      orgShare: grossAmount - platformFeePaise,
      consultantSharePaise: 0,
    };
  }

  if (orgShare < 0) {
    reportSentryError(
      new Error(
        `[Earnings] Negative orgShare (${orgShare}) for org ${orgId}: platformBps=${resolved.platformBps}, consultantBps=${resolved.consultantBps}. Clamping.`,
      ),
      { subsystem: "payments", level: "warning" },
    );
    console.error(
      `[Earnings] Negative orgShare (${orgShare}) for org ${orgId}: ` +
        `platformBps=${resolved.platformBps}, consultantBps=${resolved.consultantBps}. Clamping.`,
    );
    return {
      ...base,
      platformFeePaise,
      orgShare: 0,
      consultantSharePaise: grossAmount - platformFeePaise,
    };
  }

  return {
    ...base,
    platformFeePaise,
    orgShare,
    consultantSharePaise,
  };
}

// ============================================
// Earnings Service Functions
// ============================================

const EARNINGS_APPOINTMENT_TYPE_MAP: Record<string, AppointmentType> = {
  CONSULTATION: "CONSULTATION",
  SUBSCRIPTION: "SUBSCRIPTION",
  WEBINAR: "WEBINAR",
  CLASS: "CLASS",
};

export interface ResolvedEarningsPayment {
  paymentForEarnings: CreateEarningsParams["payment"];
  earningsAppointmentType: AppointmentType;
  consultantProfileId: string;
}

/**
 * #1439 — the webhook success path and the checkout mock/zero/sponsored path
 * both create earnings straight after confirming a payment, and both need
 * the same appointment -> consultantProfile resolution across the four plan
 * kinds. Shared here so the include and the profile-selection precedence
 * can't drift between the two call sites. Returns null when there is no
 * appointment or no resolvable consultant profile — the caller skips
 * earnings creation in that case, same as before this was extracted.
 */
export async function resolvePaymentForEarnings(
  where: Prisma.PaymentWhereUniqueInput,
  rawAppointmentType: string,
): Promise<ResolvedEarningsPayment | null> {
  const paymentWithAppointment = await prisma.payment.findUnique({
    where,
    include: {
      appointment: {
        include: {
          consultation: {
            include: {
              consultationPlan: {
                include: { consultantProfile: true },
              },
            },
          },
          subscription: {
            include: {
              subscriptionPlan: {
                include: { consultantProfile: true },
              },
            },
          },
          webinar: {
            select: {
              id: true,
              webinarPlanId: true,
              webinarPlan: {
                include: { consultantProfile: true },
              },
            },
          },
          class: {
            select: {
              id: true,
              classPlanId: true,
              classPlan: {
                include: { consultantProfile: true },
              },
            },
          },
        },
      },
    },
  });

  if (!paymentWithAppointment?.appointment) return null;

  const consultantProfile =
    paymentWithAppointment.appointment.consultation?.consultationPlan
      ?.consultantProfile ||
    paymentWithAppointment.appointment.subscription?.subscriptionPlan
      ?.consultantProfile ||
    paymentWithAppointment.appointment.webinar?.webinarPlan
      ?.consultantProfile ||
    paymentWithAppointment.appointment.class?.classPlan?.consultantProfile;

  if (!consultantProfile) return null;

  const earningsAppointmentType =
    EARNINGS_APPOINTMENT_TYPE_MAP[rawAppointmentType] || "CONSULTATION";

  const paymentForEarnings = {
    ...paymentWithAppointment,
    appointment: {
      ...paymentWithAppointment.appointment,
      consultantProfile: { id: consultantProfile.id },
      webinar: paymentWithAppointment.appointment.webinar
        ? {
            webinarPlanId:
              paymentWithAppointment.appointment.webinar.webinarPlanId,
          }
        : null,
      class: paymentWithAppointment.appointment.class
        ? {
            classPlanId: paymentWithAppointment.appointment.class.classPlanId,
          }
        : null,
    },
  } as CreateEarningsParams["payment"];

  return {
    paymentForEarnings,
    earningsAppointmentType,
    consultantProfileId: consultantProfile.id,
  };
}

/**
 * Create earnings record from a successful payment
 * Called from payment success webhook
 */
export async function createEarningsFromPayment({
  payment,
  appointmentType,
}: CreateEarningsParams): Promise<string | null> {
  // Get consultant profile ID from the appointment
  const consultantProfileId = payment.appointment?.consultantProfile?.id;

  if (!consultantProfileId) {
    console.warn(
      `No consultant profile found for payment ${payment.id}. Skipping earnings creation.`,
    );
    return null;
  }

  // Calculate revenue split using original plan price (before platform-funded discounts/credits/tax)
  // Payment.originalAmount is stored in paise (smallest unit) — same as earnings
  const grossAmount = payment.originalAmount;

  // Calculate hold period
  const holdHours =
    PAYOUT_CONSTANTS.HOLD_PERIOD_HOURS[appointmentType] ||
    PAYOUT_CONSTANTS.HOLD_PERIOD_HOURS.CONSULTATION;
  const holdUntil = new Date(Date.now() + holdHours * 60 * 60 * 1000);

  // Determine if this payment involves collaborators (webinars/classes only)
  let planType: "webinar" | "class" | null = null;
  let planId: string | null = null;

  if (appointmentType === "WEBINAR" && payment.appointment?.webinar) {
    planType = "webinar";
    planId = payment.appointment.webinar.webinarPlanId;
  } else if (appointmentType === "CLASS" && payment.appointment?.class) {
    planType = "class";
    planId = payment.appointment.class.classPlanId;
  }

  // FIX #9: Wrap earnings creation + balance updates in a transaction for atomicity.
  // Also handles P2002 unique constraint violations gracefully for idempotency.
  // #896 — Serializable isolation + P2034 retry so the waiver eligibility count()
  // can't race two concurrent first-payments into both waiving commission.
  try {
    return await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          // Idempotency check inside transaction to prevent races
          const existingEarnings = await tx.consultantEarnings.findFirst({
            where: { paymentId: payment.id, consultantProfileId },
          });
          if (existingEarnings) {
            console.warn(
              `Earnings already exist for payment ${payment.id}. Skipping.`,
            );
            return existingEarnings.id;
          }

          // Check if this consultant belongs to a HOST/HYBRID org (3-way
          // split). Settlement uses the rate card that was EFFECTIVE AT
          // PAYMENT-CREATION TIME — hold periods can be days long, so by the
          // time earnings are settled the live rate may have been bumped.
          // Passing `payment.createdAt` keeps the split stable across that
          // window.
          const orgSplit = await resolveOrgSplit(
            tx,
            consultantProfileId,
            grossAmount,
            payment.createdAt,
            planId && planType ? { id: planId, kind: planType } : null,
            { paymentId: payment.id, appointmentType },
          );

          // #687 E-01/E-02 — the PENDING_TRUST park keys on the SPONSORING org
          // (the org that OWES the invoice = payment.organizationId), NOT the
          // expert's HOST org from resolveOrgSplit. An unverified sponsor that
          // may never pay its invoice must not let consultant OR org earnings
          // clear. Decide ONCE here and apply to every row this booking writes
          // (consultant, primary-org, collaborator-org).
          // Only INVOICE (NET-X postpaid) funding creates a receivable the
          // sponsor might never settle — PERSONAL/WALLET/LICENSE are already
          // paid, so an org id retained on those legs must NOT park. Gate on
          // the charged billing account's fundingSource, not on organizationId
          // alone.
          const sponsorOrgId = payment.organizationId;
          let parkForTrust = false;
          if (sponsorOrgId && payment.billingAccountId) {
            const billingAccount = await tx.billingAccount.findUnique({
              where: { id: payment.billingAccountId },
              select: { fundingSource: true },
            });
            if (billingAccount?.fundingSource === "INVOICE") {
              const sponsorOrg = await tx.organization.findUnique({
                where: { id: sponsorOrgId },
                select: { status: true },
              });
              if (sponsorOrg?.status === "PENDING_VERIFICATION") {
                const paidInvoiceCount = await tx.organizationInvoice.count({
                  where: { organizationId: sponsorOrgId, status: "PAID" },
                });
                parkForTrust = paidInvoiceCount === 0;
              }
            }
          }
          const initialEarningStatus: EarningStatus = parkForTrust
            ? EarningStatus.PENDING_TRUST
            : EarningStatus.PENDING;

          // Determine platform fee and consultant pool based on whether org split applies.
          // #778 §C-2 — floor the marketplace fee (was Math.round); the shaved paisa
          // stays in the consultant pool (gross − fee), the pool's residual party.
          const platformFeePaise = orgSplit
            ? orgSplit.platformFeePaise
            : prorate(
                grossAmount,
                PAYOUT_CONSTANTS.PLATFORM_FEE_PERCENTAGE,
                100,
              );
          const totalConsultantPool = orgSplit
            ? orgSplit.consultantSharePaise
            : grossAmount - platformFeePaise;

          // Calculate collaborator splits if applicable
          let splits: RevenueSplit[] = [];
          if (planType && planId) {
            splits = await calculateRevenueSplit(
              planType,
              planId,
              totalConsultantPool,
            );
          }

          let ownerId: string | null = null;

          // #773 — resolve every collaborator's HOST-org settlement UP FRONT so
          // the ConsultantEarnings rows, the OrganizationEarnings rows and the
          // booking journal are all built from one set of numbers. A settled
          // collaborator is paid the NET of their org's rate card (floors per
          // #778 §C; the org leg absorbs the remainder inside resolveOrgSplit);
          // the org keeps its cut, the card's fee slice is platform revenue.
          // Same-org collisions against @@unique([paymentId, organizationId]) are
          // detected here deterministically instead of via a P2002 catch — v1
          // semantics kept: the colliding collaborator stays unsettled (full
          // share on ConsultantEarnings, no org accrual).
          const collabSettlements = new Map<
            string,
            { sharePaise: number; orgSplit: OrgEarningsSplit }
          >();
          if (splits.length > 0) {
            const plannedOrgRows = new Set<string>(
              orgSplit && orgSplit.orgShare > 0
                ? [orgSplit.organizationId]
                : [],
            );
            for (const split of splits) {
              if (split.role === "OWNER" || split.share <= 0) continue;
              // No ownerOrgId on purpose. ADR 18: collaborations are org-blind
              // and "each collaborator's earnings resolve to their own org
              // independently". A collaborator on someone else's org-owned plan
              // is not that org's expert, so their share settles to THEIR host
              // org, not the seller's. #1335 — no booking scope either, for the
              // same reason: the seller's contract and plan must not reach a
              // card owned by the collaborator's org.
              const collabOrgSplit = await resolveOrgSplit(
                tx,
                split.consultantProfileId,
                split.share,
                payment.createdAt,
              );
              if (!collabOrgSplit) continue; // independent collaborator
              if (
                collabOrgSplit.orgShare > 0 &&
                plannedOrgRows.has(collabOrgSplit.organizationId)
              ) {
                console.warn(
                  `[Earnings] Skipping collaborator org earnings for ${collabOrgSplit.organizationId} on payment ${payment.id}: row already exists for this (payment, org) pair (collab ${split.consultantProfileId}). Their personal share is unaffected.`,
                );
                continue;
              }
              if (collabOrgSplit.orgShare > 0) {
                plannedOrgRows.add(collabOrgSplit.organizationId);
              }
              collabSettlements.set(split.consultantProfileId, {
                sharePaise: split.share,
                orgSplit: collabOrgSplit,
              });
            }
          }

          if (splits.length > 0) {
            // #812 — floor every collaborator's shareBps and let the LAST split
            // absorb the remainder, so the cached bps sum to exactly 10000. Rounding
            // each independently (Math.round) could overshoot or undershoot 10000 by
            // a few bps across collaborators, the same floor-then-absorb discipline
            // the rest of the money math uses.
            const shareBpsList = splits.map((s) =>
              totalConsultantPool > 0
                ? Math.floor((s.share / totalConsultantPool) * 10_000)
                : 0,
            );
            if (totalConsultantPool > 0) {
              const assigned = shareBpsList.reduce((a, b) => a + b, 0);
              shareBpsList[shareBpsList.length - 1] += 10_000 - assigned;
            }

            // Multi-party payment: create earnings for owner and each collaborator
            for (let i = 0; i < splits.length; i++) {
              const split = splits[i];
              const isOwner = split.role === "OWNER";
              const shareBps = shareBpsList[i];
              const settlement = isOwner
                ? undefined
                : collabSettlements.get(split.consultantProfileId);

              // #773 — a settled collaborator's row carries their org card's fee
              // slice and the NET share (what the payout pipeline disburses); the
              // org's cut lives on its OrganizationEarnings row. The cache must
              // mirror the journal's legs or EARNINGS_LEDGER_DRIFT fires.
              const creditedShare = settlement
                ? settlement.orgSplit.consultantSharePaise
                : split.share;
              const earnings = await tx.consultantEarnings.create({
                data: {
                  consultantProfileId: split.consultantProfileId,
                  paymentId: payment.id,
                  grossAmount: isOwner ? grossAmount : 0,
                  platformFeePaise: isOwner
                    ? platformFeePaise
                    : (settlement?.orgSplit.platformFeePaise ?? 0),
                  consultantSharePaise: creditedShare,
                  role: isOwner ? EarningRole.OWNER : EarningRole.COLLABORATOR,
                  shareBps,
                  // #687 E-02 — park consultant payables too when the sponsor
                  // is an unverified INVOICE org; else the platform owes real
                  // money for a ghost sponsor's booking.
                  status: initialEarningStatus,
                  holdUntil,
                  currency: "INR",
                },
              });

              if (split.role === "OWNER") {
                ownerId = earnings.id;
              }

              console.log(
                `Earnings created for ${split.role} (${split.consultantProfileId}): ${creditedShare / 100} from payment ${payment.id}${orgSplit ? " [HOST 3-way split]" : ""}${settlement ? " [collab org-settled]" : ""}`,
              );
            }
          } else {
            // Single-owner payment (no collaborators or not a webinar/class)
            const earnings = await tx.consultantEarnings.create({
              data: {
                consultantProfileId,
                paymentId: payment.id,
                grossAmount,
                platformFeePaise,
                consultantSharePaise: totalConsultantPool,
                // #687 E-02 — see multi-party branch above.
                status: initialEarningStatus,
                holdUntil,
                currency: "INR",
              },
            });

            ownerId = earnings.id;
          }

          // Create OrganizationEarnings row for the HOST/HYBRID org (3-way split).
          // Skip when orgShare is 0 (Platform-only mode: platformCommissionRate = 1.0)
          // — creating 0-value rows adds noise without value.
          //
          // PR-1d / #687: if the SPONSORING org (payment.organizationId, resolved
          // above into initialEarningStatus — E-01) is still PENDING_VERIFICATION
          // and has never paid an invoice, accruals start in PENDING_TRUST
          // instead of PENDING. The `release-pending-trust-earnings` cron
          // promotes them once the org is verified or first invoice clears.
          if (orgSplit && orgSplit.orgShare > 0) {
            await tx.organizationEarnings.create({
              data: {
                organizationId: orgSplit.organizationId,
                paymentId: payment.id,
                grossAmountPaise: grossAmount,
                platformFeePaise: orgSplit.platformFeePaise,
                orgSharePaise: orgSplit.orgShare,
                consultantSharePaise: orgSplit.consultantSharePaise,
                refundedAmountPaise: 0,
                status: initialEarningStatus,
                holdUntil,
                currency: "INR",
                // Rate-card snapshot: persist the exact split applied so
                // payout reconciliation reads this row, never the live card.
                rateCardIdApplied: orgSplit.rateCardIdApplied,
                platformBpsApplied: orgSplit.platformBps,
                orgBpsApplied: orgSplit.orgBps,
                consultantBpsApplied: orgSplit.consultantBps,
              },
            });

            console.log(
              `Org earnings created for ${orgSplit.organizationId}: org=${orgSplit.orgShare / 100} consultant=${orgSplit.consultantSharePaise / 100} (recipient=${orgSplit.payoutRecipient}) from payment ${payment.id}`,
            );
          } else if (orgSplit && orgSplit.orgShare === 0) {
            console.log(
              `Platform-only mode for ${orgSplit.organizationId}: skipping 0-value org earnings for payment ${payment.id}`,
            );
          }

          // ============================================
          // A3 (Q3) / #773: per-collaborator HOST-org settlement
          // ============================================
          // Each ACCEPTED collaborator at a HOST org settles to *their own* org
          // independently of the primary expert's org: the collaborator's pool
          // share is the "gross" their org's rate card splits. Independent
          // collaborators (no active EXPERT membership at a HOST org) get no row —
          // their full share sits on ConsultantEarnings and pays out via the
          // personal payout pipeline. Rows are written BEFORE the booking journal
          // below so the posting can mirror every accrual it covers. Platform-only
          // cards (orgShare == 0) still settle (fee + net) but write no 0-value
          // org row. Same-org collisions were already resolved upstream (see
          // collabSettlements), so every entry here inserts cleanly.
          for (const [collabProfileId, s] of Array.from(
            collabSettlements.entries(),
          )) {
            if (s.orgSplit.orgShare <= 0) {
              console.log(
                `Platform-only mode for collaborator org ${s.orgSplit.organizationId}: skipping 0-value org earnings for payment ${payment.id}`,
              );
              continue;
            }

            // #687 E-01 — same sponsor-scoped PENDING_TRUST gate as the primary
            // org above; the park keys on the SPONSOR (payment.organizationId,
            // via initialEarningStatus), not this collaborator's host org.
            await tx.organizationEarnings.create({
              data: {
                organizationId: s.orgSplit.organizationId,
                paymentId: payment.id,
                // The collaborator's share is the "gross" that this org is
                // splitting — NOT the booking's full gross. Persist it verbatim
                // so reconciliation sees a consistent picture.
                grossAmountPaise: s.sharePaise,
                platformFeePaise: s.orgSplit.platformFeePaise,
                orgSharePaise: s.orgSplit.orgShare,
                consultantSharePaise: s.orgSplit.consultantSharePaise,
                refundedAmountPaise: 0,
                status: initialEarningStatus,
                holdUntil,
                currency: "INR",
                rateCardIdApplied: s.orgSplit.rateCardIdApplied,
                platformBpsApplied: s.orgSplit.platformBps,
                orgBpsApplied: s.orgSplit.orgBps,
                consultantBpsApplied: s.orgSplit.consultantBps,
              },
            });
            console.log(
              `Collaborator org earnings created for ${s.orgSplit.organizationId} (collab ${collabProfileId}): org=${s.orgSplit.orgShare / 100} consultant=${s.orgSplit.consultantSharePaise / 100} from payment ${payment.id}`,
            );
          }

          // #771 D1/D5 / AF-3 — double-entry booking posting (full accrual, dual-write).
          //   Dr funding legs (CASH/WALLET/ORG_RECEIVABLE) + PLATFORM_PROMO (referral
          //   credits) + DISCOUNT  ==  Cr PLATFORM_FEE + CONSULTANT_PAYABLE(per party) +
          //   ORG_PAYABLE(per org) + GST_PAYABLE.
          // #776 — posted for BOTH the single-consultant AND multi-collaborator cases.
          // #773 — the multi-collaborator posting now also covers the per-collab
          // HOST-org settlements written above: each settled collaborator's
          // CONSULTANT_PAYABLE is their NET share, their org gets its own
          // ORG_PAYABLE leg, and the org-card fee slices fold into PLATFORM_FEE —
          // so the journal's earnings-relevant credits equal the cached Earnings
          // rows exactly (EARNINGS_LEDGER_DRIFT contract).
          {
            try {
              const legs = await tx.paymentLeg.findMany({
                where: { paymentId: payment.id },
                select: { source: true, amountPaise: true },
              });
              const orgId = payment.organizationId ?? null;
              // #1458 — tracked separately from `receivable` so the credit side
              // can ask "was a CHARGE_ORG overage funded through this payment?"
              // without a second leg query. See the surcharge credit below.
              let overageAccrualPaise = 0;
              const debits: Posting[] = [];
              const pushDebit = (account: AccountRef, amountPaise: number) => {
                if (amountPaise > 0)
                  debits.push({ account, direction: "DEBIT", amountPaise });
              };
              if (legs.length > 0) {
                let card = 0;
                let wallet = 0;
                let receivable = 0;
                let promo = 0;
                for (const leg of legs) {
                  if (leg.amountPaise <= 0) continue;
                  switch (leg.source) {
                    case "CARD":
                      card += leg.amountPaise;
                      break;
                    case "WALLET":
                      wallet += leg.amountPaise;
                      break;
                    case "INVOICE_ACCRUAL":
                      receivable += leg.amountPaise;
                      break;
                    case "OVERAGE_INVOICE_ACCRUAL":
                      receivable += leg.amountPaise;
                      overageAccrualPaise += leg.amountPaise;
                      break;
                    case "REFERRAL_CREDIT":
                      promo += leg.amountPaise;
                      break;
                    case "LICENSE":
                      break; // 0 — no money moves
                    case "INVOICE_ACCRUAL_REVERSAL":
                    case "OVERAGE_INVOICE_ACCRUAL_REVERSAL":
                      // #786 — negative refund counter-entries; they cannot exist
                      // at booking time and are never funding. Skip explicitly
                      // (the <= 0 guard above already drops them defensively).
                      break;
                  }
                }
                pushDebit({ kind: "CASH" }, card);
                // #835 mirror — a B2C booking funded by an org wallet may
                // carry no organizationId on the Payment row. Keying the
                // WALLET leg off payment.organizationId alone posted the
                // debit to the null-org sub-ledger while the checkout's cache
                // decrement hit the org's own account — guaranteed
                // WALLET_BALANCE_DRIFT at reconcile (the refund path got this
                // fallback; the booking posting was missed).
                let walletLegOrgId = orgId;
                if (!walletLegOrgId && wallet > 0 && payment.billingAccountId) {
                  const walletOwner = await tx.billingAccount.findUnique({
                    where: { id: payment.billingAccountId },
                    select: { ownerOrgId: true },
                  });
                  walletLegOrgId = walletOwner?.ownerOrgId ?? null;
                }
                pushDebit(
                  { kind: "WALLET", organizationId: walletLegOrgId },
                  wallet,
                );
                pushDebit(
                  { kind: "ORG_RECEIVABLE", organizationId: orgId },
                  receivable,
                );
                pushDebit({ kind: "PLATFORM_PROMO" }, promo);
              } else {
                // Back-compat: legacy single-source payments carry no legs.
                pushDebit({ kind: "CASH" }, payment.amount);
              }
              // #776 — DISCOUNT is the platform-absorbed gap between gross
              // (originalAmount + tax) and the funding actually applied. Base it on the
              // sum of the funding-leg debits, NOT payment.amount: a referral-credit leg
              // funds the booking (debited as PLATFORM_PROMO) yet is excluded from
              // payment.amount (post-credit). Using `amount` double-counted the credit
              // (PROMO + DISCOUNT), imbalancing the posting so it was silently dropped —
              // every fully-credit-funded booking went un-journaled.
              const fundingDebitTotal = debits.reduce(
                (s, d) => s + d.amountPaise,
                0,
              );
              pushDebit(
                { kind: "DISCOUNT" },
                Math.max(
                  0,
                  payment.originalAmount +
                    (payment.taxAmount ?? 0) -
                    fundingDebitTotal,
                ),
              );

              const credits: Posting[] = [];
              const pushCredit = (account: AccountRef, amountPaise: number) => {
                if (amountPaise > 0)
                  credits.push({ account, direction: "CREDIT", amountPaise });
              };
              // #773 — the platform's total cut is the primary fee PLUS each
              // settled collaborator's org-card fee slice, as one summed leg.
              let platformFeeCreditPaise = platformFeePaise;
              for (const s of Array.from(collabSettlements.values())) {
                platformFeeCreditPaise += s.orgSplit.platformFeePaise;
              }
              // #1458 (Sentry FAMILIARISE_WEB-28) — every credit above is
              // derived from `payment.originalAmount`, the nominal price, while
              // the debits are the funding legs. A CHARGE_ORG overage surcharge
              // is the one funding amount that is NOT inside the nominal price:
              // the base carve keeps `basePaise` in, but `marginal = base +
              // surcharge` bumps both the accrual leg and `Payment.amount` by
              // the surcharge. Without this credit the posting was short by
              // exactly `surchargePaise`, threw LedgerImbalanceError, and the
              // booking committed with no journal entry at all.
              //
              // PLATFORM_FEE is the right account and no new one is needed: an
              // over-cap surcharge is a markup the platform charges the org for
              // exceeding its own cap, not consultant income — the consultant is
              // paid out of `originalAmount`, which the surcharge sits outside
              // of. (The surcharge is booked gross of GST; `Payment.taxAmount`
              // is computed on the nominal price and is not re-derived for an
              // overage, which is the same limitation the invoice rollup has.)
              //
              // Only read when an OVERAGE_INVOICE_ACCRUAL leg actually funded
              // this payment: on the wallet rail the marginal is inside the
              // wallet debit and no such leg exists, and a CHARGE_MEMBER
              // surcharge rides the member's side-payment, not this journal.
              if (overageAccrualPaise > 0) {
                const orgOverage = await tx.overageEvent.findFirst({
                  where: {
                    bookingUtilization: { paymentId: payment.id },
                    overageBehavior: "CHARGE_ORG",
                  },
                  select: { surchargePaise: true },
                });
                platformFeeCreditPaise += sumPaise(orgOverage?.surchargePaise);
              }
              pushCredit({ kind: "PLATFORM_FEE" }, platformFeeCreditPaise);
              if (splits.length > 0) {
                // Multi-party: one payable per party, mirroring the
                // ConsultantEarnings rows. Settled collaborators are credited NET
                // of their org's cut; each settled share decomposes exactly into
                // fee + org + net (resolveOrgSplit), so Σ(payables + org legs +
                // fee slices) === totalConsultantPool and the txn balances to the
                // paise.
                for (const split of splits) {
                  const settlement =
                    split.role === "OWNER"
                      ? undefined
                      : collabSettlements.get(split.consultantProfileId);
                  pushCredit(
                    {
                      kind: "CONSULTANT_PAYABLE",
                      consultantProfileId: split.consultantProfileId,
                    },
                    settlement
                      ? settlement.orgSplit.consultantSharePaise
                      : split.share,
                  );
                }
              } else {
                pushCredit(
                  { kind: "CONSULTANT_PAYABLE", consultantProfileId },
                  totalConsultantPool,
                );
              }
              if (orgSplit && orgSplit.orgShare > 0) {
                pushCredit(
                  {
                    kind: "ORG_PAYABLE",
                    organizationId: orgSplit.organizationId,
                  },
                  orgSplit.orgShare,
                );
              }
              // #773 — one ORG_PAYABLE per collaborator host org, mirroring the
              // OrganizationEarnings rows written above.
              for (const s of Array.from(collabSettlements.values())) {
                if (s.orgSplit.orgShare > 0) {
                  pushCredit(
                    {
                      kind: "ORG_PAYABLE",
                      organizationId: s.orgSplit.organizationId,
                    },
                    s.orgSplit.orgShare,
                  );
                }
              }
              // #812 — guard a missing taxAmount (NaN would imbalance the now-blocking
              // posting and roll back the booking). Defaults to 0 in-schema, but
              // legacy/imported rows may lack it.
              pushCredit({ kind: "GST_PAYABLE" }, payment.taxAmount ?? 0);

              await postLedgerTxn(tx, {
                idempotencyKey: `booking:${payment.id}`,
                kind: "BOOKING",
                paymentId: payment.id,
                postings: [...debits, ...credits],
              });
            } catch (err) {
              // #896 — a P2034 serialization conflict here is retryable
              // (withSerializableRetry re-runs the whole txn); logging it as a
              // ledger failure would flood system events on every retry. Only a
              // genuine, non-retryable posting failure is the drift we must record.
              const isRetryableSerialization =
                err instanceof Prisma.PrismaClientKnownRequestError &&
                err.code === "P2034";
              if (!isRetryableSerialization) {
                reportSentryError(err, { subsystem: "payments" });
                console.error(
                  `[ledger] booking posting FAILED for payment ${payment.id} — rolling back the booking: ${err instanceof Error ? err.message : String(err)}`,
                );
                // #812 — record the drift on its own connection (survives the rollback),
                // then RE-THROW so the imbalance rolls back the whole booking
                // transaction. The ledger is the source of truth: a booking that can't
                // post a balanced journal must not be allowed to half-commit and drift.
                void recordSystemError({
                  organizationId: payment.organizationId ?? null,
                  category: "LEDGER",
                  summary: `Booking ledger posting failed for payment ${payment.id}`,
                  err,
                  context: { paymentId: payment.id },
                }).catch(() => {});
              } else {
                // Lost SSI race — withSerializableRetry re-runs the whole txn.
                // Modelled outcome, reported at low volume/info only.
                reportSentryError(err, {
                  subsystem: "payments",
                  expected: true,
                });
              }
              throw err;
            }
          }

          return ownerId;
        },
        { isolationLevel: "Serializable", timeout: 10000 },
      ),
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      // Unique constraint violation — earnings already created by a concurrent call
      console.warn(
        `[Earnings] Duplicate earnings creation for payment ${payment.id} (P2002). Treating as idempotent success.`,
      );
      reportSentryError(error, {
        subsystem: "payments",
        expected: true,
        extra: { paymentId: payment.id, consultantProfileId },
      });
      const existing = await prisma.consultantEarnings.findFirst({
        where: { paymentId: payment.id, consultantProfileId },
      });
      return existing?.id ?? null;
    }
    throw error;
  }
}

// #1471 — `releaseEarningsFromHold` used to live here as a second, unlocked
// implementation that nothing called: every scheduled entry point imports
// `scripts/earnings/release-earnings.ts` instead. It was the only copy that
// released `OrganizationEarnings`, which is why the org arm looked implemented
// while being dead. The behaviour has moved into the script (locked, bounded,
// Serializable) and the dead copy is deleted rather than kept as a trap.

/**
 * Get consultant earnings summary.
 *
 * `organizationId` is an OPTIONAL view-scope filter (#org-appts #1024):
 * omitted (`undefined`) = no filter, identical to pre-#1024 behavior, for
 * any caller outside the earnings-view path. `null` scopes to personal
 * (B2C) earnings; a string scopes to that org's earnings.
 */
export async function getConsultantEarningsSummary(
  consultantProfileId: string,
  organizationId?: string | null,
): Promise<EarningsSummary> {
  const orgFilter =
    organizationId !== undefined ? { payment: { organizationId } } : {};
  const [pending, ready, batched, paid, held, pendingTrust] = await Promise.all(
    [
      prisma.consultantEarnings.aggregate({
        where: {
          consultantProfileId,
          status: EarningStatus.PENDING,
          ...orgFilter,
        },
        _sum: { consultantSharePaise: true },
      }),
      prisma.consultantEarnings.aggregate({
        where: {
          consultantProfileId,
          status: EarningStatus.READY,
          ...orgFilter,
        },
        _sum: { consultantSharePaise: true },
      }),
      prisma.consultantEarnings.aggregate({
        where: {
          consultantProfileId,
          status: EarningStatus.BATCHED,
          ...orgFilter,
        },
        _sum: { consultantSharePaise: true },
      }),
      prisma.consultantEarnings.aggregate({
        where: {
          consultantProfileId,
          status: EarningStatus.PAID,
          ...orgFilter,
        },
        _sum: { consultantSharePaise: true },
      }),
      prisma.consultantEarnings.aggregate({
        where: {
          consultantProfileId,
          status: EarningStatus.HELD,
          ...orgFilter,
        },
        _sum: { consultantSharePaise: true },
      }),
      prisma.consultantEarnings.aggregate({
        where: {
          consultantProfileId,
          status: EarningStatus.PENDING_TRUST,
          ...orgFilter,
        },
        _sum: { consultantSharePaise: true },
      }),
    ],
  );

  const pendingEarnings = sumPaise(pending._sum.consultantSharePaise);
  const readyEarnings = sumPaise(ready._sum.consultantSharePaise);
  const batchedEarnings = sumPaise(batched._sum.consultantSharePaise);
  const paidEarnings = sumPaise(paid._sum.consultantSharePaise);
  const heldEarnings = sumPaise(held._sum.consultantSharePaise);
  const pendingTrustEarnings = sumPaise(pendingTrust._sum.consultantSharePaise);

  return {
    consultantProfileId,
    // #837 — batched money is real cleared earnings in transit; keep it in the total.
    totalEarnings:
      pendingEarnings +
      readyEarnings +
      batchedEarnings +
      paidEarnings +
      heldEarnings,
    pendingEarnings,
    readyEarnings,
    batchedEarnings,
    paidEarnings,
    heldEarnings,
    pendingTrustEarnings,
  };
}

/**
 * Get consultant earnings with pagination and filters.
 *
 * `organizationId` is an OPTIONAL view-scope filter (#org-appts #1024):
 * omitted (`undefined`) = no filter, identical to pre-#1024 behavior, for
 * any caller outside the earnings-view path. `null` scopes to personal
 * (B2C) earnings; a string scopes to that org's earnings.
 */
export async function getConsultantEarnings(
  consultantProfileId: string,
  options?: {
    status?: EarningStatus;
    limit?: number;
    offset?: number;
    organizationId?: string | null;
  },
) {
  const { status, limit = 20, offset = 0, organizationId } = options || {};
  const orgFilter =
    organizationId !== undefined ? { payment: { organizationId } } : {};

  const [earnings, total] = await Promise.all([
    prisma.consultantEarnings.findMany({
      where: {
        consultantProfileId,
        ...(status ? { status } : {}),
        ...orgFilter,
      },
      include: {
        payment: {
          select: {
            id: true,
            amount: true,
            originalAmount: true,
            currency: true,
            createdAt: true,
            appointment: {
              select: {
                id: true,
                appointmentType: true,
              },
            },
          },
        },
        payout: {
          select: {
            id: true,
            status: true,
            processedAt: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.consultantEarnings.count({
      where: {
        consultantProfileId,
        ...(status ? { status } : {}),
        ...orgFilter,
      },
    }),
  ]);

  return {
    earnings,
    total,
    hasMore: offset + limit < total,
  };
}

/**
 * Refund earnings (called when a payment is refunded).
 *
 * Accepts an optional `tx` so callers inside `$transaction` blocks (most
 * notably the Razorpay refund webhook) can commit earnings reversals,
 * org-earnings reversals, and TDS-reversal records atomically with the
 * surrounding refund-row + wallet-credit + utilization-reversal writes.
 * When `tx` is omitted we fall back to the global `prisma` client for
 * legacy callers that drive refunds outside a transaction.
 */
export async function refundEarnings(
  paymentId: string,
  options?: {
    forceRefund?: boolean;
    /** For partial refunds: the refund amount in smallest currency unit */
    refundAmount?: number;
    /** For partial refunds: the original payment amount in smallest currency unit */
    paymentAmount?: number;
    /** Optional Prisma transaction client; see function docblock. */
    tx?: Tx;
  },
): Promise<boolean> {
  const db = options?.tx ?? prisma;
  const allEarnings = await db.consultantEarnings.findMany({
    where: { paymentId },
  });

  if (allEarnings.length === 0) {
    console.warn(`No earnings found for payment ${paymentId}`);
    return false;
  }

  // Calculate refund ratio for partial refunds.
  // If refundAmount < paymentAmount, only reverse a proportional share of earnings.
  // Handle edge case: refundAmount=0 means no reversal (ratio=0).
  const isPartialRefund =
    options?.refundAmount !== null &&
    options?.refundAmount !== undefined &&
    options?.paymentAmount !== null &&
    options?.paymentAmount !== undefined &&
    options.paymentAmount > 0 &&
    options.refundAmount < options.paymentAmount;
  const refundRatio = isPartialRefund
    ? options!.refundAmount! / options!.paymentAmount!
    : options?.refundAmount === 0
      ? 0
      : 1;

  if (refundRatio === 0) {
    console.log(
      `Zero-amount refund for payment ${paymentId}, no earnings reversal needed`,
    );
    return true;
  }

  // #813 — integer-paise proportion pair shared by the TDS-reversal helper and
  // the proration floors below. Partial refunds carry explicit paise amounts; a
  // full refund has none, so we pass an equal pair to express ratio=1 without
  // reintroducing float math.
  const refundNumPaise = isPartialRefund ? options!.refundAmount! : 1;
  const refundDenPaise = isPartialRefund ? options!.paymentAmount! : 1;
  // #778 §C-2 — floor each party's clawback (was Math.round; same plug policy
  // as operations/refund.ts): the buyer is made whole in full, so the shaved
  // paise are absorbed by the PLATFORM — never over-clawed from a consultant
  // or an org.
  const prorateRefundPaise = (paise: number) =>
    prorate(paise, refundNumPaise, refundDenPaise);

  if (isPartialRefund) {
    console.log(
      `Partial refund: ${options!.refundAmount}/${options!.paymentAmount} = ${(refundRatio * 100).toFixed(1)}% reversal for payment ${paymentId}`,
    );
  }

  // Also refund any org earnings for this payment (HOST 3-way split)
  const orgEarnings = await db.organizationEarnings.findMany({
    where: { paymentId },
  });

  for (const orgEarning of orgEarnings) {
    if (orgEarning.status === EarningStatus.REFUNDED) continue;

    const alreadyRefunded = orgEarning.refundedAmountPaise ?? 0;
    const maxReversible = Math.max(
      0,
      orgEarning.orgSharePaise - alreadyRefunded,
    );
    const rawOrgRefund = prorateRefundPaise(orgEarning.orgSharePaise);
    const orgRefundAmount = Math.min(rawOrgRefund, maxReversible);

    if (orgRefundAmount <= 0) continue;

    const isOrgFullyRefunded =
      alreadyRefunded + orgRefundAmount >= orgEarning.orgSharePaise;

    await db.organizationEarnings.update({
      where: { id: orgEarning.id },
      data: {
        refundedAmountPaise: { increment: orgRefundAmount },
        ...(isOrgFullyRefunded && { status: EarningStatus.REFUNDED }),
      },
    });

    console.log(
      `Org earnings ${orgEarning.id} refunded: ${orgRefundAmount} paise (${isOrgFullyRefunded ? "full" : "partial"})`,
    );
  }

  // Refund each earnings record (supports multi-party collaborator payments)
  for (const earnings of allEarnings) {
    // C7 FIX: Guard against already-refunded earnings.
    if (earnings.status === EarningStatus.REFUNDED) {
      console.warn(
        `Earnings ${earnings.id} already refunded for payment ${paymentId}. Skipping.`,
      );
      continue;
    }

    // Cap shareToReverse against remaining reversible balance to prevent
    // over-refunding on duplicate webhooks or sequential partial refunds.
    const alreadyRefunded = earnings.refundedShareAmount ?? 0;
    const maxReversible = Math.max(
      0,
      earnings.consultantSharePaise - alreadyRefunded,
    );
    const rawShare = prorateRefundPaise(earnings.consultantSharePaise);
    const shareToReverse = Math.min(rawShare, maxReversible);

    if (shareToReverse <= 0) {
      console.warn(
        `Earnings ${earnings.id} already fully refunded (${alreadyRefunded}/${earnings.consultantSharePaise}). Skipping.`,
      );
      continue;
    }

    // Determine if this reversal fully exhausts the earning
    const isFullyRefunded =
      alreadyRefunded + shareToReverse >= earnings.consultantSharePaise;

    // Handle already-paid earnings (payout completed)
    if (earnings.status === EarningStatus.PAID) {
      if (!options?.forceRefund) {
        console.error(
          `Cannot refund earnings ${earnings.id} - already paid out. Use forceRefund: true to proceed with TDS reversal.`,
        );
        continue;
      }
      if (isFullyRefunded) {
        // Defensive double-check: forceRefund is the only path that
        // writes PAID → REFUNDED, but if another code path ever forgets
        // the assertion this throws before any state mutates.
        assertEarningStatusTransitionLegal(
          earnings.id,
          earnings.status,
          EarningStatus.REFUNDED,
        );
      }

      // #813 — force refund of PAID earnings: record the proportional TDS reversal
      // via the shared helper (integer proportion + dedup/cap + filed-aware
      // FY/quarter). Previously this path used float ratio math and no cap, and
      // it diverged from the gateway/cron cascade (operations/refund.ts).
      if (earnings.payoutId) {
        await recordTdsReversal(db, {
          payoutId: earnings.payoutId,
          consultantProfileId: earnings.consultantProfileId,
          earningsId: earnings.id,
          refundAmountPaise: refundNumPaise,
          paymentAmountPaise: refundDenPaise,
        });
      }

      // Update earnings: always track refundedShareAmount, set REFUNDED when fully exhausted
      await db.consultantEarnings.update({
        where: { id: earnings.id },
        data: {
          refundedShareAmount: { increment: shareToReverse },
          ...(isFullyRefunded && { status: EarningStatus.REFUNDED }),
        },
      });

      continue;
    }

    // Update earnings for non-paid earnings (PENDING/HELD/READY):
    // always track refundedShareAmount, set REFUNDED when fully exhausted
    await db.consultantEarnings.update({
      where: { id: earnings.id },
      data: {
        refundedShareAmount: { increment: shareToReverse },
        ...(isFullyRefunded && { status: EarningStatus.REFUNDED }),
      },
    });
  }

  return true;
}

/**
 * Hold earnings (e.g., for dispute investigation)
 */
export async function holdEarnings(
  earningsId: string,
  reason?: string,
): Promise<boolean> {
  const earnings = await prisma.consultantEarnings.findUnique({
    where: { id: earningsId },
  });

  if (!earnings) {
    console.warn(`Earnings not found: ${earningsId}`);
    return false;
  }

  // Can only hold if pending or ready
  if (
    earnings.status !== EarningStatus.PENDING &&
    earnings.status !== EarningStatus.READY
  ) {
    console.warn(
      `Cannot hold earnings ${earningsId} - status is ${earnings.status}`,
    );
    return false;
  }

  await prisma.consultantEarnings.update({
    where: { id: earningsId },
    data: {
      status: EarningStatus.HELD,
    },
  });

  console.log(
    `Earnings ${earningsId} held. Reason: ${reason || "Not specified"}`,
  );
  return true;
}

/**
 * Release held earnings back to ready state
 */
export async function releaseHeldEarnings(
  earningsId: string,
): Promise<boolean> {
  const earnings = await prisma.consultantEarnings.findUnique({
    where: { id: earningsId },
  });

  if (!earnings || earnings.status !== EarningStatus.HELD) {
    return false;
  }

  await prisma.consultantEarnings.update({
    where: { id: earningsId },
    data: {
      status: EarningStatus.READY,
    },
  });

  return true;
}

/**
 * Get earnings statistics for admin dashboard
 */
export async function getEarningsStats() {
  const [pending, ready, batched, paid, held, refunded] = await Promise.all([
    prisma.consultantEarnings.aggregate({
      where: { status: EarningStatus.PENDING },
      _sum: { consultantSharePaise: true, platformFeePaise: true },
      _count: true,
    }),
    prisma.consultantEarnings.aggregate({
      where: { status: EarningStatus.READY },
      _sum: { consultantSharePaise: true, platformFeePaise: true },
      _count: true,
    }),
    prisma.consultantEarnings.aggregate({
      where: { status: EarningStatus.BATCHED },
      _sum: { consultantSharePaise: true, platformFeePaise: true },
      _count: true,
    }),
    prisma.consultantEarnings.aggregate({
      where: { status: EarningStatus.PAID },
      _sum: { consultantSharePaise: true, platformFeePaise: true },
      _count: true,
    }),
    prisma.consultantEarnings.aggregate({
      where: { status: EarningStatus.HELD },
      _sum: { consultantSharePaise: true, platformFeePaise: true },
      _count: true,
    }),
    prisma.consultantEarnings.aggregate({
      where: { status: EarningStatus.REFUNDED },
      _sum: { consultantSharePaise: true, platformFeePaise: true },
      _count: true,
    }),
  ]);

  return {
    pending: {
      count: pending._count,
      consultantSharePaise: sumPaise(pending._sum.consultantSharePaise),
      platformFeePaise: sumPaise(pending._sum.platformFeePaise),
    },
    ready: {
      count: ready._count,
      consultantSharePaise: sumPaise(ready._sum.consultantSharePaise),
      platformFeePaise: sumPaise(ready._sum.platformFeePaise),
    },
    // #837 — batched, cash not yet disbursed (was previously counted under ready).
    batched: {
      count: batched._count,
      consultantSharePaise: sumPaise(batched._sum.consultantSharePaise),
      platformFeePaise: sumPaise(batched._sum.platformFeePaise),
    },
    paid: {
      count: paid._count,
      consultantSharePaise: sumPaise(paid._sum.consultantSharePaise),
      platformFeePaise: sumPaise(paid._sum.platformFeePaise),
    },
    held: {
      count: held._count,
      consultantSharePaise: sumPaise(held._sum.consultantSharePaise),
      platformFeePaise: sumPaise(held._sum.platformFeePaise),
    },
    refunded: {
      count: refunded._count,
      consultantSharePaise: sumPaise(refunded._sum.consultantSharePaise),
      platformFeePaise: sumPaise(refunded._sum.platformFeePaise),
    },
    // #837 — platform fee is earned once the sale settles (READY); batched/paid
    // are downstream of READY, so include all three to keep recognized revenue whole.
    totalPlatformRevenue:
      sumPaise(paid._sum.platformFeePaise) +
      sumPaise(batched._sum.platformFeePaise) +
      sumPaise(ready._sum.platformFeePaise),
  };
}

// ============================================
// Organization Earnings Functions
// ============================================

/**
 * Get org earnings summary (parallels getConsultantEarningsSummary)
 */
export async function getOrgEarningsSummary(
  organizationId: string,
): Promise<OrgEarningsSummary> {
  const [pending, ready, batched, paid, held] = await Promise.all([
    prisma.organizationEarnings.aggregate({
      where: { organizationId, status: EarningStatus.PENDING },
      _sum: { orgSharePaise: true },
    }),
    prisma.organizationEarnings.aggregate({
      where: { organizationId, status: EarningStatus.READY },
      _sum: { orgSharePaise: true },
    }),
    prisma.organizationEarnings.aggregate({
      where: { organizationId, status: EarningStatus.BATCHED },
      _sum: { orgSharePaise: true },
    }),
    prisma.organizationEarnings.aggregate({
      where: { organizationId, status: EarningStatus.PAID },
      _sum: { orgSharePaise: true },
    }),
    prisma.organizationEarnings.aggregate({
      where: { organizationId, status: EarningStatus.HELD },
      _sum: { orgSharePaise: true },
    }),
  ]);

  const pendingEarnings = sumPaise(pending._sum.orgSharePaise);
  const readyEarnings = sumPaise(ready._sum.orgSharePaise);
  const batchedEarnings = sumPaise(batched._sum.orgSharePaise);
  const paidEarnings = sumPaise(paid._sum.orgSharePaise);
  const heldEarnings = sumPaise(held._sum.orgSharePaise);

  return {
    organizationId,
    // #837 — batched money is real cleared earnings in transit; keep it in the total.
    totalEarnings:
      pendingEarnings +
      readyEarnings +
      batchedEarnings +
      paidEarnings +
      heldEarnings,
    pendingEarnings,
    readyEarnings,
    batchedEarnings,
    paidEarnings,
    heldEarnings,
  };
}

/**
 * Get paginated org earnings list
 */
export async function getOrgEarnings(
  organizationId: string,
  options?: {
    status?: EarningStatus;
    limit?: number;
    offset?: number;
  },
) {
  const { status, limit = 20, offset = 0 } = options || {};

  const [earnings, total] = await Promise.all([
    prisma.organizationEarnings.findMany({
      where: {
        organizationId,
        ...(status ? { status } : {}),
      },
      include: {
        payment: {
          select: {
            id: true,
            amount: true,
            originalAmount: true,
            currency: true,
            createdAt: true,
            appointment: {
              select: {
                id: true,
                appointmentType: true,
              },
            },
          },
        },
        orgPayout: {
          select: {
            id: true,
            status: true,
            processedAt: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.organizationEarnings.count({
      where: {
        organizationId,
        ...(status ? { status } : {}),
      },
    }),
  ]);

  return {
    earnings,
    total,
    hasMore: offset + limit < total,
  };
}
