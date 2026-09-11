/**
 * Test: Approve vs Decline Race on a Pending Consultation (#836)
 * Category: 07 - Real API booking races (#837 scenario 11)
 *
 * A consultant approves while the same request is concurrently declined
 * (two tabs / two staff members). The allowed-from WHERE guard must let
 * exactly one transition win; the loser gets 409, never a silent overwrite.
 */
import "dotenv/config";
import prisma from "../../../../../lib/prisma";
import {
  apiFetch,
  assertExactlyOneWinner,
  check,
  finish,
  loginAs,
  ensureServerOrSkip,
} from "../../utilities/api-client";

async function run() {
  await ensureServerOrSkip();

  const pending = await prisma.consultation.findFirst({
    where: { status: "PENDING" },
    select: { id: true },
  });
  if (!pending) {
    console.log("⏭️  SKIP — no PENDING consultation in seed data");
    process.exit(0);
  }

  const admin = await loginAs(
    process.env.CHAOS_ADMIN_EMAIL ?? "olivia.brown@protonmail.com",
  );

  const results = await Promise.all([
    apiFetch(`/api/bookings/consultations/${pending.id}`, {
      method: "PATCH",
      session: admin,
      body: JSON.stringify({ status: "APPROVED" }),
    }),
    apiFetch(`/api/bookings/consultations/${pending.id}`, {
      method: "PATCH",
      session: admin,
      body: JSON.stringify({ status: "REJECTED" }),
    }),
  ]);

  assertExactlyOneWinner("approve-vs-decline: exactly one winner", results);

  const after = await prisma.consultation.findUnique({
    where: { id: pending.id },
    select: { status: true },
  });
  check(
    "final state is one of the two requested outcomes",
    ["APPROVED", "APPROVED_PENDING_PAYMENT", "REJECTED"].includes(
      after?.status ?? "",
    ),
    after,
  );

  // Restore the fixture for repeat runs.
  await prisma.consultation.update({
    where: { id: pending.id },
    data: { status: "PENDING", pendingPaymentUrl: null },
  });

  finish("approve-decline-race");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
