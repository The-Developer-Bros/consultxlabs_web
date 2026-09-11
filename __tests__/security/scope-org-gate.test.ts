/**
 * `?orgScope=<orgId>` used to be authorized on active membership alone.
 *
 * The `org` scope applies NO user filter — `buildWhere` returns every row in
 * the org — so any active member could pass their own org id to
 * `/api/appointments`, `/api/documents` or `/api/recordings` and read the
 * whole org's feed. The org-scoped sibling routes
 * (`/api/organizations/[orgId]/...`) require `operations.read` for exactly
 * those rows; this was the same data behind an unlocked door.
 *
 * The gate now requires `operations.read`, and a member below that bar is
 * downgraded to `orgMember` (their own rows in that org) rather than refused
 * — that is what a learner passing their own org id actually means.
 */

import { resolveOrgScope } from "@/lib/api/scope/parse";

const ORG = "org-1";
const USER = "user-1";

const ctx = (role: string, overrides: Record<string, unknown> = {}) => ({
  raw: ORG,
  memberships: [
    { organizationId: ORG, status: "ACTIVE" as const, role: role as never },
  ],
  userRole: "CONSULTEE",
  userId: USER,
  ...overrides,
});

describe("?orgScope=<orgId> requires operations.read for the org-wide scope", () => {
  it.each(["OWNER", "MAINTAINER", "MANAGER", "SUPPORT"])(
    "%s holds operations.read and gets the org-wide scope",
    (role) => {
      const res = resolveOrgScope(ctx(role));
      expect(res).toEqual({ ok: true, scope: { kind: "org", orgId: ORG } });
    },
  );

  it.each(["LEARNER", "EXPERT", "BILLING_ADMIN"])(
    "%s is downgraded to their own rows, not refused and not widened",
    (role) => {
      const res = resolveOrgScope(ctx(role));
      expect(res).toEqual({
        ok: true,
        scope: { kind: "orgMember", orgId: ORG, userId: USER },
      });
    },
  );

  it("still refuses an org the caller is not an active member of", () => {
    const res = resolveOrgScope(ctx("OWNER", { raw: "some-other-org" }));
    expect(res).toMatchObject({ ok: false, code: "ORG_MEMBERSHIP_REQUIRED" });
  });

  it("does not accept a non-ACTIVE membership as a way in", () => {
    const res = resolveOrgScope({
      raw: ORG,
      memberships: [
        {
          organizationId: ORG,
          status: "SUSPENDED" as never,
          role: "OWNER" as never,
        },
      ],
      userRole: "CONSULTEE",
      userId: USER,
    });
    expect(res).toMatchObject({ ok: false, code: "ORG_MEMBERSHIP_REQUIRED" });
  });
});

/**
 * The `orgMember` kind was previously unhandled in four of the five list
 * helpers — it fell past the `org` branch into the bare `return base`, which
 * is the `all` (admin) arm: no filter at all, every tenant. That was latent
 * while nothing produced an `orgMember` from a request; the downgrade above
 * makes it reachable, so the fall-through had to close in the same change.
 */
describe("every scoped list helper handles orgMember explicitly", () => {
  const HELPERS = [
    "lib/api/scope/list-appointments.ts",
    "lib/api/scope/list-documents.ts",
    "lib/api/scope/list-recordings.ts",
  ];

  it.each(HELPERS)("%s branches on orgMember before the default", (rel) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require("path");
    const src = readFileSync(join(process.cwd(), rel), "utf8") as string;

    expect(src).toContain('kind === "orgMember"');

    // The orgMember branch must appear BEFORE the unfiltered fall-through,
    // otherwise it is unreachable and the scope silently widens.
    const branch = src.indexOf('kind === "orgMember"');
    const fallthrough = src.lastIndexOf("return base;");
    expect(branch).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(fallthrough);
  });

  it.each(HELPERS)("%s constrains orgMember by BOTH org and user", (rel) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require("path");
    const src = readFileSync(join(process.cwd(), rel), "utf8") as string;

    const start = src.indexOf('kind === "orgMember"');
    const branch = src.slice(start, src.lastIndexOf("return base;"));
    // Org alone would be the leak; user alone would cross tenants.
    expect(branch).toContain("params.scope.orgId");
    expect(branch).toContain("params.scope.userId");
  });
});
