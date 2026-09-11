/**
 * Test: Reschedule Storm (N concurrent reschedules of one appointment)
 * Category: 07 - Real API booking races (#837 scenario 10)
 *
 * Ten concurrent reschedules of the same appointment. Reschedule is
 * re-entrant (PENDING is itself reschedulable), so multiple winners are
 * legal — the invariants are: zero 5xx, terminal slots never resurrected,
 * and the appointment ends in a single coherent state (PENDING + all live
 * slots tentative).
 */
import "dotenv/config";
import prisma from "../../../../../lib/prisma";
import {
  apiFetch,
  check,
  finish,
  fireConcurrent,
  histogram,
  loginAs,
  ensureServerOrSkip,
} from "../../utilities/api-client";

async function run() {
  await ensureServerOrSkip();

  const appointment = await prisma.appointment.findFirst({
    where: {
      consultation: { status: { in: ["PENDING", "APPROVED"] } },
      slotsOfAppointment: { some: { completionStatus: "SCHEDULED" } },
    },
    select: { id: true, consultation: { select: { id: true } } },
    skip: 1, // avoid the fixture used by cancel-vs-reschedule
  });
  if (!appointment) {
    console.log("⏭️  SKIP — no reschedulable consultation appointment in seed data");
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

  const terminalBefore = await prisma.slotOfAppointment.count({
    where: {
      appointmentId: appointment.id,
      completionStatus: { in: ["COMPLETED", "CANCELLED", "UNVERIFIED"] },
    },
  });

  const admin = await loginAs(
    process.env.CHAOS_ADMIN_EMAIL ?? "olivia.brown@protonmail.com",
  );

  const results = await fireConcurrent(10, () =>
    apiFetch(`/api/appointments/${appointment.id}/reschedule?type=CONSULTATION`, {
      method: "POST",
      session: admin,
      body: JSON.stringify({}),
    }),
  );

  const h = histogram(results);
  const serverErrors = results.filter((r) => r.status >= 500).length;
  check("reschedule storm: zero 5xx", serverErrors === 0, h);

  const consultation = await prisma.consultation.findUnique({
    where: { id: appointment.consultation!.id },
    select: { status: true },
  });
  check(
    "appointment ends in a single coherent state (PENDING)",
    consultation?.status === "PENDING",
    consultation,
  );

  const terminalAfter = await prisma.slotOfAppointment.count({
    where: {
      appointmentId: appointment.id,
      completionStatus: { in: ["COMPLETED", "CANCELLED", "UNVERIFIED"] },
    },
  });
  check(
    "terminal slots never resurrected",
    terminalAfter === terminalBefore,
    { terminalBefore, terminalAfter },
  );

  // Restore the fixture for repeat runs.
  await prisma.consultation.update({
    where: { id: appointment.consultation!.id },
    data: { status: originalConsultation.status },
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

  finish("reschedule-storm");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
