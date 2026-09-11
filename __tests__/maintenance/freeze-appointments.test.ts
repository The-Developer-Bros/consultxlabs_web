/**
 * #1162 / #1169 PR 3 — the maintenance freeze follows the cancellation
 * doctrine. These contracts pin the rewrite:
 * 1. NOTHING is deleted — no appointment.delete, no slotOfAppointment
 *    .deleteMany; slots soft-cancel and trials tombstone via their helper.
 * 2. Every status write is CAS-guarded through lib/booking/transitions (a
 *    COMPLETED booking cannot resurrect to CANCELLED).
 * 3. Refunds go through refundBookingPayment (refundable clamp + org / free credit
 *    rails), never raw createRefund with a gross amount, and a re-run's
 *    ALREADY_FULLY_REFUNDED surfaces as a skip.
 * 4. The payment include is UNFILTERED — the old SUCCEEDED-only include made
 *    PENDING-payment appointments look payment-free and deletable (P0-1).
 * 5. Open reschedule proposals are closed so openForAppointmentId frees.
 */

import fs from "fs";
import path from "path";

const freezeSource = fs.readFileSync(
  path.join(process.cwd(), "actions/maintenance/freeze-appointments.ts"),
  "utf8",
);

describe("freeze-appointments doctrine (#1162)", () => {
  it("deletes nothing", () => {
    expect(freezeSource).not.toContain(".appointment.delete");
    expect(freezeSource).not.toContain("slotOfAppointment.deleteMany");
  });

  it("soft-cancels slots with the cancel route's status guard", () => {
    expect(freezeSource).toContain(
      "completionStatus: { in: SLOT_RESCHEDULABLE_FROM }",
    );
    expect(freezeSource).toContain('completionStatus: "CANCELLED"');
  });

  it("uses CAS transitions for every event type", () => {
    for (const helper of [
      "transitionConsultationRequest",
      "transitionSubscriptionRequest",
      "transitionWebinarEvent",
      "transitionClassEvent",
    ]) {
      expect(freezeSource).toContain(`${helper}(tx, {`);
    }
    expect(freezeSource).toContain("IllegalTransitionError");
    // Raw unguarded event status writes are gone.
    expect(freezeSource).not.toContain("tx.consultation.update(");
    expect(freezeSource).not.toContain("tx.webinar.update(");
    expect(freezeSource).not.toContain("tx.class.update(");
  });

  it("guards the trial status flip and tombstones via the domain helper", () => {
    expect(freezeSource).toContain("softCancelTrialAppointment(");
    expect(freezeSource).toMatch(
      /trialSession\.updateMany\(\{\s*where:\s*\{\s*id: trial\.id,\s*status: \{ in:/,
    );
  });

  it("refunds through the front door with a graceful re-run skip", () => {
    expect(freezeSource).toContain("refundBookingPayment({");
    expect(freezeSource).not.toContain("createRefund({");
    expect(freezeSource).toContain("ALREADY_FULLY_REFUNDED");
  });

  it("loads payments unfiltered so PENDING payments keep their appointment", () => {
    expect(freezeSource).not.toContain('where: { paymentStatus: "SUCCEEDED" }');
    expect(freezeSource).toContain("paymentStatus: true");
  });

  it("closes open reschedule proposals", () => {
    expect(freezeSource).toContain("RESCHEDULE_OPEN_STATUSES");
    expect(freezeSource).toContain("openForAppointmentId: null");
  });
});

describe("booking-refund front door (#1161)", () => {
  const refundSource = fs.readFileSync(
    path.join(process.cwd(), "lib/payments/operations/booking-refund.ts"),
    "utf8",
  );

  it("routes free_ intents to credit restoration", () => {
    expect(refundSource).toContain("isFreeCreditIntent");
    expect(refundSource).toContain("refundFreeCreditPayment");
    expect(refundSource).toContain("reverseCreditsForPayment(payment.id, tx)");
  });

  it("whole-event refunds carry the credits bucket and re-run skips", () => {
    const eventSource = fs.readFileSync(
      path.join(process.cwd(), "lib/payments/operations/event-refunds.ts"),
      "utf8",
    );
    expect(eventSource).toContain("isFreeCreditIntent(p.paymentIntent)");
    expect(eventSource).toContain("skippedAlreadyRefunded");
    // The WHOLE-EVENT query must not filter by amount (free_ seats refund
    // as credit restoration); the per-seat tiered path keeps its filter, a
    // recorded #1161 residual.
    const start = eventSource.indexOf(
      "export async function refundWholeEventPayments",
    );
    const end = eventSource.indexOf(
      "export async function refundRemovedAttendeeSeat",
    );
    // A missing anchor would make slice() measure from the end of the file
    // and pass over the wrong range — fail loudly instead.
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const wholeEventQuery = eventSource.slice(start, end);
    expect(wholeEventQuery).not.toContain("amount: { gt: 0 }");
  });
});

describe("maintenance keys carry a TTL (#697 INF-1)", () => {
  const maintSource = fs.readFileSync(
    path.join(process.cwd(), "lib/maintenance.ts"),
    "utf8",
  );

  it("sets an expiry on both state keys", () => {
    expect(maintSource).toContain("MAINTENANCE_KEY_TTL_SECONDS");
    expect(maintSource).toMatch(
      /redis\.set\(REDIS_KEYS\.PHASE, phase, \{ ex: MAINTENANCE_KEY_TTL_SECONDS \}\)/,
    );
  });
});

describe("top-up refund respects the wallet floor (#1093 §2)", () => {
  const utilsSource = fs.readFileSync(
    path.join(process.cwd(), "app/api/webhooks/utils.ts"),
    "utf8",
  );

  it("claws back at most the balance and books the shortfall receivable", () => {
    expect(utilsSource).toContain("clawbackPaise");
    expect(utilsSource).toContain("shortfallPaise");
    expect(utilsSource).toContain('"ORG_RECEIVABLE"');
    expect(utilsSource).not.toContain(
      "data: { walletBalance: { decrement: refundAmt } }",
    );
  });
});
