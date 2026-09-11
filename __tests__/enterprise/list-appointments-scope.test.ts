/**
 * @jest-environment node
 */

/**
 * #org-appts — personal-scope appointment query. The personal dashboards are now
 * purely B2C on BOTH sides: `organizationId: null` is pinned at the top level, so
 * every org-hosted session (delivered OR attended) is excluded here and lives in
 * the org dashboard under `orgMember` scope. Retires the earlier #674 carve-out
 * that force-showed delivered org sessions in the personal list.
 */

import { buildWhere } from "@/lib/api/scope/list-appointments";

describe("buildWhere — personal scope (#org-appts)", () => {
  const where = buildWhere({
    scope: { kind: "personal" },
    userId: "u1",
  }) as {
    organizationId: unknown;
    OR: Array<Record<string, unknown>>;
  };

  it("pins organizationId: null at the top level (purely B2C)", () => {
    expect(where.organizationId).toBeNull();
  });

  it("covers both sides — 3 consultee + 5 consultant arms, none re-pinning org", () => {
    // consultee: consultation / subscription / trial ; consultant: consultation-
    // plan / subscription-plan / trial / webinar-plan / class-plan
    expect(where.OR).toHaveLength(8);
    // The org constraint is top-level, so no arm carries its own organizationId.
    expect(where.OR.every((a) => !("organizationId" in a))).toBe(true);
    const hasConsultantUser = where.OR.some((a) =>
      JSON.stringify(a).includes('"consultantProfile":{"userId":"u1"}'),
    );
    expect(hasConsultantUser).toBe(true);
    const hasConsulteeUser = where.OR.some((a) =>
      JSON.stringify(a).includes('"requestedBy":{"userId":"u1"}'),
    );
    expect(hasConsulteeUser).toBe(true);
  });

  it("org scope matches org-OWNED rows only, and never filters by user (#1166 ORG-8)", () => {
    const w = buildWhere({
      scope: { kind: "org", orgId: "org1" },
      userId: "u1",
    }) as Record<string, unknown>;

    // List/detail parity: the detail page 404s any row whose organizationId
    // isn't this org, so the list must not offer funded-elsewhere rows it
    // cannot open. Cross-org funding visibility moved to the money views.
    expect(w.organizationId).toBe("org1");
    expect(w.OR).toBeUndefined();

    // The property the previous version of this test was really protecting:
    // the org arm carries NO user filter, which is why it requires
    // `operations.read` and why a non-operator is downgraded to `orgMember`.
    expect(JSON.stringify(w)).not.toContain('"u1"');
    expect(JSON.stringify(w)).not.toContain("userId");
  });

  it("org scope no longer matches funded-elsewhere rows (#1166 ORG-8)", () => {
    const w = buildWhere({
      scope: { kind: "org", orgId: "org1" },
      userId: "u1",
    });

    // A row hosted by another org but funded by org1 matched the old
    // `payment.some.organizationId` arm; the detail page then 404'd it.
    // The predicate must not mention Payment at all any more.
    expect(JSON.stringify(w)).not.toContain("payment");
  });

  it("orgMember scope pins organizationId AND filters to the user's participation (#org-appts)", () => {
    const w = buildWhere({
      scope: { kind: "orgMember", orgId: "org1", userId: "u1" },
      userId: "u1",
    }) as { organizationId: string; OR: Array<Record<string, unknown>> };
    // Strictly this org's activity...
    expect(w.organizationId).toBe("org1");
    // ...AND only the user's own — booked / attended (held seat) / delivered
    // arms. Trials are excluded (B2C, personal scope).
    expect(w.OR).toHaveLength(7);
    const s = JSON.stringify(w.OR);
    expect(s).toContain('"requestedBy":{"userId":"u1"}'); // consultee side
    expect(s).toContain('"consultantProfile":{"userId":"u1"}'); // consultant side
    expect(s).not.toContain("trialSession"); // trials stay B2C/personal
    // No arm re-pins organizationId: null (that's personal scope, not this).
    expect(w.OR.every((arm) => !("organizationId" in arm))).toBe(true);
  });

  it("orgMember scope matches an org-sponsored attendee via slot membership (#1166 ORG-5)", () => {
    const w = buildWhere({
      scope: { kind: "orgMember", orgId: "org1", userId: "u1" },
      userId: "u1",
    }) as { OR: Array<Record<string, unknown>> };

    // A webinar/class registrant holds a slot but never appears in
    // requestedBy (group events share ONE Appointment), so this arm is the
    // only reason an org-sponsored attendee's session is visible anywhere.
    // Mirrors lib/data/consultee-events-read.ts slot membership.
    expect(w.OR).toContainEqual({
      slotsOfAppointment: { some: { user: { some: { id: "u1" } } } },
    });
  });
});
