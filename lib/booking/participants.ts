import type { Tx } from "@/lib/prisma";
import type {
  ParticipantRole,
  ParticipantStatus,
  Prisma,
} from "@prisma/client";

/**
 * #1319 A9 — shadow writers for AppointmentParticipant.
 *
 * Every place that connects a user to a slot also records the participant edge
 * here, in the SAME transaction. Nothing in production reads the table yet:
 * capacity counts and roster reads stay on the slot↔user join until the reader
 * flip (own epic). The pre-MVP reset starts from clean data, so writing from
 * day one means the table is never backfilled.
 *
 * All writes are idempotent by construction (createMany skipDuplicates on the
 * (appointmentId, userId) unique; updateMany for status), so a checkout retry
 * or a webhook redelivery cannot 409 on this table.
 */

export interface ParticipantEntry {
  userId: string;
  role: ParticipantRole;
  status?: ParticipantStatus;
  paymentId?: string | null;
}

type ParticipantTx = Pick<Tx, "appointmentParticipant">;

export async function recordParticipants(
  tx: ParticipantTx,
  appointmentId: string,
  entries: ParticipantEntry[],
  opts: { organizationId?: string | null; status?: ParticipantStatus } = {},
): Promise<void> {
  if (entries.length === 0) return;
  // Dedupe on userId: a consultant booking their own slot as consultee is
  // rejected upstream, but the join accepts one user once and so must we.
  const seen = new Set<string>();
  const data = entries
    .filter((e) => (seen.has(e.userId) ? false : (seen.add(e.userId), true)))
    .map((e) => ({
      appointmentId,
      userId: e.userId,
      role: e.role,
      status: e.status ?? opts.status ?? "HELD",
      paymentId: e.paymentId ?? null,
      organizationId: opts.organizationId ?? null,
    }));
  await tx.appointmentParticipant.createMany({ data, skipDuplicates: true });
}

export async function setParticipantStatus(
  tx: ParticipantTx,
  where: Prisma.AppointmentParticipantWhereInput,
  to: ParticipantStatus,
  data: Omit<
    Prisma.AppointmentParticipantUpdateManyMutationInput,
    "status"
  > = {},
): Promise<number> {
  const res = await tx.appointmentParticipant.updateMany({
    where,
    data: { status: to, ...data },
  });
  return res.count;
}

/** Stamp the Payment that funded every participant row of one appointment. */
export async function linkParticipantsToPayment(
  tx: ParticipantTx,
  appointmentId: string,
  paymentId: string,
  userId?: string,
): Promise<void> {
  await tx.appointmentParticipant.updateMany({
    where: { appointmentId, paymentId: null, ...(userId ? { userId } : {}) },
    data: { paymentId },
  });
}
