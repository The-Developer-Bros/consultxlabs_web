/**
 * Two fail-open shapes around the `?orgScope=` layer, both surfaced by review
 * on #1029 and both consequences of making the `orgMember` kind reachable.
 *
 * 1. Six route handlers wrote `kind === "org" ? { organizationId } : <no
 *    filter>`. The `orgMember` downgrade lands in the else, so a learner who
 *    selected one organization silently received their rows from every
 *    organization plus their personal ones — a filter that quietly stopped
 *    filtering. These routes are self-scoped to the caller, so it is a
 *    correctness bug rather than a cross-tenant leak, but the control still
 *    lied about what it was showing.
 *
 * 2. Every `buildWhere` ended in a bare `return base`, which IS the admin/staff
 *    arm. Any scope kind not explicitly handled — including one added later —
 *    returned platform-wide rows instead of failing. `orgMember` sat in that
 *    fall-through as a latent leak for months.
 *
 * The fix for both is to stop repeating the two-kind test: `scopeOrgId` answers
 * "which org does this scope pin", and `assertNeverScope` makes a new variant a
 * compile error rather than a silent widening.
 */

import { readFileSync } from "fs";
import { join } from "path";

import {
  scopeOrgId,
  assertNeverScope,
  type Scope,
} from "@/lib/api/scope/parse";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("scopeOrgId", () => {
  const ORG = "org-1";

  it.each<[string, Scope, string | null]>([
    ["org pins its org", { kind: "org", orgId: ORG }, ORG],
    [
      "orgMember pins the SAME org — that is the whole point of the downgrade",
      { kind: "orgMember", orgId: ORG, userId: "u1" },
      ORG,
    ],
    ["personal pins none", { kind: "personal" }, null],
    ["all pins none", { kind: "all" }, null],
  ])("%s", (_label, scope, expected) => {
    expect(scopeOrgId(scope)).toBe(expected);
  });
});

describe("assertNeverScope", () => {
  it("throws rather than returning an unfiltered result", () => {
    // Cast because the point is a kind the union does not contain — what a
    // future variant looks like before someone handles it.
    expect(() => assertNeverScope({ kind: "something-new" } as never)).toThrow(
      /Unhandled scope kind/,
    );
  });
});

describe("every scoped list helper fails closed", () => {
  const HELPERS = [
    "lib/api/scope/list-appointments.ts",
    "lib/api/scope/list-documents.ts",
    "lib/api/scope/list-recordings.ts",
  ];

  it.each(HELPERS)(
    "%s ends in an exhaustiveness check, not `return base`",
    (rel) => {
      const src = read(rel);

      // The `all` arm must be stated, not inherited.
      expect(src).toContain('if (params.scope.kind === "all") return base;');
      // And the final position must throw rather than return rows.
      expect(src).toContain("return assertNeverScope(params.scope);");

      const allArm = src.lastIndexOf('kind === "all"');
      const guard = src.lastIndexOf("assertNeverScope(params.scope)");
      expect(allArm).toBeGreaterThan(-1);
      expect(guard).toBeGreaterThan(allArm);
    },
  );
});

describe("every self-scoped consumer treats orgMember as an org filter", () => {
  const CONSUMERS = [
    "app/api/bookings/classes/route.ts",
    "app/api/bookings/subscriptions/route.ts",
    "app/api/bookings/webinars/route.ts",
    "app/api/dashboard/consultant/[consultantId]/documents/route.ts",
    "app/api/dashboard/consultant/[consultantId]/planner/route.ts",
    "app/api/dashboard/consultee/[consulteeId]/payments/route.ts",
  ];

  it.each(CONSUMERS)("%s routes the org question through scopeOrgId", (rel) => {
    const src = read(rel);
    expect(src).toContain("scopeOrgId");
  });

  it.each(CONSUMERS)(
    '%s no longer branches on `kind === "org"` alone',
    (rel) => {
      const src = read(rel);
      // This is the exact shape that dropped the filter: testing only for `org`
      // sends `orgMember` into the unfiltered else.
      expect(src).not.toMatch(/scope\.kind === "org"\s*$/m);
      expect(src).not.toContain('scope.kind === "org"\n');
    },
  );
});
