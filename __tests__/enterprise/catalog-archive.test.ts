/**
 * Retiring a catalog plan must never delete it.
 *
 * The plan foreign keys cascade the whole way down —
 * `WebinarPlan` → `Webinar` → `Appointment` → `Payment`, every hop declared
 * `onDelete: Cascade`. So a hard delete of one catalog row would physically
 * destroy the sessions booked from it AND their payment records. The plan row
 * is also the terms of every sale made against it: past appointments, invoices
 * and earnings all resolve their title, price and duration by reading it.
 *
 * Archiving is therefore the only safe primitive here, and these tests pin the
 * three things that keep it safe:
 *
 *   1. the catalog endpoint has no delete call at all, so there is no path to
 *      the cascade even by accident;
 *   2. public discovery filters archived plans out;
 *   3. the archive filter is NOT attached to the two plan models that lack the
 *      column, which would make their queries throw.
 *
 * Source-level assertions, matching the sibling suites: what matters is which
 * where-clause each surface reaches for.
 */

import { readFileSync } from "fs";
import { join } from "path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const CATALOG_ROUTE = "app/api/organizations/[orgId]/catalog/route.ts";
const PLAN_FILTERS = "app/api/plans/shared/plan-filters.ts";
const VISIBILITY = "lib/api/plans/visibility.ts";
const EXPLORE = "lib/data/explore-programs.ts";
const SCHEMA = "prisma/schema.prisma";

describe("catalog plans are archived, never deleted", () => {
  it("the catalog endpoint contains no delete call", () => {
    const src = read(CATALOG_ROUTE);
    // Not `.not.toContain("delete")` — that would match `DELETE` the HTTP verb.
    // These are the Prisma client calls that would actually fire the cascade.
    expect(src).not.toMatch(/\.deleteMany\(/);
    expect(src).not.toMatch(/\btx\.\w+Plan\.delete\(/);
    expect(src).not.toMatch(/\bprisma\.\w+Plan\.delete\(/);
    // And it does archive.
    expect(src).toMatch(/archivedAt/);
  });

  it("both archivable models declare the column", () => {
    const schema = read(SCHEMA);
    for (const model of ["WebinarPlan", "ClassPlan"]) {
      const block = schema.slice(
        schema.indexOf(`model ${model} {`),
        schema.indexOf("\n}", schema.indexOf(`model ${model} {`)),
      );
      expect(block).toMatch(/archivedAt\s+DateTime\?/);
    }
  });

  it("the cascade this protects against is still declared", () => {
    // If someone relaxes these to SetNull/Restrict the archive-only rule could
    // be revisited — so pin the premise, not just the conclusion.
    const schema = read(SCHEMA);
    const webinar = schema.slice(
      schema.indexOf("model Webinar {"),
      schema.indexOf("\n}", schema.indexOf("model Webinar {")),
    );
    expect(webinar).toMatch(/webinarPlan\s+WebinarPlan @relation\(.*onDelete: Cascade/);
  });
});

describe("archived plans leave public discovery", () => {
  it("the shared plan filter pins archivedAt: null", () => {
    const src = read(PLAN_FILTERS);
    expect(src).toMatch(/archivedAt:\s*null/);
  });

  it("the event-plan discovery helper carries both gates", () => {
    const src = read(VISIBILITY);
    const start = src.indexOf("export function eventPlanDiscoverableWhere()");
    expect(start).toBeGreaterThan(-1);
    // Slice to the function's own closing brace (column 0), not the first "}"
    // encountered — that one belongs to the nested visibility object.
    const body = src.slice(start, src.indexOf("\n}", start));
    expect(body).toMatch(/MARKETPLACE_VISIBILITY/);
    expect(body).toMatch(/archivedAt:\s*null/);
  });

  it("every explore query for an event plan uses that helper", () => {
    const src = read(EXPLORE);
    // The plain visibility helper would let an archived plan through here; only
    // ConsultationPlan / SubscriptionPlan surfaces may still use it, and this
    // file queries neither.
    expect(src).not.toContain("marketplaceVisibilityWhere(");
    expect(src).toContain("eventPlanDiscoverableWhere(");
  });

  it("the models without the column keep the plain visibility filter", () => {
    // ConsultationPlan and SubscriptionPlan have no archivedAt; attaching the
    // filter to their queries would make Prisma reject them at runtime.
    for (const rel of [
      "app/api/plans/consultations/route.ts",
      "app/api/plans/subscriptions/route.ts",
    ]) {
      const src = read(rel);
      expect(src).toContain("marketplaceVisibilityWhere(");
      expect(src).not.toContain("eventPlanDiscoverableWhere(");
    }
  });
});
