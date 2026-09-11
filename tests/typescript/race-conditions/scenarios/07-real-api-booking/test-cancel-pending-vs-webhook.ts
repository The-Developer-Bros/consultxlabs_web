/**
 * Test: Cancel-Pending vs Capture Webhook + Cancel-vs-Cancel (#849)
 * Category: 07 - Real API booking races
 *
 * A user abandons checkout and hits DELETE /api/checkout/pending/[paymentId]
 * at the same moment the gateway's payment.captured webhook lands. Both sides
 * CAS the payment inside Serializable transactions, so the invariants are:
 * no 5xx, the webhook is always ACKed, the payment never stays PENDING, and
 * the end state is one of the two consistent outcomes (or the documented
 * late-capture orphan, which the reconciler picks up for refund):
 *   A. cancel won  → payment EXPIRED, tentative slots deleted, parent CANCELLED
 *   B. webhook won → payment SUCCEEDED, slots confirmed, cancel got 409
 *   C. late capture → payment SUCCEEDED after a 200 cancel; slots stay deleted
 *      and the parent stays CANCELLED (orphan — flagged for refund, never a
 *      half-confirmed booking)
 *
 * Second leg: two concurrent DELETEs on a fresh PENDING payment — exactly one
 * 200, the loser 409 (CAS double-submit guard).
 *
 * Fixture is built directly via prisma (mock checkout confirms instantly, so
 * it can never produce a PENDING gateway payment) and restored afterwards.
 */
import "dotenv/config";
import crypto from "node:crypto";
import prisma from "../../../../../lib/prisma";
import {
  BASE_URL,
  apiFetch,
  check,
  finish,
  histogram,
  loginAs,
  ensureServerOrSkip,
} from "../../utilities/api-client";

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

interface Fixture {
  paymentId: string;
  paymentIntent: string;
}

async function createPendingPayment(
  userId: string,
  appointmentId: string,
  tag: string,
): Promise<Fixture> {
  const paymentIntent = `order_chaos_cp_${tag}_${process.pid}_${Date.now()}`;
  const payment = await prisma.payment.create({
    data: {
      amount: 10000,
      originalAmount: 10000,
      paymentMethod: "card",
      paymentIntent,
      paymentGateway: "RAZORPAY",
      paymentStatus: "PENDING",
      isMockPayment: true, // skip the real gateway-cancel call post-commit
      userId,
      appointmentId,
    },
    select: { id: true },
  });
  return { paymentId: payment.id, paymentIntent };
}

async function pollPaymentTerminal(paymentId: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const p = await prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: { paymentStatus: true },
    });
    if (p.paymentStatus !== "PENDING") return p.paymentStatus;
    await new Promise((r) => setTimeout(r, 200));
  }
  return "PENDING";
}

