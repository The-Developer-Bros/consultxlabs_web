/**
 * @jest-environment node
 */

/**
 * B2B gap 8 — a payer admin can see what their org paid for and nobody booked.
 *
 * The org Requests page gates on holding a consultant profile, because
 * allocation is a delivery act. That was right about the CONTROLS and wrong
 * about the page: an OWNER who does not deliver was redirected away, so an
 * org-funded booking with no times against it appeared on exactly one surface
 * in the product — the delivering expert's — and the people paying for it had
 * no way to notice it was stuck.
 *
 * Three cases pinned here: the expert still gets the allocation surface, the
 * payer admin gets the same queue read-only, and everyone else is still sent
 * home rather than shown a page with nothing on it for them.
 */

import { isPayerAdminRole } from "../../lib/booking/org-actor";

const mockRequireOrgAccess = jest.fn();
const mockReadOrgPendingRequests = jest.fn();
const mockRedirect = jest.fn((path: string) => {
  // Next's redirect() throws; a mock that returns would let the caller keep
  // running past a gate it was supposed to be stopped by.
  throw new Error(`NEXT_REDIRECT:${path}`);
});

jest.mock("next/navigation", () => ({
  __esModule: true,
  redirect: (path: string) => mockRedirect(path),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

// org-actor pulls in the Prisma client for its sibling lookup; this test only
// needs the pure role predicate beside it.
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { membership: { findUnique: jest.fn() } },
}));

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireOrgAccess: (...a: unknown[]) => mockRequireOrgAccess(...a),
}));

jest.mock("../../lib/data/org-pending-requests", () => ({
  __esModule: true,
  readOrgPendingRequests: (...a: unknown[]) => mockReadOrgPendingRequests(...a),
}));

jest.mock(
  "../../app/dashboard/organization/[orgId]/requests/RequestsClient",
  () => ({
    __esModule: true,
    RequestsClient: () => null,
  }),
);

jest.mock(
  "../../app/dashboard/organization/[orgId]/requests/PayerRequestsView",
  () => ({
    __esModule: true,
    PayerRequestsView: () => null,
  }),
);

import OrgRequestsPage from "../../app/dashboard/organization/[orgId]/requests/page";
import { RequestsClient } from "../../app/dashboard/organization/[orgId]/requests/RequestsClient";
import { PayerRequestsView } from "../../app/dashboard/organization/[orgId]/requests/PayerRequestsView";

const ORG = "org-acme";

function grant(member: Record<string, unknown>) {
  return { session: { user: { id: "user-1" } }, member, org: { id: ORG } };
}

/** Which of the two surfaces did the page actually mount? */
function mountedComponents(element: unknown): unknown[] {
  const found: unknown[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    const el = node as { type?: unknown; props?: { children?: unknown } };
    if (el.type) found.push(el.type);
    if (el.props?.children) walk(el.props.children);
  };
  walk(element);
  return found;
}

async function renderPage() {
  return OrgRequestsPage({ params: Promise.resolve({ orgId: ORG }) });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockReadOrgPendingRequests.mockResolvedValue([]);
});

describe("who may open the org Requests page", () => {
  it("an EXPERT member still gets the allocation surface", async () => {
    mockRequireOrgAccess.mockResolvedValue(
      grant({ role: "EXPERT", consultantProfileId: "consultant-1" }),
    );

    const mounted = mountedComponents(await renderPage());

    expect(mounted).toContain(RequestsClient);
    expect(mounted).not.toContain(PayerRequestsView);
    expect(mockRedirect).not.toHaveBeenCalled();
    // The payer read is not run for someone who has the live one.
    expect(mockReadOrgPendingRequests).not.toHaveBeenCalled();
  });

  it("an OWNER who does not deliver gets the queue read-only", async () => {
    mockRequireOrgAccess.mockResolvedValue(
      grant({ role: "OWNER", consultantProfileId: null }),
    );

    const mounted = mountedComponents(await renderPage());

    expect(mounted).toContain(PayerRequestsView);
    // No allocation controls: choosing times is still the expert's act.
    expect(mounted).not.toContain(RequestsClient);
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockReadOrgPendingRequests).toHaveBeenCalledWith(ORG);
  });

  it("a MAINTAINER gets the same view — both payer-side roles qualify", async () => {
    mockRequireOrgAccess.mockResolvedValue(
      grant({ role: "MAINTAINER", consultantProfileId: null }),
    );

    const mounted = mountedComponents(await renderPage());

    expect(mounted).toContain(PayerRequestsView);
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("a LEARNER with no consultant profile is still sent home", async () => {
    mockRequireOrgAccess.mockResolvedValue(
      grant({ role: "LEARNER", consultantProfileId: null }),
    );

    await expect(renderPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(mockRedirect).toHaveBeenCalledWith(
      `/dashboard/organization/${ORG}/home`,
    );
    expect(mockReadOrgPendingRequests).not.toHaveBeenCalled();
  });

  it("a MANAGER is sent home too — operations.read is not the payer role", async () => {
    mockRequireOrgAccess.mockResolvedValue(
      grant({ role: "MANAGER", consultantProfileId: null }),
    );

    await expect(renderPage()).rejects.toThrow("NEXT_REDIRECT");
  });
});

describe("isPayerAdminRole", () => {
  it("admits exactly the two roles that answer for the org's money", () => {
    expect(isPayerAdminRole("OWNER")).toBe(true);
    expect(isPayerAdminRole("MAINTAINER")).toBe(true);
    for (const role of [
      "BILLING_ADMIN",
      "MANAGER",
      "EXPERT",
      "LEARNER",
      "SUPPORT",
    ] as const) {
      expect(isPayerAdminRole(role)).toBe(false);
    }
    expect(isPayerAdminRole(null)).toBe(false);
    expect(isPayerAdminRole(undefined)).toBe(false);
  });
});
