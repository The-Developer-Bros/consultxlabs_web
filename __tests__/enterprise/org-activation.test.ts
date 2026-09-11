/**
 * @jest-environment node
 */

/**
 * #777 §A + #779 §F — the pure activation checklist + action-center derivation.
 * Pins the capability-aware step list and the condition banners so the home
 * surface stays driven by real state, not hardcoded copy.
 */

import {
  deriveActivationChecklist,
  deriveActionCenter,
  isOrgActivated,
  type OrgActivationSnapshot,
} from "@/lib/enterprise/org-activation";

const ORG = "org_1";

const fresh: OrgActivationSnapshot = {
  status: "PENDING_VERIFICATION",
  canSponsor: true,
  canHost: false,
  fundingSource: "INVOICE",
  memberCount: 1,
  activeProgramCount: 0,
  activeAssignmentCount: 0,
  billingConfigured: false,
  hasContract: false,
  hasActiveContract: false,
  kybVerified: false,
  pastDueInvoiceCount: 0,
  outstandingInvoicePaise: 0,
  contractExpiringSoonCount: 0,
  pendingOverageCount: 0,
  pendingOveragePaise: 0,
  stuckPayoutCount: 0,
  walletLowBalancePaise: null,
  creditPoolMaxUtilizationPct: null,
};

describe("deriveActivationChecklist", () => {
  it("INVOICE sponsor org gets verify→kyb→billing→contract→program→invite→assign", () => {
    const steps = deriveActivationChecklist(fresh, ORG).map((s) => s.key);
    expect(steps).toEqual([
      "verify",
      "kyb",
      "billing",
      "contract",
      "program",
      "invite",
      "assign",
    ]);
    expect(deriveActivationChecklist(fresh, ORG).every((s) => !s.done)).toBe(
      true,
    );
  });

  it("HOST-only org collapses to verify→invite (no sponsor steps)", () => {
    const host: OrgActivationSnapshot = {
      ...fresh,
      canSponsor: false,
      canHost: true,
      fundingSource: null,
    };
    expect(deriveActivationChecklist(host, ORG).map((s) => s.key)).toEqual([
      "verify",
      "invite",
    ]);
  });

  it("non-INVOICE sponsor org omits the KYB step", () => {
    const wallet: OrgActivationSnapshot = { ...fresh, fundingSource: "WALLET" };
    expect(
      deriveActivationChecklist(wallet, ORG).map((s) => s.key),
    ).not.toContain("kyb");
  });

  it("isOrgActivated true only when every applicable step is done", () => {
    const done: OrgActivationSnapshot = {
      ...fresh,
      status: "ACTIVE",
      kybVerified: true,
      billingConfigured: true,
      hasContract: true,
      activeProgramCount: 1,
      memberCount: 5,
      activeAssignmentCount: 3,
    };
    expect(isOrgActivated(done, ORG)).toBe(true);
    expect(isOrgActivated(fresh, ORG)).toBe(false);
  });
});

describe("deriveActionCenter", () => {
  it("a healthy active org has no action items", () => {
    const healthy: OrgActivationSnapshot = { ...fresh, status: "ACTIVE" };
    expect(deriveActionCenter(healthy, ORG)).toHaveLength(0);
  });

  it("surfaces pending verification + only banners whose data exists", () => {
    const keys = deriveActionCenter(
      {
        ...fresh,
        status: "PENDING_VERIFICATION",
        pastDueInvoiceCount: 2,
        creditPoolMaxUtilizationPct: 91,
        contractExpiringSoonCount: 1,
        pendingOverageCount: 3,
        stuckPayoutCount: 4,
        walletLowBalancePaise: 50_00,
      },
      ORG,
    ).map((a) => a.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "pending-verification",
        "past-due-invoices",
        "credit-pool-near-cap",
        "contract-expiring",
        "pending-overages",
        "stuck-payouts",
        "wallet-low",
      ]),
    );
  });

  it("credit-pool banner only fires at ≥80%", () => {
    const under = deriveActionCenter(
      { ...fresh, status: "ACTIVE", creditPoolMaxUtilizationPct: 79 },
      ORG,
    );
    expect(under.find((a) => a.key === "credit-pool-near-cap")).toBeUndefined();
  });

  it("past-due invoices is critical severity", () => {
    const item = deriveActionCenter(
      { ...fresh, status: "ACTIVE", pastDueInvoiceCount: 1 },
      ORG,
    ).find((a) => a.key === "past-due-invoices");
    expect(item?.severity).toBe("critical");
  });
});
