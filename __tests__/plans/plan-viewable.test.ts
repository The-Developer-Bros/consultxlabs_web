import { isPlanViewable } from "@/lib/api/plans/visibility";

/**
 * The detail-page gate. Before this existed the four detail pages fetched by
 * primary key with no filter, so an ORG_ONLY plan was readable by anyone
 * holding its id and an archived plan still rendered a working page.
 */
describe("isPlanViewable", () => {
  const noMembership = jest.fn(async () => false);
  const hasMembership = jest.fn(async () => true);

  beforeEach(() => {
    noMembership.mockClear();
    hasMembership.mockClear();
  });

  const plan = (over: Partial<Parameters<typeof isPlanViewable>[0]> = {}) =>
    ({
      visibility: "PUBLIC" as const,
      organizationId: null,
      archivedAt: null,
      ...over,
    }) as NonNullable<Parameters<typeof isPlanViewable>[0]>;

  it("shows a PUBLIC plan to a signed-out visitor", async () => {
    await expect(isPlanViewable(plan(), null, noMembership)).resolves.toBe(true);
    expect(noMembership).not.toHaveBeenCalled();
  });

  it("shows an ORG_AND_PUBLIC plan to a signed-out visitor", async () => {
    await expect(
      isPlanViewable(
        plan({ visibility: "ORG_AND_PUBLIC", organizationId: "org1" }),
        null,
        noMembership,
      ),
    ).resolves.toBe(true);
  });

  it("hides an ORG_ONLY plan from a signed-out visitor", async () => {
    await expect(
      isPlanViewable(
        plan({ visibility: "ORG_ONLY", organizationId: "org1" }),
        null,
        noMembership,
      ),
    ).resolves.toBe(false);
  });

  it("hides an ORG_ONLY plan from a signed-in non-member", async () => {
    await expect(
      isPlanViewable(
        plan({ visibility: "ORG_ONLY", organizationId: "org1" }),
        "user1",
        noMembership,
      ),
    ).resolves.toBe(false);
    expect(noMembership).toHaveBeenCalledWith({
      userId: "user1",
      organizationId: "org1",
    });
  });

  it("shows an ORG_ONLY plan to an ACTIVE member of the owning org", async () => {
    await expect(
      isPlanViewable(
        plan({ visibility: "ORG_ONLY", organizationId: "org1" }),
        "user1",
        hasMembership,
      ),
    ).resolves.toBe(true);
  });

  it("hides an archived plan even when it is PUBLIC", async () => {
    await expect(
      isPlanViewable(
        plan({ archivedAt: new Date("2026-01-01") }),
        "user1",
        hasMembership,
      ),
    ).resolves.toBe(false);
    // Archive short-circuits before any membership lookup.
    expect(hasMembership).not.toHaveBeenCalled();
  });

  it("hides an archived ORG_ONLY plan from a member", async () => {
    await expect(
      isPlanViewable(
        plan({
          visibility: "ORG_ONLY",
          organizationId: "org1",
          archivedAt: new Date("2026-01-01"),
        }),
        "user1",
        hasMembership,
      ),
    ).resolves.toBe(false);
  });

  it("hides an ORG_ONLY plan with no owning org rather than failing open", async () => {
    await expect(
      isPlanViewable(
        plan({ visibility: "ORG_ONLY", organizationId: null }),
        "user1",
        hasMembership,
      ),
    ).resolves.toBe(false);
  });

  it("treats a missing plan as not viewable", async () => {
    await expect(isPlanViewable(null, "user1", hasMembership)).resolves.toBe(
      false,
    );
  });
});

/**
 * Owner preview. A consultant may open their own DRAFT or archived offering at
 * the REAL detail URL, so "preview" is the actual page rather than a second
 * renderer that can drift from it. Nobody else's access changes.
 */
describe("isPlanViewable — owner preview", () => {
  const noMembership = jest.fn(async () => false);

  const ownedPlan = (over: Record<string, unknown> = {}) =>
    ({
      visibility: "ORG_ONLY" as const,
      organizationId: "org1",
      archivedAt: null,
      consultantProfileId: "cp-1",
      ...over,
    }) as NonNullable<Parameters<typeof isPlanViewable>[0]>;

  it("shows an author their own ORG_ONLY plan", async () => {
    await expect(
      isPlanViewable(ownedPlan(), "user-1", noMembership, "cp-1"),
    ).resolves.toBe(true);
  });

  it("shows an author their own ARCHIVED plan", async () => {
    await expect(
      isPlanViewable(
        ownedPlan({ archivedAt: new Date("2026-01-01") }),
        "user-1",
        noMembership,
        "cp-1",
      ),
    ).resolves.toBe(true);
  });

  it("does not widen anything for a different consultant", async () => {
    await expect(
      isPlanViewable(ownedPlan(), "user-2", noMembership, "cp-2"),
    ).resolves.toBe(false);
  });

  it("does not widen anything for a signed-out visitor", async () => {
    await expect(
      isPlanViewable(ownedPlan(), null, noMembership, null),
    ).resolves.toBe(false);
  });

  it("leaves behaviour unchanged when the caller passes no owner context", async () => {
    await expect(
      isPlanViewable(ownedPlan(), "user-1", noMembership),
    ).resolves.toBe(false);
  });
});
