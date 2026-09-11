import type { Tx, PrismaLike } from "@/lib/prisma";
/**
 * Program / ProgramAssignment helpers — replaces the old seat-helpers.ts
 * (acquireSeat / releaseSeat) with program-entitlement primitives.
 *
 * A `ProgramAssignment` is the per-member entitlement row — one per
 * (Program, Membership, periodStart) tuple.
 *
 * LICENSED_SEAT programs:
 *   - An assignment represents one "seat" consumed in the current cycle.
 *   - `activeSeatCount` on LicensedSeatConfig tracks the aggregate across
 *     all non-completed assignments.
 *   - `coveredEngagementsPerCycle` is the cap per assignment in
 *     *engagement* units (one engagement = one Appointment row = one
 *     calendar occurrence). null = unlimited (was PREPAID_UNLIMITED).
 *     CONSULTATION/WEBINAR debit 1 at checkout; CLASS debits N at
 *     enrolment (one per class day); SUBSCRIPTION debits 1 per
 *     consultant allocation. Per-engagement *price* is governed by
 *     `priceCapPerEngagementPaise` (separate concern).
 *
 * CREDIT_POOL programs:
 *   - An assignment represents access authorization; actual debits hit
 *     the wallet via `walletDebit` against the per-cycle credit cap
 *     (1 credit = ₹1 = 100 paise; see schema.prisma).
 *
 * Overage behaviour is driven by `LicensedSeatConfig.overageBehavior`:
 *   - BLOCK: checkout returns 402.
 *   - CHARGE_MEMBER: learner pays overage on own card.
 *   - CHARGE_ORG: overage added to the next invoice cycle.
 */

import type { ProgramAssignment, ProgramType } from "@prisma/client";
import { transitionOverage } from "@/lib/payments/billing/overage-transitions";
import { sumPaise } from "@/lib/payments/utils/money";

// #780 — reads come through the extended client (money as number); the raw
// model type still says bigint.
type ProgramAssignmentRow = Omit<ProgramAssignment, "consumedPaise"> & {
  consumedPaise: number;
};

export class ProgramAssignmentLimitError extends Error {
  constructor(
    public programId: string,
    public membershipId: string,
  ) {
    super(
      `Program assignment at overage cap for program=${programId} membership=${membershipId}`,
    );
    this.name = "ProgramAssignmentLimitError";
  }
}

/**
 * Resolve the ACTIVE assignment for a membership against a program for a
 * given point in time. Returns null if no active assignment.
 */
export async function resolveActiveAssignment(
  prisma: PrismaLike,
  params: { programId: string; membershipId: string; at?: Date },
): Promise<ProgramAssignmentRow | null> {
  const at = params.at ?? new Date();
  return prisma.programAssignment.findFirst({
    where: {
      programId: params.programId,
      membershipId: params.membershipId,
      periodStart: { lte: at },
      periodEnd: { gte: at },
    },
    // #750 — boundary instants (periodEnd == next periodStart) match two
    // rows; without an order the pick is arbitrary. Latest cycle wins,
    // consistent with checkout's resolver.
    orderBy: { periodEnd: "desc" },
  });
}

/**
 * Create or upsert a ProgramAssignment. Used when:
 *   - An org admin assigns a Program to a Membership.
 *   - A cycle rolls over (cron creates next-period rows).
 *
 * The unique constraint (programId, membershipId, periodStart) enforces
 * idempotency.
 */
export class ProgramAssignmentOverlapError extends Error {
  readonly httpStatus = 409;
  constructor(
    public programId: string,
    public membershipId: string,
  ) {
    super(
      `An assignment for this member already covers an overlapping period on program=${programId}`,
    );
    this.name = "ProgramAssignmentOverlapError";
  }
}

