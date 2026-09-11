/**
 * @jest-environment node
 */

/**
 * A replayed checkout must not meter the same booking twice.
 *
 * `recordBookingUtilization` grew a set-diff idempotency guard in PR-1e (G3),
 * but it only arms itself when the caller NAMES the appointments it is
 * counting. Checkout — the CONSULTATION / WEBINAR / CLASS debit — never passed
 * `appointmentIds`, so the guard was inert for every one of them and the
 * "legacy caller" branch incremented unconditionally: a retried webhook or a
 * resumed order against the same Payment charged the org's cap twice.
 */

import fs from "fs";
import path from "path";

import { recordBookingUtilization } from "@/lib/api/organizations/program-helpers";
import type { Tx } from "@/lib/prisma";

/**
 * An in-memory stand-in for the three tables the helper touches, so the
 * assertion is on real behaviour rather than on which mock was called.
 * Uncapped LICENSED_SEAT — the cap arithmetic is not what is under test.
 */
function makeFakeTx() {
  const state = {
    engagementsUsed: 0,
    util: null as null | {
      appointmentIds: string[];
      engagementsConsumed: number;
    },
    ledger: [] as { engagementsConsumed: number }[],
  };

  const tx = {
    programAssignment: {
      findUniqueOrThrow: async () => ({
        programId: "program-1",
        membershipId: "membership-1",
        engagementsUsed: state.engagementsUsed,
        consumedPaise: 0,
        program: {
          type: "LICENSED_SEAT",
          licensedSeatConfig: null,
          creditPoolConfig: null,
        },
      }),
      update: async ({
        data,
      }: {
        data: { engagementsUsed?: { increment: number } };
      }) => {
        state.engagementsUsed += data.engagementsUsed?.increment ?? 0;
        return { engagementsUsed: state.engagementsUsed };
      },
      updateMany: async () => ({ count: 1 }),
    },
    bookingUtilization: {
      findUnique: async () => state.util,
      upsert: async ({
        create,
        update,
      }: {
        create: { engagementsConsumed: number; appointmentIds: string[] };
        update: {
          engagementsConsumed: { increment: number };
          appointmentIds?: { push: string[] };
        };
      }) => {
        if (!state.util) {
          state.util = {
            engagementsConsumed: create.engagementsConsumed,
            appointmentIds: [...create.appointmentIds],
          };
        } else {
          state.util.engagementsConsumed +=
            update.engagementsConsumed.increment;
          state.util.appointmentIds.push(
            ...(update.appointmentIds?.push ?? []),
          );
        }
        return state.util;
      },
    },
    usageLedgerEntry: {
      create: async ({ data }: { data: { engagementsConsumed: number } }) => {
        state.ledger.push({ engagementsConsumed: data.engagementsConsumed });
        return data;
      },
    },
  };

  return { state, tx: tx as unknown as Tx };
}

const CALL = {
  programAssignmentId: "assign-1",
  paymentId: "pay-1",
  engagementsConsumed: 1,
  priceAtBookingPaise: 250_000,
};

describe("PR-1e (G3) — the set-diff guard needs the caller to name the appointments", () => {
  it("counts a replayed call once when appointmentIds are supplied", async () => {
    const { state, tx } = makeFakeTx();

    await recordBookingUtilization(tx, {
      ...CALL,
      appointmentIds: ["apt-1"],
    });
    const replay = await recordBookingUtilization(tx, {
      ...CALL,
      appointmentIds: ["apt-1"],
    });

    expect(replay.engagementsConsumedDelta).toBe(0);
    expect(state.engagementsUsed).toBe(1);
    expect(state.util?.engagementsConsumed).toBe(1);
    // No second ledger row: the replay short-circuits before the write.
    expect(state.ledger).toHaveLength(1);
  });

  it("still counts genuinely new appointments on a later call", async () => {
    const { state, tx } = makeFakeTx();

    await recordBookingUtilization(tx, { ...CALL, appointmentIds: ["apt-1"] });
    await recordBookingUtilization(tx, {
      ...CALL,
      engagementsConsumed: 2,
      appointmentIds: ["apt-1", "apt-2"],
    });

    expect(state.engagementsUsed).toBe(2);
    expect(state.util?.appointmentIds).toEqual(["apt-1", "apt-2"]);
  });

  it("double-counts the replay when the ids are omitted — the shape checkout had", async () => {
    const { state, tx } = makeFakeTx();

    await recordBookingUtilization(tx, CALL);
    await recordBookingUtilization(tx, CALL);

    expect(state.engagementsUsed).toBe(2);
    expect(state.ledger).toHaveLength(2);
  });
});

describe("checkout names the appointments it meters", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "lib/payments/operations/checkout.ts"),
    "utf8",
  );

  it("passes appointmentIds on the checkout debit", () => {
    const call = source.slice(
      source.indexOf(
        "utilizationResult = await recordBookingUtilization(tx, {",
      ),
    );
    const body = call.slice(0, call.indexOf("});"));
    expect(body).toContain("appointmentIds:");
    // CLASS meters one engagement per class session, so the id set has to be
    // the whole class, not just the appointment the Payment links to.
    expect(body).toContain('validatedData.appointmentType === "CLASS"');
    expect(body).toContain("classId: validatedData.eventId");
    expect(body).toContain("[createdAppointment.id]");
  });
});
