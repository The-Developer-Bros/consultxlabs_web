/**
 * Test: Cancel vs Reschedule on the Same Appointment (multi-tab race)
 * Category: 07 - Real API booking races (#837 scenario 9)
 *
 * Two tabs act on the same appointment simultaneously: one cancels, one
 * reschedules. Ordering decides the winner count — reschedule-then-cancel
 * is legal (reschedule resets to PENDING, and PENDING is cancellable), so
 * the invariants are: no 5xx, never zero winners, a successful cancel is
 * NEVER resurrected, and slots never end in a CANCELLED+RESCHEDULED mix.
 */
import "dotenv/config";
import prisma from "../../../../../lib/prisma";
import {
  apiFetch,
  check,
  finish,
  histogram,
  loginAs,
  ensureServerOrSkip,
} from "../../utilities/api-client";

async function run() {
  await ensureServerOrSkip();

  // Fixture: a consultation appointment in a cancellable state with live slots.
  const appointment = await prisma.appointment.findFirst({
    where: {
      consultation: { status: { in: ["PENDING", "APPROVED"] } },
      slotsOfAppointment: { some: { completionStatus: "SCHEDULED" } },
    },
    select: { id: true, consultation: { select: { id: true } } },
  });
  if (!appointment) {
    console.log("⏭️  SKIP — no cancellable consultation appointment in seed data");
    process.exit(0);
  }

  // Capture the fixture so repeat runs do not consume the seed pool.
  const originalConsultation = await prisma.consultation.findUniqueOrThrow({
    where: { id: appointment.consultation!.id },
    select: { status: true },
  });
  const originalSlots = await prisma.slotOfAppointment.findMany({
    where: { appointmentId: appointment.id },
    select: { id: true, completionStatus: true, isTentative: true },
  });

  const admin = await loginAs(
    process.env.CHAOS_ADMIN_EMAIL ?? "olivia.brown@protonmail.com",
  );

  const [cancelRes, rescheduleRes] = await Promise.all([
    apiFetch(`/api/appointments/${appointment.id}/cancel`, {
      method: "POST",
      session: admin,
      body: JSON.stringify({}),
    }),
    apiFetch(`/api/appointments/${appointment.id}/reschedule?type=CONSULTATION`, {
      method: "POST",
      session: admin,
      body: JSON.stringify({}),
    }),
  ]);
  const results = [cancelRes, rescheduleRes];
  const winners = results.filter(
    (r) => r.status >= 200 && r.status < 300,
  ).length;
  const serverErrors = results.filter((r) => r.status >= 500).length;

  check("no server errors", serverErrors === 0, histogram(results));
  check("never zero winners", winners >= 1, histogram(results));

  // THE scenario-9 invariant: once a cancel has succeeded, the racing
  // reschedule must not resurrect the booking. (Two winners is legal only
  // in the reschedule-first ordering, and then the cancel's verdict stands.)
  const finalState = await prisma.consultation.findUniqueOrThrow({
    where: { id: appointment.consultation!.id },
    select: { status: true },
  });
  const cancelWon = cancelRes.status >= 200 && cancelRes.status < 300;
  check(
    "a successful cancel is never resurrected",
    !cancelWon || finalState.status === "CANCELLED",
    { cancelWon, finalState, h: histogram(results) },
  );
  check(
    "reschedule-only outcome lands on PENDING",
    cancelWon || finalState.status === "PENDING",
    { cancelWon, finalState },
  );

  // Consistency: slots must not be a mix of CANCELLED and RESCHEDULED.
  const slots = await prisma.slotOfAppointment.findMany({
    where: { appointmentId: appointment.id },
    select: { completionStatus: true, isTentative: true },
  });
  const statuses = new Set(slots.map((s) => s.completionStatus));
  check(
    "slots are consistent (no CANCELLED+RESCHEDULED mix)",
    !(statuses.has("CANCELLED") && statuses.has("RESCHEDULED")),
    slots,
  );

  // Restore the fixture for repeat runs (status, slots, cancel stamps).
  await prisma.consultation.update({
    where: { id: appointment.consultation!.id },
    data: {
      status: originalConsultation.status,
      cancellationReason: null,
      cancellationNotes: null,
      cancelledAt: null,
      cancelledBy: null,
    },
  });
  for (const slot of originalSlots) {
    await prisma.slotOfAppointment.update({
      where: { id: slot.id },
      data: {
        completionStatus: slot.completionStatus,
        isTentative: slot.isTentative,
      },
    });
  }

  finish("cancel-vs-reschedule-race");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
