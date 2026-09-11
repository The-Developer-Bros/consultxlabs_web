/**
 * @jest-environment node
 */

/**
 * Who a platform-intake ticket gets billed and routed to.
 *
 * Two rules that are easy to get subtly wrong, extracted from the route so
 * they can be exercised without standing up a request:
 *
 *   1. An `orgId` the caller does not actually belong to is REFUSED, not
 *      quietly downgraded to a B2C ticket. A silent downgrade would hide the
 *      attempt entirely — the ticket would just look ordinary.
 *   2. Inferring the org from a sole membership is confined to the
 *      operator-billing flow. A B2C flow must never inherit an org just
 *      because the person filing it happens to belong to one, or a private
 *      complaint lands in their employer's queue.
 */

import { resolveOrgAttribution } from "@/lib/support/platform-flows";

const OPERATOR = "ORG_OPERATOR_BILLING";

describe("resolveOrgAttribution", () => {
  it("refuses an org the caller is not an active member of", () => {
    expect(
      resolveOrgAttribution({
        flowId: OPERATOR,
        requestedOrgId: "org-not-mine",
        activeOrganizationIds: ["org-a"],
      }),
    ).toEqual({ ok: false, reason: "FORGED_ORG" });
  });

  it("refuses a forged org even on a B2C flow, rather than ignoring it", () => {
    // The attempt matters regardless of which flow carried it.
    expect(
      resolveOrgAttribution({
        flowId: "PAYMENTS_BILLING",
        requestedOrgId: "org-not-mine",
        activeOrganizationIds: [],
      }),
    ).toEqual({ ok: false, reason: "FORGED_ORG" });
  });

  it("accepts a legitimate explicit org on the operator flow", () => {
    expect(
      resolveOrgAttribution({
        flowId: OPERATOR,
        requestedOrgId: "org-a",
        activeOrganizationIds: ["org-a", "org-b"],
      }),
    ).toEqual({ ok: true, organizationId: "org-a" });
  });

  it("infers a sole membership on the operator flow only", () => {
    expect(
      resolveOrgAttribution({
        flowId: OPERATOR,
        requestedOrgId: null,
        activeOrganizationIds: ["org-a"],
      }),
    ).toEqual({ ok: true, organizationId: "org-a" });
  });

  it("does NOT infer an org on a B2C flow, even with a sole membership", () => {
    // The regression this guards: an employee's personal payment complaint
    // silently acquiring their employer's attribution.
    expect(
      resolveOrgAttribution({
        flowId: "PAYMENTS_BILLING",
        requestedOrgId: null,
        activeOrganizationIds: ["org-a"],
      }),
    ).toEqual({ ok: true, organizationId: null });
  });

  it("does not guess when the caller belongs to several orgs", () => {
    expect(
      resolveOrgAttribution({
        flowId: OPERATOR,
        requestedOrgId: null,
        activeOrganizationIds: ["org-a", "org-b"],
      }),
    ).toEqual({ ok: true, organizationId: null });
  });

  it("returns no org for a caller with no memberships", () => {
    expect(
      resolveOrgAttribution({
        flowId: OPERATOR,
        requestedOrgId: null,
        activeOrganizationIds: [],
      }),
    ).toEqual({ ok: true, organizationId: null });
  });
});