export async function claimProgramAssignment(
  tx: Tx,
  params: {
    programId: string;
    membershipId: string;
    periodStart: Date;
    periodEnd: Date;
  },
): Promise<{ assignment: ProgramAssignmentRow; created: boolean }> {
  // #778 §B — the @@unique on (programId, membershipId, periodStart) can't
  // stop two OVERLAPPING cycles with different starts, and Postgres exclusion
  // constraints aren't Prisma-expressible. Overlap double-counts caps/seats in
  // reconcile, so reject here; the exact-same-periodStart re-claim stays
  // idempotent via the createMany path below.
  const overlapping = await tx.programAssignment.findFirst({
    where: {
      programId: params.programId,
      membershipId: params.membershipId,
      status: "ACTIVE",
      periodStart: { lt: params.periodEnd, not: params.periodStart },
      periodEnd: { gt: params.periodStart },
    },
    select: { id: true },
  });
  if (overlapping) {
    throw new ProgramAssignmentOverlapError(
      params.programId,
      params.membershipId,
    );
  }

  // #785 — report whether THIS call created the row so the caller can
  // increment activeSeatCount exactly once. `createMany({ skipDuplicates })`
  // is INSERT … ON CONFLICT DO NOTHING: it returns count===1 for the single
  // racer that wins the unique (programId, membershipId, periodStart) and
  // count===0 for a re-claim/concurrent duplicate — and, unlike a caught
  // P2002, does NOT poison the surrounding transaction. Replaces the route's
  // racy preexisting-probe that let two concurrent POSTs both seat-count.
  const ins = await tx.programAssignment.createMany({
    data: [
      {
        programId: params.programId,
        membershipId: params.membershipId,
        periodStart: params.periodStart,
        periodEnd: params.periodEnd,
      },
    ],
    skipDuplicates: true,
  });
  const assignment = await tx.programAssignment.findUniqueOrThrow({
    where: {
      programId_membershipId_periodStart: {
        programId: params.programId,
        membershipId: params.membershipId,
        periodStart: params.periodStart,
      },
    },
  });
  return { assignment, created: ins.count === 1 };
}

/**
 * Atomically record a booking utilization against an assignment.
 *
 * For LICENSED_SEAT programs, increments `engagementsUsed` (and
 * `overageCount` when over cap per overageBehavior).
 *
 * For CREDIT_POOL programs, just records the utilization row; the wallet
 * debit is done separately via `walletDebit` and the per-cycle credit
 * cap is enforced there (1 credit = ₹1).
 *
 * `engagementsConsumed` is in *engagement* units (one engagement = one
 * Appointment row = one calendar occurrence), NOT slots and NOT bookings.
 * Callers:
 *   - CONSULTATION/WEBINAR: pass at checkout, always 1 (one Appointment).
 *   - CLASS: pass at checkout, equal to the count of distinct
 *     Appointments the learner is being enrolled in (slots are
 *     pre-allocated by the consultant; all appointments are known then).
 *   - SUBSCRIPTION: pass at slot-allocation time
 *     (`SlotAllocationService.createAppointments`), 1 per consultant
 *     allocation — checkout creates only a placeholder appointment for
 *     SUBSCRIPTION and does NOT call this helper.
 *
 * Returns the utilization snapshot. Throws `ProgramAssignmentLimitError`
 * if cap hit and overageBehavior=BLOCK.
 */
