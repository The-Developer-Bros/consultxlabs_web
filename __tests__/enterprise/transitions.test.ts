/**
 * @jest-environment node
 */

/**
 * The central transition helper bakes each enum's allowed-from set into the
 * UPDATE WHERE clause, so an illegal transition matches zero rows and throws
 * instead of corrupting state. These tests assert the maps (every legal edge,
 * representative terminal re-entries) and the helper contract (throw on count
 * 0, audit only after a successful CAS) against a mocked delegate — no DB.
 */

import {
  ASSIGNMENT_ALLOWED_FROM,
  CONTRACT_ALLOWED_FROM,
  INVOICE_ALLOWED_FROM,
  IllegalTransitionError,
  MEMBER_ALLOWED_FROM,
  ORG_ALLOWED_FROM,
  ORG_PAYOUT_ACCOUNT_ALLOWED_FROM,
  PAYOUT_ALLOWED_FROM,
  PO_ALLOWED_FROM,
  PROGRAM_ALLOWED_FROM,
  TERMINAL_STATES,
  WALLET_TOPUP_ALLOWED_FROM,
  transitionContract,
  transitionMembership,
  transitionOrgInvoice,
  transitionOrgPayout,
  transitionOrgPayoutAccount,
  transitionOrganization,
  transitionProgram,
  transitionProgramAssignment,
  transitionPurchaseOrder,
} from "@/lib/enterprise/transitions";

function mockTx(count: number) {
  const updateMany = jest.fn().mockResolvedValue({ count });
  const create = jest.fn().mockResolvedValue({});
  return {
    updateMany,
    create,
    tx: {
      organization: { updateMany },
      contract: { updateMany },
      program: { updateMany },
      programAssignment: { updateMany },
      membership: { updateMany },
      organizationInvoice: { updateMany },
      purchaseOrder: { updateMany },
      organizationPayoutAccount: { updateMany },
      organizationPayout: { updateMany },
      orgAuditLog: { create },
      // Wrappers only touch their Pick'd delegates; the cast keeps the mock flat.
    } as never,
  };
}

// [wrapper, map] table so every legal edge of every enum is exercised.
const WRAPPERS = [
  ["Organization", transitionOrganization, ORG_ALLOWED_FROM],
  ["Contract", transitionContract, CONTRACT_ALLOWED_FROM],
  ["Program", transitionProgram, PROGRAM_ALLOWED_FROM],
  ["ProgramAssignment", transitionProgramAssignment, ASSIGNMENT_ALLOWED_FROM],
  ["Membership", transitionMembership, MEMBER_ALLOWED_FROM],
  ["OrganizationInvoice", transitionOrgInvoice, INVOICE_ALLOWED_FROM],
  ["PurchaseOrder", transitionPurchaseOrder, PO_ALLOWED_FROM],
  ["OrganizationPayoutAccount", transitionOrgPayoutAccount, ORG_PAYOUT_ACCOUNT_ALLOWED_FROM],
  ["OrganizationPayout", transitionOrgPayout, PAYOUT_ALLOWED_FROM],
] as const;

describe("transition wrappers — CAS contract", () => {
  describe.each(WRAPPERS)("%s", (entity, wrapper, map) => {
    const reachableTargets = Object.entries(map)
      .filter(([, froms]) => (froms as string[]).length > 0)
      .map(([to]) => to);

    it.each(reachableTargets)(
      "to %s compiles the allowed-from set into the WHERE and resolves on count 1",
      async (to) => {
        const m = mockTx(1);
        await expect(
          (wrapper as never as (tx: never, args: object) => Promise<void>)(m.tx, {
            where: { id: "row-1" },
            to,
          }),
        ).resolves.toBeUndefined();
        expect(m.updateMany).toHaveBeenCalledWith({
          where: {
            id: "row-1",
            status: { in: map[to as keyof typeof map] },
          },
          data: { status: to },
        });
      },
    );

    it(`throws IllegalTransitionError (httpStatus 409) on count 0`, async () => {
      const m = mockTx(0);
      const to = reachableTargets[0];
      const err = await (
        wrapper as never as (tx: never, args: object) => Promise<void>
      )(m.tx, { where: { id: "row-1" }, to }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IllegalTransitionError);
      expect((err as IllegalTransitionError).httpStatus).toBe(409);
      expect((err as IllegalTransitionError).entity).toBe(entity);
    });

    it("does not write the audit row when the CAS matched zero rows", async () => {
      const m = mockTx(0);
      await (wrapper as never as (tx: never, args: object) => Promise<void>)(
        m.tx,
        {
          where: { id: "row-1" },
          to: reachableTargets[0],
          audit: {
            organizationId: "org-1",
            actorMembershipId: null,
            category: "SYSTEM",
            action: "X",
            description: "x",
          },
        },
      ).catch(() => undefined);
      expect(m.create).not.toHaveBeenCalled();
    });

    it("writes the audit row in-tx after a successful CAS", async () => {
      const m = mockTx(1);
      await (wrapper as never as (tx: never, args: object) => Promise<void>)(
        m.tx,
        {
          where: { id: "row-1" },
          to: reachableTargets[0],
          audit: {
            organizationId: "org-1",
            actorMembershipId: "mem-1",
            category: "SYSTEM",
            action: "X",
            description: "x",
          },
        },
      );
      expect(m.create).toHaveBeenCalledTimes(1);
    });
  });
});

