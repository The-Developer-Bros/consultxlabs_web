/**
 * @jest-environment node
 */

/**
 * #1319 — the status writes that bypassed the CAS helpers. Each site below is
 * pinned at the source level: the guard has to be in the WHERE (or the helper
 * has to be called), never re-implemented as a read-then-write. Cheap, and it
 * catches a revert during a merge conflict that a mocked unit test would miss.
 */

import fs from "fs";
import path from "path";

const read = (file: string) =>
  fs.readFileSync(path.join(process.cwd(), file), "utf8");

describe("group-event status writes go through the CAS helpers", () => {
  it("webinars crud-with-plan never writes a client status with a bare update", () => {
    const src = read("app/api/bookings/webinars/crud-with-plan/route.ts");
    expect(src).not.toMatch(/webinarUpdateData\.status\s*=/);
    expect(src).toContain("transitionWebinarEvent(");
    expect(src).toContain("EVENT_PUBLISHABLE_FROM");
    expect(src).toContain("instanceof IllegalTransitionError");
  });

  it("classes crud-with-plan never writes a client status with a bare update", () => {
    const src = read("app/api/bookings/classes/crud-with-plan/route.ts");
    expect(src).not.toMatch(/classUpdateData\.status\s*=/);
    expect(src).toContain("transitionClassEvent(");
    expect(src).toContain("instanceof IllegalTransitionError");
  });

  it("auto-complete marks webinars/classes COMPLETED only from the allowed set", () => {
    const src = read("scripts/appointments/auto-complete-appointments.ts");
    expect(src).not.toMatch(/prisma\.webinar\.update\(/);
    expect(src).not.toMatch(/prisma\.class\.update\(/);
    expect(src).not.toMatch(/prisma\.trialSession\.update\(/);
    expect(src).toContain("EVENT_ALLOWED_FROM.COMPLETED");
    expect(src).toContain("transitionTrialSession(");
  });
});

describe("sweeps cancel only from a cancellable state", () => {
  it("cleanup-invalid-appointments CASes each request before releasing its slots, in one tx", () => {
    const src = read("scripts/appointments/cleanup-invalid-appointments.ts");
    // Four sweeps, one helper: the request CAS (CANCELLABLE_FROM) commits
    // first and the slot release is scoped to that request, inside one tx.
    expect(
      (
        src.match(
          /cancelRequestsAndReleaseSlots\(\s*"(consultation|subscription)"/g,
        ) ?? []
      ).length,
    ).toBe(4);
    expect((src.match(/fromIn: CANCELLABLE_FROM/g) ?? []).length).toBe(2);
    expect(src).not.toMatch(/transitionSlotCompletion\(prisma,/);
  });

  it("cleanup-stale-pending-consultations' from-set is its own cohort (APPROVED*)", () => {
    const src = read(
      "scripts/appointments/cleanup-stale-pending-consultations.ts",
    );
    expect(src).toContain("transitionConsultationRequest(tx, {");
    expect(src).toMatch(
      /fromIn: \[\s*AppointmentStatus\.APPROVED,\s*AppointmentStatus\.APPROVED_PENDING_PAYMENT,?\s*\]/,
    );
    expect(src).not.toContain("fromIn: [AppointmentStatus.PENDING]");
  });
});

describe("slot completion writers use transitionSlotCompletion", () => {
  for (const file of [
    "lib/stream/session-handlers.ts",
    "jobs/meetings/reconcile-orphaned-sessions.ts",
    "actions/maintenance/drain-sessions.ts",
  ]) {
    it(`${file} has no bare completionStatus write`, () => {
      const src = read(file);
      expect(src).not.toMatch(
        /slotOfAppointment\.update\(\{[\s\S]*?completionStatus/,
      );
      expect(src).toContain("transitionSlotCompletion(");
    });
  }
});

describe("trial status writers use transitionTrialSession", () => {
  it("the trial route never writes status with a bare update", () => {
    const src = read("app/api/trials/[trialId]/route.ts");
    expect(src).not.toMatch(
      /trialSession\.update\(\{\s*where: \{ id: trialId \},\s*data: \{\s*status:/,
    );
    expect(
      (src.match(/transitionTrialSession\(/g) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("checkout converts a trial through the helper", () => {
    const src = read("lib/payments/operations/checkout.ts");
    expect(src).not.toMatch(/status: TrialSessionStatus\.CONVERTED/);
    expect(src).toContain("to: TrialSessionStatus.CONVERTED");
  });
});

describe("admin refunds use the booking front door", () => {
  it("the single-payment arm calls refundBookingPayment, never raw refundPayment", () => {
    const src = read("app/api/admin/refunds/route.ts");
    expect(src).not.toMatch(/\brefundPayment\(/);
    expect(src).toContain("refundBookingPayment(");
  });
});
