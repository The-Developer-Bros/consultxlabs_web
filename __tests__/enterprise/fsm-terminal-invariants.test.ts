/**
 * @jest-environment node
 */

/**
 * #1230 / #1132 follow-up — wave-1 regression pins.
 *
 * Three of the landed fixes were instances of ONE failure class: a state
 * machine declared terminal states but a write path bypassed the guard and
 * resurrected a dead row (assignment period PATCH re-arming ROLLED/CLOSED
 * spend, member direct-add resurrecting past REMOVED toward ERASED,
 * supersede double-minting successors). These tests pin the class, not the
 * incidents: for EVERY guarded enterprise FSM, a state declared terminal by
 * TERMINAL_STATES must never appear as an allowed source for another
 * transition target. A future edit that reintroduces a resurrection edge
 * fails here first, before it can strand money or breach a DPDP tombstone.
 */

import {
  ASSIGNMENT_ALLOWED_FROM,
  CONTRACT_ALLOWED_FROM,
  INVOICE_ALLOWED_FROM,
  MEMBER_ALLOWED_FROM,
  ORG_ALLOWED_FROM,
  PO_ALLOWED_FROM,
  PROGRAM_ALLOWED_FROM,
  PAYOUT_ALLOWED_FROM,
  TERMINAL_STATES,
  WALLET_TOPUP_ALLOWED_FROM,
} from "@/lib/enterprise/transitions";

/**
 * Keyed by the ENUM name TERMINAL_STATES uses. ORG_PAYOUT_ACCOUNT is
 * deliberately excluded: its schema docstring declares full cycles by
 * design (bank-detail re-verification), so the invariant does not apply.
 */
const MAPS: Record<string, Record<string, readonly string[]>> = {
  OrgStatus: ORG_ALLOWED_FROM,
  ContractStatus: CONTRACT_ALLOWED_FROM,
  ProgramStatus: PROGRAM_ALLOWED_FROM,
  AssignmentStatus: ASSIGNMENT_ALLOWED_FROM,
  MemberStatus: MEMBER_ALLOWED_FROM,
  OrgInvoiceStatus: INVOICE_ALLOWED_FROM,
  PoStatus: PO_ALLOWED_FROM,
  PayoutStatus: PAYOUT_ALLOWED_FROM,
  WalletTopUpStatus: WALLET_TOPUP_ALLOWED_FROM,
};

describe("enterprise FSM terminality invariants", () => {
  /**
   * The load-bearing pin (CR #1234 review): `terminalsOf` DERIVES terminals
   * as the complement of every source list, so asserting "no terminal is a
   * source" against the derived set is a tautology — a resurrection edge
   * would simply shrink the derived set and pass silently. Comparing the
   * derived set against these literals is what catches it.
   */
  const EXPECTED_TERMINALS: Record<string, readonly string[]> = {
    OrgStatus: ["DEACTIVATED"],
    ContractStatus: ["EXPIRED", "TERMINATED"],
    ProgramStatus: ["EXPIRED", "CANCELLED"],
    AssignmentStatus: ["ROLLED", "CLOSED", "CANCELLED"],
    MemberStatus: ["ERASED"],
    OrgInvoiceStatus: ["VOID", "CANCELLED", "REFUNDED"],
    PoStatus: ["CLOSED", "CANCELLED"],
    PayoutStatus: ["FAILED", "CANCELLED", "REVERSED"],
    WalletTopUpStatus: ["CONFIRMED", "FAILED"],
  };

  it("derived terminal sets match the pinned literals exactly", () => {
    for (const [entity, expected] of Object.entries(EXPECTED_TERMINALS)) {
      const derived = [
        ...(TERMINAL_STATES[
          entity as keyof typeof TERMINAL_STATES
        ] as ReadonlySet<string>),
      ].sort();
      expect({
        entity,
        derived,
        hint:
          "a transition edge was added/removed from a terminal state — this is the resurrection-edge detector",
      }).toEqual({ entity, derived: [...expected].sort(), hint: expect.any(String) });
    }
  });

  it("every guarded map has a TERMINAL_STATES entry", () => {
    for (const entity of Object.keys(MAPS)) {
      expect(TERMINAL_STATES).toHaveProperty(entity);
    }
  });

  it.each(Object.entries(MAPS))(
    "%s: no terminal state is an allowed source for another target",
    (entity, allowedFrom) => {
      const terminals = TERMINAL_STATES[
        entity as keyof typeof TERMINAL_STATES
      ] as ReadonlySet<string>;

      for (const [target, sources] of Object.entries(allowedFrom)) {
        for (const source of sources) {
          if (source === target) continue;
          if (terminals.has(source)) {
            throw new Error(
              `${entity}: terminal state ${source} is listed as a source for →${target}; a write path using this map could resurrect dead rows`,
            );
          }
        }
      }
      // Reached only when every edge respects terminality.
      expect(allowedFrom).toBeDefined();
    },
  );

  describe("Membership (#1132 follow-up)", () => {
    it("REMOVED → ACTIVE is a deliberate, documented edge (direct-add reactivation)", () => {
      expect(MEMBER_ALLOWED_FROM.ACTIVE).toContain("REMOVED");
    });

    it("ERASED tombstones are never a source for any live transition", () => {
      // The only way into erasure is the dedicated scrub pipeline targeting
      // ERASED directly; nothing may pass THROUGH erasure back to life.
      const erasedAsSource = Object.entries(MEMBER_ALLOWED_FROM)
        .filter(([target]) => target !== "ERASED")
        .flatMap(([, sources]) => sources)
        .filter((s) => s === "ERASED");
      expect(erasedAsSource).toEqual([]);
    });
  });
});