async function run() {
  await ensureServerOrSkip();

  // Fixture: a consultation appointment whose requester we can log in as.
  const appointment = await prisma.appointment.findFirst({
    where: {
      consultation: {
        status: {
          in: ["PENDING", "APPROVED", "APPROVED_PENDING_PAYMENT"],
        },
      },
      slotsOfAppointment: { some: {} },
    },
    select: {
      id: true,
      consultation: {
        select: {
          id: true,
          consultationPlanId: true,
          status: true,
          cancellationNotes: true,
          cancelledAt: true,
          // requestedBy is the ConsulteeProfile; the login + Payment.userId
          // need the underlying User.
          requestedBy: {
            select: { user: { select: { id: true, email: true } } },
          },
        },
      },
    },
  });
  if (!appointment?.consultation?.requestedBy?.user?.email) {
    console.log(
      "⏭️  SKIP — no consultation appointment with a requester in seed data",
    );
    process.exit(0);
  }
  const consultation = appointment.consultation;
  const requester = consultation.requestedBy.user;

  // Snapshot for restore.
  const originalSlots = await prisma.slotOfAppointment.findMany({
    where: { appointmentId: appointment.id },
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      isTentative: true,
      completionStatus: true,
      completedAt: true,
      deletedAt: true,
      consultantProfileId: true,
      user: { select: { id: true } },
    },
  });

  // Arm the fixture: parent awaiting payment, slots tentative.
  await prisma.consultation.update({
    where: { id: consultation.id },
    data: { status: "APPROVED_PENDING_PAYMENT" },
  });
  await prisma.slotOfAppointment.updateMany({
    where: { appointmentId: appointment.id },
    // The cancel path frees the hold by status now, so the arm has to clear
    // the tombstone as well as the tentative flag.
    data: { isTentative: true, completionStatus: "SCHEDULED", deletedAt: null },
  });

  const session = await loginAs(requester.email!);

  // A failed request/assertion anywhere below must still restore the shared
  // fixture (consultation status, slots, synthetic payments) — reruns were
  // flaky when an early throw skipped the tail cleanup.
  const createdPaymentIds: string[] = [];
  try {
    // ---------------------------------------------------------------------
    // Leg 1: cancel vs capture webhook (only when the webhook secret is set —
    // otherwise the route rejects the signature and the race is meaningless).
    // ---------------------------------------------------------------------
    let leg1: Fixture | null = null;
    if (WEBHOOK_SECRET) {
      leg1 = await createPendingPayment(requester.id, appointment.id, "leg1");
      createdPaymentIds.push(leg1.paymentId);
      const slot = originalSlots[0];
      const gatewayPaymentId = `pay_chaos_cp_${process.pid}_${Date.now()}`;
      const payload = JSON.stringify({
        entity: "event",
        account_id: "acc_chaos",
        event: "payment.captured",
        contains: ["payment"],
        payload: {
          payment: {
            entity: {
              id: gatewayPaymentId,
              entity: "payment",
              order_id: leg1.paymentIntent,
              status: "captured",
              amount: 10000,
              currency: "INR",
              notes: {
                appointmentType: "CONSULTATION",
                userId: requester.id,
                planId: consultation.consultationPlanId,
                startsAt: slot.startsAt.toISOString(),
                endsAt: slot.endsAt.toISOString(),
              },
            },
          },
        },
        created_at: Math.floor(Date.now() / 1000),
      });
      const signature = crypto
        .createHmac("sha256", WEBHOOK_SECRET)
        .update(payload)
        .digest("hex");

      const [cancelRes, webhookRes] = await Promise.all([
        apiFetch(`/api/checkout/pending/${leg1.paymentId}`, {
          method: "DELETE",
          session,
        }),
        fetch(`${BASE_URL}/api/webhooks/razorpay`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-razorpay-signature": signature,
          },
          body: payload,
        }).then(async (r) => ({
          status: r.status,
          body: await r.json().catch(() => null),
        })),
      ]);

      check(
        "leg1: webhook ACKed 2xx (gateway must stop retrying)",
        webhookRes.status >= 200 && webhookRes.status < 300,
        webhookRes,
      );
      check(
        "leg1: cancel never 5xx (200 win / 409 lose)",
        [200, 409].includes(cancelRes.status),
        cancelRes,
      );

      const finalStatus = await pollPaymentTerminal(leg1.paymentId);
      check("leg1: payment never stays PENDING", finalStatus !== "PENDING", {
        finalStatus,
      });

      const tentativeLeft = await prisma.slotOfAppointment.count({
        where: {
          appointmentId: appointment.id,
          isTentative: true,
          deletedAt: null,
        },
      });
      const parent = await prisma.consultation.findUniqueOrThrow({
        where: { id: consultation.id },
        select: { status: true },
      });
      const cancelWon = cancelRes.status === 200;

      if (finalStatus === "EXPIRED") {
        // Outcome A — cancel won cleanly.
        check("leg1/A: cancel reported the win", cancelWon, { cancelRes });
        check("leg1/A: tentative slots released", tentativeLeft === 0, {
          tentativeLeft,
        });
        // Released by status, never by delete: every slot of the cancelled
        // booking is still stored, CANCELLED and tombstoned.
        const releasedSlots = await prisma.slotOfAppointment.findMany({
          where: { appointmentId: appointment.id },
          select: { completionStatus: true, deletedAt: true },
        });
        check(
          "leg1/A: released slots are stored as CANCELLED tombstones",
          releasedSlots.length > 0 &&
            releasedSlots.every(
              (s) => s.completionStatus === "CANCELLED" && s.deletedAt !== null,
            ),
          releasedSlots,
        );
        check(
          "leg1/A: parent CANCELLED",
          parent.status === "CANCELLED",
          parent,
        );
      } else {
        // Outcome B (webhook won: cancel 409, slots confirmed) or the
        // documented late-capture orphan C (cancel 200, slots deleted,
        // parent CANCELLED, reconciler refunds). Never a half-state.
        const confirmed = await prisma.slotOfAppointment.count({
          where: { appointmentId: appointment.id, isTentative: false },
        });
        if (cancelWon) {
          check(
            "leg1/C: late capture left no half-confirmed booking (slots released, parent CANCELLED)",
            confirmed === 0 && parent.status === "CANCELLED",
            { confirmed, parent },
          );
        } else {
          check(
            "leg1/B: webhook win confirmed the booking (no tentative residue)",
            tentativeLeft === 0,
            { tentativeLeft, confirmed, parent },
          );
          check(
            "leg1/B: webhook win left the parent un-cancelled",
            parent.status !== "CANCELLED",
            parent,
          );
        }
      }
    } else {
      console.log("ℹ️  leg1 skipped — RAZORPAY_WEBHOOK_SECRET not set");
    }

    // ---------------------------------------------------------------------
    // Leg 2: cancel vs cancel — CAS double-submit guard.
    // ---------------------------------------------------------------------
    // Re-arm (leg 1 may have consumed the fixture state).
    await prisma.consultation.update({
      where: { id: consultation.id },
      data: { status: "APPROVED_PENDING_PAYMENT" },
    });
    for (const slot of originalSlots) {
      await prisma.slotOfAppointment.upsert({
        where: { id: slot.id },
        create: {
          id: slot.id,
          appointmentId: appointment.id,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          isTentative: true,
          completionStatus: slot.completionStatus,
          consultantProfileId: slot.consultantProfileId,
          user: { connect: slot.user.map((u) => ({ id: u.id })) },
        },
        update: {
          isTentative: true,
          completionStatus: "SCHEDULED",
          deletedAt: null,
        },
      });
    }

    const leg2 = await createPendingPayment(
      requester.id,
      appointment.id,
      "leg2",
    );
    createdPaymentIds.push(leg2.paymentId);
    const [c1, c2] = await Promise.all([
      apiFetch(`/api/checkout/pending/${leg2.paymentId}`, {
        method: "DELETE",
        session,
      }),
      apiFetch(`/api/checkout/pending/${leg2.paymentId}`, {
        method: "DELETE",
        session,
      }),
    ]);
    const results = [c1, c2];
    check(
      "leg2: no server errors",
      results.every((r) => r.status < 500),
      histogram(results),
    );
    check(
      "leg2: exactly one cancel wins (200), loser conflicts (409)",
      results.filter((r) => r.status === 200).length === 1 &&
        results.filter((r) => r.status === 409).length === 1,
      histogram(results),
    );
    const leg2Final = await prisma.payment.findUniqueOrThrow({
      where: { id: leg2.paymentId },
      select: { paymentStatus: true },
    });
    check(
      "leg2: payment EXPIRED exactly once",
      leg2Final.paymentStatus === "EXPIRED",
      leg2Final,
    );
  } finally {
    // -------------------------------------------------------------------
    // Restore the fixture for repeat runs — runs even when a leg threw.
    // Cancellation fields restore from the SNAPSHOT (not hard-nulled): a
    // shared dev fixture may legitimately carry pre-existing values.
    // -------------------------------------------------------------------
    await prisma.payment.deleteMany({
      where: { id: { in: createdPaymentIds } },
    });
    await prisma.consultation.update({
      where: { id: consultation.id },
      data: {
        status: consultation.status,
        cancellationNotes: consultation.cancellationNotes,
        cancelledAt: consultation.cancelledAt,
      },
    });
    for (const slot of originalSlots) {
      await prisma.slotOfAppointment.upsert({
        where: { id: slot.id },
        create: {
          id: slot.id,
          appointmentId: appointment.id,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          isTentative: slot.isTentative,
          completionStatus: slot.completionStatus,
          completedAt: slot.completedAt,
          deletedAt: slot.deletedAt,
          consultantProfileId: slot.consultantProfileId,
          user: { connect: slot.user.map((u) => ({ id: u.id })) },
        },
        update: {
          isTentative: slot.isTentative,
          completionStatus: slot.completionStatus,
          completedAt: slot.completedAt,
          deletedAt: slot.deletedAt,
        },
      });
    }
  }

  finish("cancel-pending-vs-webhook");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