describe("terminal re-entry is structurally impossible", () => {
  it("a terminal state never appears in any allowed-from set of its enum", () => {
    const pairs = [
      [ORG_ALLOWED_FROM, TERMINAL_STATES.OrgStatus],
      [CONTRACT_ALLOWED_FROM, TERMINAL_STATES.ContractStatus],
      [PROGRAM_ALLOWED_FROM, TERMINAL_STATES.ProgramStatus],
      [ASSIGNMENT_ALLOWED_FROM, TERMINAL_STATES.AssignmentStatus],
      [MEMBER_ALLOWED_FROM, TERMINAL_STATES.MemberStatus],
      [INVOICE_ALLOWED_FROM, TERMINAL_STATES.OrgInvoiceStatus],
      [PO_ALLOWED_FROM, TERMINAL_STATES.PoStatus],
      [PAYOUT_ALLOWED_FROM, TERMINAL_STATES.PayoutStatus],
      [WALLET_TOPUP_ALLOWED_FROM, TERMINAL_STATES.WalletTopUpStatus],
    ] as const;
    for (const [map, terminals] of pairs) {
      const froms = new Set(Object.values(map).flat());
      for (const t of Array.from(terminals)) expect(froms.has(t)).toBe(false);
    }
  });

  it("expected terminal sets (audit S3 — resurrectable states are the bug class)", () => {
    expect(Array.from(TERMINAL_STATES.OrgStatus).sort()).toEqual(["DEACTIVATED"]);
    expect(Array.from(TERMINAL_STATES.ContractStatus).sort()).toEqual([
      "EXPIRED",
      "TERMINATED",
    ]);
    expect(Array.from(TERMINAL_STATES.ProgramStatus).sort()).toEqual([
      "CANCELLED",
      "EXPIRED",
    ]);
    expect(Array.from(TERMINAL_STATES.AssignmentStatus).sort()).toEqual([
      "CANCELLED",
      "CLOSED",
      "ROLLED",
    ]);
    expect(Array.from(TERMINAL_STATES.MemberStatus).sort()).toEqual(["ERASED"]);
    expect(Array.from(TERMINAL_STATES.OrgInvoiceStatus).sort()).toEqual([
      "CANCELLED",
      "REFUNDED",
      "VOID",
    ]);
    expect(Array.from(TERMINAL_STATES.PoStatus).sort()).toEqual([
      "CANCELLED",
      "CLOSED",
    ]);
    // Bank-detail changes can re-verify from any payout-account state.
    expect(Array.from(TERMINAL_STATES.OrgPayoutAccountStatus)).toEqual([]);
    expect(Array.from(TERMINAL_STATES.PayoutStatus).sort()).toEqual([
      "CANCELLED",
      "FAILED",
      "REVERSED",
    ]);
    expect(Array.from(TERMINAL_STATES.WalletTopUpStatus).sort()).toEqual([
      "CONFIRMED",
      "FAILED",
    ]);
  });

  it.each([
    ["TERMINATED contract → ACTIVE", CONTRACT_ALLOWED_FROM.ACTIVE, "TERMINATED"],
    ["CANCELLED program → ACTIVE", PROGRAM_ALLOWED_FROM.ACTIVE, "CANCELLED"],
    ["CLOSED PO → ACTIVE", PO_ALLOWED_FROM.ACTIVE, "CLOSED"],
    ["DEACTIVATED org → ACTIVE", ORG_ALLOWED_FROM.ACTIVE, "DEACTIVATED"],
    ["REFUNDED invoice → PAID", INVOICE_ALLOWED_FROM.PAID, "REFUNDED"],
    ["REVERSED payout → COMPLETED", PAYOUT_ALLOWED_FROM.COMPLETED, "REVERSED"],
  ])("%s is not a legal edge", (_label, froms, from) => {
    expect(froms).not.toContain(from);
  });
});
