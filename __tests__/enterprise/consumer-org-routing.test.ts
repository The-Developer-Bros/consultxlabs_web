/**
 * @jest-environment node
 */

/**
 * Entry-point router for /dashboard/organization/[orgId]/page.tsx —
 * verifies role-aware in-org redirects:
 *
 *   MANAGER+      → /home
 *   LEARNER       → /my-program
 *   EXPERT        → /compensation
 *   no membership → personal dashboard fallback
 *
 * `next/navigation`'s `redirect()` throws — we catch the thrown
 * error and inspect the digest to assert the target path. This
 * mirrors how Next itself surfaces the redirect to the framework.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    membership: { findUnique: jest.fn() },
  },
}));

jest.mock("../../lib/auth-server", () => ({
  getSession: jest.fn(),
}));

jest.mock("../../lib/labels/personal-dashboard", () => ({
  resolvePersonalDashboardHref: jest.fn(() => "/dashboard/consultee/c-1/home"),
}));

import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { resolvePersonalDashboardHref } from "@/lib/labels/personal-dashboard";
import OrgRoot from "@/app/dashboard/organization/[orgId]/page";

const mockedPrisma = prisma as unknown as {
  membership: { findUnique: jest.Mock };
};
const mockedGetSession = getSession as jest.Mock;
const mockedResolveHref = resolvePersonalDashboardHref as jest.Mock;

function makeParams(orgId = "org-1") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { params: Promise.resolve({ orgId }) } as any;
}

/**
 * Trigger the page handler and capture the path Next's `redirect()`
 * threw. Returns the path on success, throws if no redirect happened.
 */
async function expectRedirect(
  call: () => Promise<unknown>,
): Promise<string> {
  try {
    await call();
  } catch (err: unknown) {
    // Next.js redirect throws a special error with `digest` set to
    // `NEXT_REDIRECT;<type>;<path>;<status>;<extra>`. We don't import
    // its internals — sniff the digest to extract segment[2] (path).
    const digest =
      (err as { digest?: string } | null)?.digest ?? String(err);
    const match = /^NEXT_REDIRECT;[^;]+;([^;]+)/.exec(digest);
    if (match) return match[1];
    throw err;
  }
  throw new Error("Expected the handler to redirect, but it did not.");
}

describe("/dashboard/organization/[orgId] entry-point routing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveHref.mockReturnValue("/dashboard/consultee/c-1/home");
  });

  it("redirects unauthenticated users to /auth/signin", async () => {
    mockedGetSession.mockResolvedValueOnce(null);
    const path = await expectRedirect(() => OrgRoot(makeParams()));
    expect(path).toBe("/auth/signin");
  });

  it("redirects ADMIN straight to /home (no membership lookup)", async () => {
    mockedGetSession.mockResolvedValueOnce({
      user: { id: "u-admin", role: "ADMIN" },
    });

    const path = await expectRedirect(() => OrgRoot(makeParams("org-1")));
    expect(path).toBe("/dashboard/organization/org-1/home");
    expect(mockedPrisma.membership.findUnique).not.toHaveBeenCalled();
  });

  it("redirects LEARNER to /my-program", async () => {
    mockedGetSession.mockResolvedValueOnce({
      user: { id: "u-learner", role: "USER" },
    });
    mockedPrisma.membership.findUnique.mockResolvedValueOnce({
      role: "LEARNER",
      status: "ACTIVE",
    });

    const path = await expectRedirect(() => OrgRoot(makeParams("org-1")));
    expect(path).toBe("/dashboard/organization/org-1/my-program");
  });

  it("redirects EXPERT to /compensation", async () => {
    mockedGetSession.mockResolvedValueOnce({
      user: { id: "u-expert", role: "USER" },
    });
    mockedPrisma.membership.findUnique.mockResolvedValueOnce({
      role: "EXPERT",
      status: "ACTIVE",
    });

    const path = await expectRedirect(() => OrgRoot(makeParams("org-1")));
    expect(path).toBe("/dashboard/organization/org-1/compensation");
  });

  it.each(["OWNER", "MAINTAINER", "MANAGER", "SUPPORT"] as const)(
    "redirects %s to /home (operator track)",
    async (role) => {
      mockedGetSession.mockResolvedValueOnce({
        user: { id: "u-op", role: "USER" },
      });
      mockedPrisma.membership.findUnique.mockResolvedValueOnce({
        role,
        status: "ACTIVE",
      });

      const path = await expectRedirect(() => OrgRoot(makeParams("org-1")));
      expect(path).toBe("/dashboard/organization/org-1/home");
    },
  );

  it("redirects user with no membership to personal dashboard fallback", async () => {
    mockedGetSession.mockResolvedValueOnce({
      user: { id: "u-stranger", role: "USER" },
    });
    mockedPrisma.membership.findUnique.mockResolvedValueOnce(null);

    const path = await expectRedirect(() => OrgRoot(makeParams("org-1")));
    expect(path).toBe("/dashboard/consultee/c-1/home");
    expect(mockedResolveHref).toHaveBeenCalled();
  });

  it("falls back to /dashboard when resolvePersonalDashboardHref returns null (lazy profile)", async () => {
    mockedGetSession.mockResolvedValueOnce({
      user: { id: "u-stranger", role: "USER" },
    });
    mockedPrisma.membership.findUnique.mockResolvedValueOnce(null);
    mockedResolveHref.mockReturnValueOnce(null);

    const path = await expectRedirect(() => OrgRoot(makeParams("org-1")));
    expect(path).toBe("/dashboard");
  });

  it("treats non-ACTIVE memberships as missing and redirects to /home (defensive)", async () => {
    mockedGetSession.mockResolvedValueOnce({
      user: { id: "u-removed", role: "USER" },
    });
    // A SUSPENDED or REMOVED membership shouldn't grant any role-based
    // routing. The current handler falls through to /home where the
    // page-level requireOrgAccess will reject with an error.
    mockedPrisma.membership.findUnique.mockResolvedValueOnce({
      role: "LEARNER",
      status: "REMOVED",
    });

    const path = await expectRedirect(() => OrgRoot(makeParams("org-1")));
    expect(path).toBe("/dashboard/organization/org-1/home");
  });
});
