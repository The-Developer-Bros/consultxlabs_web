/**
 * #1169 PR 2 — approval-path source contracts.
 *
 * These pin the five behaviors this PR establishes, so a refactor that
 * quietly reintroduces any of them fails loudly:
 * 1. No fabricated appointments: the paid-without-appointment state refuses
 *    (PaidWithoutAppointmentError) instead of inventing a slot at now+1h on
 *    the global client (CORE-3).
 * 2. Approval confirm never re-flips RESCHEDULED slots.
 * 3. No gateway round-trip inside the approval Serializable transaction —
 *    pay-links are minted after commit, with a retry path when minting fails.
 * 4. Approval links mint on RAZORPAY, unified across all three request types
 *    (#1165).
 * 5. Org sponsorship survives the approval flow (#1166 ORG-9): the request
 *    validates and stamps organizationId, and the payment carries it.
 */

import fs from "fs";
import path from "path";

const read = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf8");

const consultationsRoute = read(
  "app/api/bookings/consultations/[consultationId]/route.ts",
);
const subscriptionsRoute = read(
  "app/api/bookings/subscriptions/[subscriptionId]/route.ts",
);
const trialsRoute = read("app/api/trials/[trialId]/route.ts");
const approvalPayment = read("lib/payments/operations/approval-payment.ts");
const requestForApproval = read("app/api/slots/request-for-approval/route.ts");
const checkout = read("lib/payments/operations/checkout.ts");

describe("CORE-3 — no fabricated appointments on approval", () => {
  it("has removed createAppointmentForConsultation entirely", () => {
    expect(consultationsRoute).not.toContain(
      "async function createAppointmentForConsultation",
    );
    expect(consultationsRoute).not.toContain("addHours(startDate");
  });

  it("refuses the paid-without-appointment state with a typed 409", () => {
    expect(consultationsRoute).toContain("class PaidWithoutAppointmentError");
    expect(consultationsRoute).toContain(
      "throw new PaidWithoutAppointmentError(",
    );
    expect(consultationsRoute).toContain(
      "error instanceof PaidWithoutAppointmentError",
    );
  });
});

describe("approval confirm excludes RESCHEDULED slots", () => {
  it.each([
    ["consultations", consultationsRoute],
    ["subscriptions", subscriptionsRoute],
  ])("%s route filters completionStatus on the confirm flip", (_name, src) => {
    const confirmBlocks = src
      .split("data: { isTentative: false }")
      .slice(0, -1);
    expect(confirmBlocks.length).toBeGreaterThan(0);
    for (const block of confirmBlocks) {
      const tail = block.slice(-400);
      expect(tail).toContain('completionStatus: "SCHEDULED"');
    }
  });
});

describe("no gateway call inside the approval transaction", () => {
  it.each([
    ["consultations", consultationsRoute, "generatePaymentLink("],
    [
      "subscriptions",
      subscriptionsRoute,
      "generatePaymentLinkForSubscription(",
    ],
  ])("%s mints AFTER commit with a retry marker", (_name, src, mintCall) => {
    const txStart = src.indexOf("prisma.$transaction(");
    const txOptions = src.indexOf(
      "isolationLevel: Prisma.TransactionIsolationLevel.Serializable",
      txStart,
    );
    const inTx = src.slice(txStart, txOptions);
    expect(inTx).not.toContain(mintCall);
    expect(src).toContain("needsPaymentLink: true");
    expect(src).toContain("needsLinkRetry");
  });
});

describe("#1165 — approval gateway unified on RAZORPAY", () => {
  it("no approval route mints on STRIPE", () => {
    for (const src of [consultationsRoute, subscriptionsRoute, trialsRoute]) {
      expect(src).not.toContain("PaymentGateway.STRIPE");
      expect(src).toContain("PaymentGateway.RAZORPAY");
    }
  });
});

describe("#1166 ORG-9 — org sponsorship survives the approval flow", () => {
  it("the request validates and stamps organizationId", () => {
    expect(requestForApproval).toContain("canSponsor");
    expect(requestForApproval).toContain(
      "organizationId: organizationId ?? null",
    );
  });

  it("the approval payment carries organizationId to the Payment row and metadata", () => {
    expect(approvalPayment).toContain("organizationId?: string");
    expect(approvalPayment).toContain(
      "organizationId: params.organizationId ?? null",
    );
    expect(approvalPayment).toContain(
      "metadata.organizationId = params.organizationId",
    );
  });
});

describe("checkout hardening (#1093 tail + tentative visibility)", () => {
  it("the pre-booking conflict check sees live tentative holds", () => {
    const start = checkout.indexOf(
      "const existingBooking = await tx.slotOfAppointment.findFirst(",
    );
    expect(start).toBeGreaterThan(-1);
    const query = checkout
      .slice(start, checkout.indexOf("if (existingBooking)", start))
      // Comments in this window explain the removed predicate by name.
      .replace(/^\s*\/\/.*$/gm, "");
    // A confirmed-only predicate here hides an in-flight hold; occupancy
    // status is the whole check.
    expect(query).not.toContain("isTentative");
    expect(query).toContain("OR: buildOccupiedAppointmentFilter()");
  });

  it("the STEP-5 Serializable transaction is retried on P2034", () => {
    const step5 = checkout.indexOf(
      "// STEP 5: Create tentative appointment + payment record",
    );
    // #1435 — the window is measured in characters, so the comment block
    // between the marker and the call decides whether this passes. Strip the
    // comments and assert on the code instead of enlarging it again.
    const window = checkout
      .slice(step5, step5 + 2000)
      .replace(/^\s*\/\/.*$/gm, "");
    expect(window).toContain("withSerializableRetry(");
  });
});
