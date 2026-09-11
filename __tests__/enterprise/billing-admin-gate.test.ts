/**
 * @jest-environment node
 */

/**
 * Pin the disjunction semantics of `requireOrgBillingAdminOrOwner`.
 *
 * Why this matters
 * ----------------
 * BILLING_ADMIN sits at rank 70 — above MANAGER (60) but below
 * MAINTAINER (80). A naïve `requireOrgAccess(orgId, { minimumRole:
 * "BILLING_ADMIN" })` would let MAINTAINER through on the rank
 * comparison. The helper under test must REFUSE MAINTAINER because
 * MAINTAINER is the org-admin role and explicitly does not have
 * billing rights per `lib/labels/org-labels.ts`
 * `MEMBER_ROLE_DESCRIPTION`. See `lib/auth/billing-admin-gate.ts` for
 * the full rationale.
 *
 * Closes PR #655 Batch 2 (route gate audit).
 */

jest.mock("../../lib/auth-helpers", () => ({
  // The helper-under-test still relies on `requireOrgAccess` for the
  // initial "active member of the org" + capability gates. We mock it
  // to return a synthetic access object per role and let the
  // disjunction check run unmodified.
  requireOrgAccess: jest.fn(),
}));

import { requireOrgAccess } from "@/lib/auth-helpers";
import { requireOrgBillingAdminOrOwner } from "@/lib/auth/billing-admin-gate";

const mockedRequireOrgAccess = requireOrgAccess as jest.Mock;

function accessFor(role: string) {
  return {
    error: null,
    session: { user: { id: "u-1", email: "u@test.com" } },
    member: { id: "m-1", role },
    org: { id: "org-1", name: "Acme", status: "ACTIVE" },
  };
}

describe("requireOrgBillingAdminOrOwner — disjunction semantics", () => {
  beforeEach(() => {
    mockedRequireOrgAccess.mockReset();
  });

  it.each([
    ["OWNER", true],
    ["BILLING_ADMIN", true],
    // Critical anti-regression: MAINTAINER is rank 80 (above BILLING_ADMIN
    // at 70) yet must be denied because the disjunction is on EXACT role,
    // not rank. A rank-based gate would let this through.
    ["MAINTAINER", false],
    ["MANAGER", false],
    ["EXPERT", false],
    ["SUPPORT", false],
    ["LEARNER", false],
  ])("role=%s → allowed=%s", async (role, allowed) => {
    mockedRequireOrgAccess.mockResolvedValue(accessFor(role));
    const result = await requireOrgBillingAdminOrOwner("org-1");

    if (allowed) {
      // Type-narrow via the success branch: when `error` is null,
      // TS still sees the union (the upstream `requireOrgAccess`
      // return-type is `OrgAccessGrant | { error: NextResponse }`).
      // The runtime assertion below narrows for the compiler too.
      expect(result.error).toBeNull();
      if (!("member" in result)) {
        throw new Error("expected access grant on allowed role");
      }
      expect(result.member.role).toBe(role);
      return;
    }

    // On denial the helper returns { error: NextResponse } with a 403
    // and the typed code. We assert the response status + body shape so
    // a future "make this 401 instead" refactor is caught.
    expect(result.error).toBeDefined();
    expect(result.error?.status).toBe(403);
    const body = await result.error?.json();
    expect(body).toEqual({
      error: "Forbidden",
      code: "BILLING_ADMIN_OR_OWNER_REQUIRED",
    });
  });

  it("forwards capability gates (canSponsor, requireActive) to requireOrgAccess", async () => {
    // The helper is a thin wrapper — capability fields must flow through
    // unchanged so routes like `billing-account/wallet/top-ups` can keep
    // their existing `requireActive: true` guard.
    mockedRequireOrgAccess.mockResolvedValue(accessFor("OWNER"));
    await requireOrgBillingAdminOrOwner("org-1", {
      canSponsor: true,
      requireActive: true,
    });
    expect(mockedRequireOrgAccess).toHaveBeenCalledWith("org-1", {
      minimumRole: "LEARNER",
      canSponsor: true,
      requireActive: true,
    });
  });

  it("propagates the error response from requireOrgAccess unchanged", async () => {
    // When requireOrgAccess returns an error (org PENDING_VERIFICATION,
    // user not a member, capability mismatch), the helper must surface
    // that response verbatim instead of overwriting it with its own 403.
    const orgNotVerified = {
      error: { status: 409, json: async () => ({ error: "ORG_NOT_VERIFIED" }) },
    };
    mockedRequireOrgAccess.mockResolvedValue(orgNotVerified);
    const result = await requireOrgBillingAdminOrOwner("org-1", {
      requireActive: true,
    });
    expect(result.error).toBe(orgNotVerified.error);
  });
});
