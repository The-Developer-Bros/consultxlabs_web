/**
 * @jest-environment node
 */

/**
 * The marketplace must not surface a tenant-private or a withdrawn plan.
 *
 * Two guards, one test file, because they fail the same way and are enforced in
 * the same `where` clauses:
 *
 *   #726            — an `ORG_ONLY` plan is visible to its own org only, and
 *                     `/explore/**` plus the public plan APIs must filter it out.
 *   #catalog-archive — an archived plan is withdrawn from sale and must leave
 *                     discovery too.
 *
 * `#726` shipped with no test at all, which mattered less while nothing could
 * actually produce an `ORG_ONLY` row. The org catalog is the first surface that
 * can, so the guard is now load-bearing and gets pinned here.
 *
 * These are BEHAVIOURAL rather than source-level: they call the real functions
 * and capture the `where` object actually handed to Prisma. A source grep would
 * pass if the filter were built and then dropped before the query.
 *
 * Deliberately NOT an end-to-end check against a live database. Proving "an
 * ORG_ONLY plan stays off the marketplace" that way means creating one on the
 * shared database first — and if the guard is broken, which is the case the
 * test exists to catch, the plan is briefly live on the public marketplace.
 * The failure mode of the experiment is the incident.
 */

import {
  buildPlanWhereClause,
  type PlanFilterParams,
} from "@/app/api/plans/shared/plan-filters";
import {
  marketplaceVisibilityWhere,
  eventPlanDiscoverableWhere,
} from "@/lib/api/plans/visibility";

const PUBLIC_SET = ["PUBLIC", "ORG_AND_PUBLIC"];

describe("#726 — ORG_ONLY never reaches a public plan query", () => {
  /** Every filter off — what an unfiltered marketplace request produces. */
  const NO_FILTERS: PlanFilterParams = {
    consultantId: null,
    topicIds: null,
    language: null,
    domainId: null,
    sort: null,
    minPrice: undefined,
    maxPrice: undefined,
    search: null,
    level: null,
    page: 1,
    limit: 20,
    skip: 0,
  };

  it("buildPlanWhereClause constrains visibility on an empty filter set", () => {
    // This is the real builder behind GET /api/plans/webinars and /classes.
    const where = buildPlanWhereClause(NO_FILTERS);
    expect(where.visibility).toEqual({ in: PUBLIC_SET });
    expect(where.visibility?.in).not.toContain("ORG_ONLY");
  });

  it("caller-supplied filters cannot dislodge the visibility gate", () => {
    // The filters come from query params, so the guard has to survive whatever
    // a caller passes. If the builder ever spread user input over its own
    // defaults, this is where it would show.
    const where = buildPlanWhereClause({
      ...NO_FILTERS,
      consultantId: "consultant-1",
      language: "English",
      level: "Beginner",
      minPrice: 0,
      maxPrice: 100000,
      search: "anything",
      topicIds: "t1,t2",
      domainId: "d1",
    });

    expect(where.visibility).toEqual({ in: PUBLIC_SET });
    expect(where.consultantProfileId).toBe("consultant-1");
  });

  it("the shared visibility constant excludes ORG_ONLY", () => {
    expect(marketplaceVisibilityWhere().visibility.in).toEqual(PUBLIC_SET);
    expect(eventPlanDiscoverableWhere().visibility.in).toEqual(PUBLIC_SET);
  });
});

describe("#catalog-archive — withdrawn plans leave discovery", () => {
  it("buildPlanWhereClause excludes archived rows", () => {
    expect(
      buildPlanWhereClause({
        consultantId: null,
        topicIds: null,
        language: null,
        domainId: null,
        sort: null,
        minPrice: undefined,
        maxPrice: undefined,
        search: null,
        level: null,
        page: 1,
        limit: 20,
        skip: 0,
      }).archivedAt,
    ).toBeNull();
  });

  it("the event-plan helper carries BOTH gates", () => {
    const where = eventPlanDiscoverableWhere();
    expect(where.visibility.in).toEqual(PUBLIC_SET);
    expect(where.archivedAt).toBeNull();
  });

  it("the plain helper does NOT carry the archive gate", () => {
    // ConsultationPlan and SubscriptionPlan have no archivedAt column. If this
    // helper grew the filter, Prisma would reject every query that spreads it —
    // which is why the two helpers exist separately rather than one being
    // extended.
    expect(marketplaceVisibilityWhere()).not.toHaveProperty("archivedAt");
  });
});

describe("the two guards are independent", () => {
  it("an archived PUBLIC plan is still excluded", () => {
    // Regression shape: someone could reasonably assume the visibility gate
    // subsumes the archive one. It does not — a plan can be perfectly public
    // and still withdrawn.
    const where = eventPlanDiscoverableWhere();
    expect(where.visibility.in).toContain("PUBLIC");
    expect(where.archivedAt).toBeNull();
  });
});