export async function recordBookingUtilization(
  tx: Tx,
  params: {
    programAssignmentId: string;
    paymentId: string;
    engagementsConsumed: number;
    priceAtBookingPaise: number;
    /**
     * PR-1e (G3): identifiers of the appointments this call is counting.
     * When provided, the helper compares against the BookingUtilization's
     * `appointmentIds` set and only counts the *new* members of `incoming
     * - alreadyTracked`. Re-allocation (delete + recreate) flows that pass
     *  the same appointment id twice become idempotent.
     *
     * For CONSULTATION/WEBINAR/CLASS the caller knows all appointments
     * up front, so passing them here turns the upsert into a true
     * idempotent operation. For SUBSCRIPTION the caller passes whatever
     * appointment ids are being added in this allocation batch.
     *
     * If omitted (legacy callers), behavior is unchanged: every call
     * unconditionally increments by `engagementsConsumed`.
     */
    appointmentIds?: string[];
  },
): Promise<{
  wasOverage: boolean;
  engagementsConsumedDelta: number;
  // #768 #22 — post-increment cap state so the caller can detect the
  // <80% → >=80% cap-near transition. `cap` null = unlimited (no warning).
  engagementsUsedAfter: number;
  cap: number | null;
  // #775/#753 — CREDIT_POOL money-meter. `programType` lets the caller pick
  // the right computeOverage() shape; `consumedPaiseAfter`/`creditBudgetPaise`
  // drive the meter + cap-near for CREDIT_POOL (both null/0 for LICENSED_SEAT).
  programType: ProgramType;
  consumedPaiseAfter: number;
  creditBudgetPaise: number | null;
}> {
  if (params.engagementsConsumed < 0) {
    throw new Error(
      `recordBookingUtilization: engagementsConsumed must be non-negative; got ${params.engagementsConsumed}`,
    );
  }

  // Read the program config once — the cap + behavior values aren't racy
  // (schema-side config is stable across the transaction). The racy part
  // is the engagementsUsed increment, which we perform via a conditional
  // UPDATE so two concurrent bookings can't both pass the cap check.
  const assignment = await tx.programAssignment.findUniqueOrThrow({
    where: { id: params.programAssignmentId },
    select: {
      programId: true,
      membershipId: true,
      // #768 #22 — pre-increment count. The BLOCK / unlimited branches use a
      // bare conditional UPDATE (no RETURNING) so we derive engagementsUsedAfter
      // as preCount + delta; the CHARGE_* branch reads the post value directly.
      engagementsUsed: true,
      // #775/#753 — CREDIT_POOL money-meter pre-increment value.
      consumedPaise: true,
      program: {
        select: {
          type: true,
          licensedSeatConfig: {
            select: {
              coveredEngagementsPerCycle: true,
              overageBehavior: true,
            },
          },
          creditPoolConfig: {
            select: {
              creditBudgetPerCycle: true,
              overageBehavior: true,
            },
          },
        },
      },
    },
  });

  // PR-1e (G3): if the caller provided appointmentIds, dedup against
  // any already counted on this BookingUtilization row. The new delta
  // is the count of incoming ids NOT yet tracked. Skip the helper
  // entirely if nothing new to count.
  let actualDelta = params.engagementsConsumed;
  let newAppointmentIds: string[] | undefined;
  if (params.appointmentIds !== undefined) {
    const existing = await tx.bookingUtilization.findUnique({
      where: { paymentId: params.paymentId },
      select: { appointmentIds: true },
    });
    const alreadyTracked = new Set(existing?.appointmentIds ?? []);
    newAppointmentIds = params.appointmentIds.filter(
      (id) => !alreadyTracked.has(id),
    );
    actualDelta = newAppointmentIds.length;
    if (actualDelta === 0) {
      return {
        wasOverage: false,
        engagementsConsumedDelta: 0,
        engagementsUsedAfter: assignment.engagementsUsed ?? 0,
        cap: null,
        programType: assignment.program.type ?? "LICENSED_SEAT",
        consumedPaiseAfter: assignment.consumedPaise ?? 0,
        creditBudgetPaise: null,
      };
    }
  } else if (params.engagementsConsumed === 0) {
    // No appointmentIds + zero delta = nothing to do (legacy callers).
    return {
      wasOverage: false,
      engagementsConsumedDelta: 0,
      engagementsUsedAfter: assignment.engagementsUsed ?? 0,
      cap: null,
      programType: assignment.program.type ?? "LICENSED_SEAT",
      consumedPaiseAfter: assignment.consumedPaise ?? 0,
      creditBudgetPaise: null,
    };
  }

  // #775/#753 — LICENSED_SEAT meters by engagement COUNT against
  // `coveredEngagementsPerCycle`; CREDIT_POOL meters by PAISE against
  // `creditBudgetPerCycle × 100` (1 credit = ₹1). Pick the unit + behavior source.
  const programType: ProgramType = assignment.program.type ?? "LICENSED_SEAT";
  const isCredit = programType === "CREDIT_POOL";
  const cap = isCredit
    ? null
    : (assignment.program.licensedSeatConfig?.coveredEngagementsPerCycle ??
      null);
  const creditBudgetPaise = isCredit
    ? (assignment.program.creditPoolConfig?.creditBudgetPerCycle ?? 0) * 100
    : null;
  const behavior = isCredit
    ? (assignment.program.creditPoolConfig?.overageBehavior ?? "BLOCK")
    : (assignment.program.licensedSeatConfig?.overageBehavior ?? "BLOCK");
  const pricePaise = Math.max(0, Math.floor(params.priceAtBookingPaise));

  // Atomic conditional increment — mirrors the walletDebit pattern, but via
  // Prisma's typed API. A numeric guard in `updateMany.where` compiles to a
  // single `UPDATE … WHERE meter <= cap - delta`, so it's exactly as atomic as
  // raw SQL (two concurrent bookings can't both pass) while staying type-safe:
  //   - No cap: unconditional increment.
  //   - Cap with BLOCK: guarded increment; count===0 ⇒ cap exceeded → throw.
  //   - Cap with CHARGE_*: unconditional increment (post value from `update`),
  //     flag overage when it crossed the cap; bump overageCount only then.
  let wasOverage = false;
  // #768 #22 — post-increment count so the caller can compute the cap-near
  // transition. BLOCK / unlimited derive it as preCount + delta; CHARGE_* read
  // the authoritative post value from the `update` return.
  const preCount = assignment.engagementsUsed ?? 0;
  let engagementsUsedAfter = preCount + actualDelta;
  // CREDIT_POOL money-meter post value (always advances engagementsUsed too so
  // the reconcile invariant on engagementsUsed still holds for credit pools).
  let consumedPaiseAfter =
    (assignment.consumedPaise ?? 0) + (isCredit ? pricePaise : 0);

  if (isCredit) {
    const budget = creditBudgetPaise ?? 0;
    if (behavior === "BLOCK") {
      const res = await tx.programAssignment.updateMany({
        where: {
          id: params.programAssignmentId,
          consumedPaise: { lte: budget - pricePaise },
        },
        data: {
          engagementsUsed: { increment: actualDelta },
          consumedPaise: { increment: pricePaise },
        },
      });
      if (res.count === 0) {
        throw new ProgramAssignmentLimitError(
          assignment.programId,
          assignment.membershipId,
        );
      }
    } else {
      const updated = await tx.programAssignment.update({
        where: { id: params.programAssignmentId },
        data: {
          engagementsUsed: { increment: actualDelta },
          consumedPaise: { increment: pricePaise },
        },
        select: { engagementsUsed: true, consumedPaise: true },
      });
      engagementsUsedAfter = updated.engagementsUsed;
      consumedPaiseAfter = updated.consumedPaise;
      wasOverage = consumedPaiseAfter > budget;
      if (wasOverage) {
        await tx.programAssignment.update({
          where: { id: params.programAssignmentId },
          data: { overageCount: { increment: 1 } },
        });
      }
    }
  } else if (cap === null) {
    await tx.programAssignment.update({
      where: { id: params.programAssignmentId },
      data: { engagementsUsed: { increment: actualDelta } },
    });
  } else if (behavior === "BLOCK") {
    const res = await tx.programAssignment.updateMany({
      where: {
        id: params.programAssignmentId,
        engagementsUsed: { lte: cap - actualDelta },
      },
      data: { engagementsUsed: { increment: actualDelta } },
    });
    if (res.count === 0) {
      throw new ProgramAssignmentLimitError(
        assignment.programId,
        assignment.membershipId,
      );
    }
  } else {
    // CHARGE_MEMBER / CHARGE_ORG: unconditional increment; `update` returns the
    // post value (no follow-up SELECT). overageCount bumps only when this
    // booking actually crossed the cap.
    const updated = await tx.programAssignment.update({
      where: { id: params.programAssignmentId },
      data: { engagementsUsed: { increment: actualDelta } },
      select: { engagementsUsed: true },
    });
    engagementsUsedAfter = updated.engagementsUsed;
    wasOverage = engagementsUsedAfter > cap;
    if (wasOverage) {
      await tx.programAssignment.update({
        where: { id: params.programAssignmentId },
        data: { overageCount: { increment: 1 } },
      });
    }
  }

  // Upsert the BookingUtilization on paymentId (which is @unique).
  //   - CONSULTATION/WEBINAR/CLASS: called once per Payment, so this is
  //     effectively an insert.
  //   - SUBSCRIPTION: called once per consultant allocation (lazy). The
  //     first allocation inserts the row; subsequent allocations
  //     increment engagementsConsumed by the *new* delta (computed via
  //     appointmentIds set-diff above). priceAtBookingPaise keeps the
  //     original (the upfront subscription price); incremental
  //     allocations pass `priceAtBookingPaise: 0` since no new money
  //     changed hands at allocation time.
  await tx.bookingUtilization.upsert({
    where: { paymentId: params.paymentId },
    create: {
      programAssignmentId: params.programAssignmentId,
      paymentId: params.paymentId,
      engagementsConsumed: actualDelta,
      priceAtBookingPaise: params.priceAtBookingPaise,
      wasOverage,
      appointmentIds: newAppointmentIds ?? [],
    },
    update: {
      engagementsConsumed: { increment: actualDelta },
      // Sticky once true — any allocation that crossed the cap marks
      // the row as having had an overage at some point.
      wasOverage: wasOverage ? true : undefined,
      appointmentIds: newAppointmentIds
        ? { push: newAppointmentIds }
        : undefined,
    },
  });

  // The ledger is append-only. Every call writes a fresh row, so the
  // sum across rows for this paymentId equals the BookingUtilization's
  // engagementsConsumed (after upsert).
  await tx.usageLedgerEntry.create({
    data: {
      programAssignmentId: params.programAssignmentId,
      membershipId: assignment.membershipId,
      paymentId: params.paymentId,
      engagementsConsumed: actualDelta,
      priceAtBookingPaise: params.priceAtBookingPaise,
      wasOverage,
    },
  });

  return {
    wasOverage,
    engagementsConsumedDelta: actualDelta,
    engagementsUsedAfter,
    cap,
    programType,
    consumedPaiseAfter,
    creditBudgetPaise,
  };
}

