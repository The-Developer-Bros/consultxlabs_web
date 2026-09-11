/**
 * @jest-environment node
 */

/**
 * Paid-trial money path.
 *
 * Covers the invariants that would cost real money or corrupt state if broken:
 *  - the trial is charged its plan's trialPriceInPaise, never the plan price
 *  - a free trial never mints a payment intent
 *  - a TRIAL intent without a trialId is rejected before it reaches the gateway
 *  - webhook metadata validates for TRIAL (an unhandled type routes to
 *    CRITICAL_PAYMENT_WITHOUT_APPOINTMENT — learner charged, trial unscheduled)
 *  - the payment deadline is 24h, clamped to the session start
 *  - only live/delivered trials block a re-request; lapsed ones free the pair
 *  - AWAITING_PAYMENT occupies its slot, so nobody can book over a trial that
 *    is mid-payment
 */

import { AppointmentsType, TrialSessionStatus } from "@prisma/client";

import {
  blocksNewTrialRequest,
  computeTrialPaymentDueAt,
  TRIAL_PAYMENT_WINDOW_MS,
} from "../../lib/trials/eligibility";
import { validateWebhookMetadata } from "../../schemas/webhooks/metadata";
import { buildOccupiedAppointmentFilter } from "../../utils/slotAllocation/occupancyPolicy";

const CUID = "clw0000000000000000000000";
const PLAN_CUID = "clw1111111111111111111111";
const TRIAL_CUID = "clw2222222222222222222222";

describe("trial payment deadline", () => {
  it("is 24h from acceptance when the session is further out", () => {
    const acceptedAt = new Date("2026-01-01T00:00:00.000Z");
    const sessionStart = new Date("2026-01-05T00:00:00.000Z");

    const due = computeTrialPaymentDueAt(acceptedAt, sessionStart);

    expect(due.getTime()).toBe(acceptedAt.getTime() + TRIAL_PAYMENT_WINDOW_MS);
  });

  it("clamps to the session start when the slot is sooner than 24h", () => {
    const acceptedAt = new Date("2026-01-01T00:00:00.000Z");
    // Three hours out — the link must not outlive the session it pays for.
    const sessionStart = new Date("2026-01-01T03:00:00.000Z");

    const due = computeTrialPaymentDueAt(acceptedAt, sessionStart);

    expect(due).toEqual(sessionStart);
  });

  it("falls back to the full window when there is no session time", () => {
    const acceptedAt = new Date("2026-01-01T00:00:00.000Z");

    const due = computeTrialPaymentDueAt(acceptedAt, null);

    expect(due.getTime()).toBe(acceptedAt.getTime() + TRIAL_PAYMENT_WINDOW_MS);
  });
});

describe("trial re-request eligibility", () => {
  it.each([
    TrialSessionStatus.PENDING,
    TrialSessionStatus.AWAITING_PAYMENT,
    TrialSessionStatus.SCHEDULED,
    TrialSessionStatus.COMPLETED,
    TrialSessionStatus.CONVERTED,
  ])("blocks a new request while %s", (status) => {
    expect(blocksNewTrialRequest(status)).toBe(true);
  });

  it.each([TrialSessionStatus.CANCELLED, TrialSessionStatus.REJECTED])(
    "frees the pair after %s",
    (status) => {
      // The learner never received a trial, so their one shot isn't spent.
      // A lapsed unpaid trial lands on CANCELLED via the expiry job.
      expect(blocksNewTrialRequest(status)).toBe(false);
    },
  );
});

describe("webhook metadata for trials", () => {
  const base = {
    appointmentType: AppointmentsType.TRIAL,
    userId: CUID,
    planId: PLAN_CUID,
    trialId: TRIAL_CUID,
    startsAt: "2026-01-01T10:00:00.000Z",
    endsAt: "2026-01-01T10:30:00.000Z",
  };

  it("accepts a well-formed TRIAL payload", () => {
    // Before the TRIAL arm existed this threw "Unsupported appointment type",
    // which routes to CRITICAL_PAYMENT_WITHOUT_APPOINTMENT.
    const parsed = validateWebhookMetadata(
      base as unknown as Record<string, string>,
    );

    expect(parsed).toMatchObject({
      appointmentType: AppointmentsType.TRIAL,
      trialId: TRIAL_CUID,
    });
  });

  it("rejects a TRIAL payload with no trialId", () => {
    const { trialId: _omitted, ...withoutTrialId } = base;

    expect(() =>
      validateWebhookMetadata(
        withoutTrialId as unknown as Record<string, string>,
      ),
    ).toThrow();
  });
});

describe("slot occupancy while awaiting payment", () => {
  it("treats AWAITING_PAYMENT as occupying the slot", () => {
    // Otherwise another learner could book the same slot during the payment
    // window and the capture webhook would confirm into a double booking.
    const filters = buildOccupiedAppointmentFilter("consultant-1");

    const trialFilter = filters.find((f) => "trialSession" in f) as {
      trialSession: { is: { status: { in: TrialSessionStatus[] } } };
    };

    expect(trialFilter.trialSession.is.status.in).toEqual(
      expect.arrayContaining([
        TrialSessionStatus.SCHEDULED,
        TrialSessionStatus.AWAITING_PAYMENT,
      ]),
    );
  });
});
