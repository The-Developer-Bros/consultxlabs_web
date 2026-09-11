/**
 * @jest-environment node
 */

/**
 * Pin the SCIM resource shape + group-to-role resolution semantics.
 * The mapper is pure (no Prisma dependency); the route handlers
 * inject the join data, so the unit boundary is exactly here.
 */

import {
  parseDisplayName,
  resolveRoleFromGroupNames,
  toScimUser,
} from "@/lib/scim/resource-user";

describe("toScimUser", () => {
  const base = {
    membership: {
      id: "mem-1",
      externalScimId: "okta-user-42",
      status: "ACTIVE" as const,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-05-15T10:00:00Z"),
    },
    user: { id: "u-1", name: "Alice Doe", email: "alice@acme.com" },
    baseUrl: "https://app.familiarise.work",
  };

  it("emits the canonical core User schema URN + resource id from externalScimId", () => {
    const out = toScimUser(base);
    expect(out.schemas).toEqual([
      "urn:ietf:params:scim:schemas:core:2.0:User",
    ]);
    // The resource id MUST be the externalScimId when present so the
    // IdP can round-trip its own identifier without surprise.
    expect(out.id).toBe("okta-user-42");
    expect(out.userName).toBe("alice@acme.com");
  });

  it("falls back to membership.id when externalScimId is null", () => {
    const out = toScimUser({
      ...base,
      membership: { ...base.membership, externalScimId: null },
    });
    expect(out.id).toBe("mem-1");
  });

  it("maps Membership.status=SUSPENDED → active=false", () => {
    const out = toScimUser({
      ...base,
      membership: { ...base.membership, status: "SUSPENDED" },
    });
    expect(out.active).toBe(false);
  });

  it("constructs a meta.location URL the IdP can retry against", () => {
    const out = toScimUser(base);
    expect(out.meta.location).toBe(
      "https://app.familiarise.work/scim/v2/Users/okta-user-42",
    );
  });
});

describe("parseDisplayName", () => {
  it("splits on the LAST space (handles middle names)", () => {
    expect(parseDisplayName("Alice Mary Doe")).toEqual({
      givenName: "Alice Mary",
      familyName: "Doe",
    });
  });
  it("handles a single-word name (no family name)", () => {
    expect(parseDisplayName("Madonna")).toEqual({
      givenName: "Madonna",
      familyName: "",
    });
  });
});

describe("resolveRoleFromGroupNames", () => {
  const mappings = [
    { scimGroupName: "IT-Admins", role: "MAINTAINER" as const },
    { scimGroupName: "Finance-Leads", role: "BILLING_ADMIN" as const },
    { scimGroupName: "All-Employees", role: "LEARNER" as const },
  ];

  it("defaults to LEARNER when no groups match (least-privilege)", () => {
    expect(resolveRoleFromGroupNames(["Random-Group"], mappings)).toBe(
      "LEARNER",
    );
    expect(resolveRoleFromGroupNames([], mappings)).toBe("LEARNER");
  });

  it("picks the highest-rank role when the user is in multiple mapped groups", () => {
    // BILLING_ADMIN (70) beats LEARNER (20).
    expect(
      resolveRoleFromGroupNames(["Finance-Leads", "All-Employees"], mappings),
    ).toBe("BILLING_ADMIN");
    // MAINTAINER (80) beats BILLING_ADMIN (70).
    expect(
      resolveRoleFromGroupNames(
        ["IT-Admins", "Finance-Leads", "All-Employees"],
        mappings,
      ),
    ).toBe("MAINTAINER");
  });

  it("ignores unknown group names without throwing", () => {
    expect(
      resolveRoleFromGroupNames(["IT-Admins", "Phantom-Group"], mappings),
    ).toBe("MAINTAINER");
  });
});