/**
 * Reverse a utilization on refund. Decrements engagementsUsed, writes a
 * correcting UsageLedgerEntry (we don't delete the original — the ledger
 * is append-only for audit).
 *
 * Partial reversal (PR-1e / G2): callers may pass `engagementsToReverse`
 * to reverse only a fraction of the original consumption — used by the
 * refund webhook when `refundAmount < paymentAmount`. The function
 * derives "already reversed" from the sum of negative
 * `UsageLedgerEntry` rows for this paymentId, then clamps the new
 * reversal to `min(target, remaining)`. Multiple partial reversals on
 * the same booking are supported (e.g., refund 25% now, another 50%
 * later); `reversedAt` is stamped only when the cumulative reversal
 * fully exhausts the original consumption.
 */
export async function reverseBookingUtilization(
  tx: Tx,
  params: {
    paymentId: string;
    reason?: string;
    /**
     * Fraction of the original `engagementsConsumed` to reverse.
     * Defaults to full. Pass an explicit count for partial refunds.
     * Negative or zero → no-op.
     */
    engagementsToReverse?: number;
    /**
     * #776 — refund ratio for the MONEY meter. The engagement count above is
     * `ceil`'d so a partial refund still releases ≥1 whole seat; deriving the
     * reversed *price* from that ceil'd count overstates `consumedPaise` and the
     * `UsageLedgerEntry` price (breaks REFUND_BOOKING_COHERENCE). When refunding,
     * pass the actual paise so the money-meter reverses in proportion to the
     * booking price, independent of the engagement rounding. Clamped to the
     * unreversed price remainder.
     */
    refundRatio?: { refundAmountPaise: number; paymentAmountPaise: number };
  },
): Promise<{
  reversed: boolean;
  engagementsReversed: number;
  fullyReversed: boolean;
}> {
  // Restore engagements via a reversal LEDGER ENTRY, not by deleting the
  // original BookingUtilization row. Deleting would destroy the history
  // needed by analytics ("who used seats in Q1?"), audits ("was this
  // member assigned on 2026-04-10?"), and partial-refund support (we may
  // need to reverse more than once). Instead we stamp `reversedAt` on
  // the row when fully exhausted and append an opposing UsageLedgerEntry;
  // the row stays queryable forever and the ledger sum still nets to the
  // correct usage.
  const util = await tx.bookingUtilization.findUnique({
    where: { paymentId: params.paymentId },
    include: {
      programAssignment: {
        include: { program: { select: { type: true } } },
      },
    },
  });
  if (!util) {
    return { reversed: false, engagementsReversed: 0, fullyReversed: false };
  }

  // Derive "already reversed" from the immutable ledger. Negative
  // entries are reversal markers; their absolute sum is the cumulative
  // reversed count to date.
  const reversalLedger = await tx.usageLedgerEntry.aggregate({
    where: {
      paymentId: params.paymentId,
      engagementsConsumed: { lt: 0 },
    },
    _sum: { engagementsConsumed: true },
  });
  const alreadyReversed = -1 * (reversalLedger._sum.engagementsConsumed ?? 0);
  const remainingReversible = Math.max(
    0,
    util.engagementsConsumed - alreadyReversed,
  );

  if (remainingReversible === 0) {
    // Already fully reversed — idempotent no-op.
    return { reversed: false, engagementsReversed: 0, fullyReversed: true };
  }

  const target =
    params.engagementsToReverse === undefined
      ? util.engagementsConsumed
      : Math.max(0, params.engagementsToReverse);
  const actualReversal = Math.min(target, remainingReversible);
  if (actualReversal <= 0) {
    return { reversed: false, engagementsReversed: 0, fullyReversed: false };
  }

  const willBeFullyReversed =
    alreadyReversed + actualReversal >= util.engagementsConsumed;

  // Prorate the price refund so the ledger sum stays consistent with
  // the partial reversal. Round to the nearest paise; the integer
  // round-off lands within ±1 paise of the proportional amount.
  const engagementDerivedPrice =
    util.engagementsConsumed > 0
      ? Math.round(
          (util.priceAtBookingPaise * actualReversal) /
            util.engagementsConsumed,
        )
      : 0;

  // #776 — when a refund ratio is supplied, reverse the price in proportion to
  // the actual money refunded (booking price × refundAmount/paymentAmount) rather
  // than the ceil'd engagement count, clamped to the unreversed price remainder.
  // Keeps consumedPaise + the usage ledger coherent with the refund (a 75k refund
  // of a 2×100k booking reverses 75k of price even though it releases 1 seat).
  let priceReversal = engagementDerivedPrice;
  if (params.refundRatio && params.refundRatio.paymentAmountPaise > 0) {
    const priceLedger = await tx.usageLedgerEntry.aggregate({
      where: { paymentId: params.paymentId, priceAtBookingPaise: { lt: 0 } },
      _sum: { priceAtBookingPaise: true },
    });
    const alreadyReversedPrice =
      -1 * sumPaise(priceLedger._sum.priceAtBookingPaise);
    const remainingPrice = Math.max(
      0,
      util.priceAtBookingPaise - alreadyReversedPrice,
    );
    const proportional = Math.floor(
      (util.priceAtBookingPaise * params.refundRatio.refundAmountPaise) /
        params.refundRatio.paymentAmountPaise,
    );
    priceReversal = Math.min(Math.max(0, proportional), remainingPrice);
  }

  await tx.programAssignment.update({
    where: { id: util.programAssignmentId },
    data: {
      engagementsUsed: { decrement: actualReversal },
      // #775/#753 — CREDIT_POOL meters in paise; reverse the prorated price so
      // consumedPaise nets back. LICENSED_SEAT leaves it untouched.
      consumedPaise:
        util.programAssignment.program?.type === "CREDIT_POOL"
          ? { decrement: priceReversal }
          : undefined,
      // overageCount tracks the number of OVER-CAP BOOKINGS, not units.
      // Decrement only on the LAST reversal (the booking is now wholly
      // un-counted). Partial reversals leave the flag in place — the
      // booking still happened over cap.
      overageCount:
        util.wasOverage && willBeFullyReversed ? { decrement: 1 } : undefined,
    },
  });

  await tx.usageLedgerEntry.create({
    data: {
      programAssignmentId: util.programAssignmentId,
      membershipId: util.programAssignment.membershipId,
      paymentId: params.paymentId,
      engagementsConsumed: -actualReversal,
      priceAtBookingPaise: -priceReversal,
      wasOverage: util.wasOverage,
      notes: params.reason ?? "Reversal on refund",
    },
  });

  // Stamp `reversedAt` only when the cumulative reversal fully exhausts
  // the original consumption. Subsequent partial calls update the
  // ledger but don't re-stamp.
  if (willBeFullyReversed) {
    await tx.bookingUtilization.update({
      where: { paymentId: params.paymentId },
      data: {
        reversedAt: new Date(),
        reversalReason: params.reason ?? "Refund",
      },
    });
    // #775 — the over-cap charge for this booking is no longer owed. Cancel the
    // linked OverageEvent only while it's still uncollected — an already-CHARGED
    // overage (member card captured, or org invoice paid) needs a real refund /
    // credit note, handled by the refund cascade (#715/#716), not a silent flip.
    // fromIn excludes CHARGED explicitly now that REVERSED accepts it.
    await transitionOverage(
      tx,
      { bookingUtilizationId: util.id },
      "REVERSED",
      undefined,
      { fromIn: ["PENDING", "ACCRUED", "FAILED"] },
    );
  }

  return {
    reversed: true,
    engagementsReversed: actualReversal,
    fullyReversed: willBeFullyReversed,
  };
}
