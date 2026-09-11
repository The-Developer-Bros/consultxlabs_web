/**
 * Source-level guards for three critical holes and the PII-leak class around
 * them. Asserted on source rather than by invoking handlers: what matters is
 * *which guard the handler reaches for* and *which shape the query uses*, and
 * standing up Supabase + BetterAuth to prove that would test the mocks.
 *
 * Every case here was verified against the running code before the fix.
 */

import { readFileSync } from "fs";
import { join } from "path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("/api/user/staff/[id] is no longer unauthenticated", () => {
  const src = read("app/api/user/staff/[id]/route.ts");

  it("guards every exported handler", () => {
    // It shipped with ZERO auth on all five: PUT rewrote the linked User's
    // email (an account-takeover primitive, since emailVerified is not reset)
    // and DELETE removed the profile. Middleware only checks cookie presence,
    // so nothing upstream covered it.
    const handlers = Array.from(
      src.matchAll(/export async function (GET|POST|PATCH|PUT|DELETE)\(/g),
      (m) => m[1],
    );
    expect(handlers.sort()).toEqual(["DELETE", "GET", "PATCH", "POST", "PUT"]);

    // Each handler body must reach a guard before touching prisma.
    for (const verb of handlers) {
      const start = src.indexOf(`export async function ${verb}(`);
      const body = src.slice(start, start + 900);
      expect({
        verb,
        guarded: /require(SelfOrAdmin|AdminAuth)\(/.test(body),
      }).toEqual({
        verb,
        guarded: true,
      });
    }
  });

  it("reserves profile create/delete for ADMIN", () => {
    for (const verb of ["POST", "DELETE"]) {
      const start = src.indexOf(`export async function ${verb}(`);
      expect(src.slice(start, start + 500)).toContain("requireAdminAuth()");
    }
  });
});

describe("PUT /api/user/[id] cannot escalate privilege", () => {
  const src = read("app/api/user/[id]/route.ts");

  it("rejects a role change from the self-edit branch", () => {
    // The auth check admits a user editing THEMSELVES, and `role` used to flow
    // from the body straight into the update — so any consultee could PUT
    // their own id with {"role":"ADMIN"}.
    const put = src.slice(
      src.indexOf("export async function PUT("),
      src.indexOf("export async function PATCH("),
    );
    expect(put).toContain("body.role !== undefined");
    expect(put).toContain("status: 403");
    // Still admin-gated AND never self-applied.
    expect(put).toMatch(/!isAdmin \|\| session\.user\.id === id/);
  });
});

describe("consultant statutory PII is never returned by a bare include", () => {
  // ConsultantProfile carries panNumber, ibanOrAccount, swiftBic, udyamNumber
  // and tdsLowerRateCert. A Prisma `include:` returns all of them; only a
  // `select:` allowlist keeps them out. This is the #946 bug class.
  const ROUTES = [
    "app/api/user/reviews/route.ts",
    "app/api/user/reviews/[id]/route.ts",
    "app/api/dashboard/consultee/[consulteeId]/route.ts",
    "app/api/admin/earnings/route.ts",
    "app/api/staff/support-tickets/[ticketId]/route.ts",
  ];

  it.each(ROUTES)("%s selects an allowlist", (rel) => {
    // Strip comments first — the fix commentary quotes the very anti-patterns
    // being asserted against, and matching those would be a false positive.
    const src = read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    // Either the scalar allowlist itself or `publicReviewSelect`, which is
    // built on it (asserted below) and is the whole-review allowlist.
    expect(src).toMatch(/consultantPublicScalars|publicReviewSelect/);
    expect(src).not.toMatch(/consultantProfile: true/);
    expect(src).not.toMatch(/consultantProfile: \{\s*\n\s*include:/);
  });

  it("publicReviewSelect is built on the scalar allowlist", () => {
    expect(read("lib/data/review-public.ts")).toContain(
      "...consultantPublicScalars",
    );
  });

  it("the public reviews list is not serving PII to anonymous callers", () => {
    const src = read("app/api/user/reviews/route.ts");
    // middleware.ts marks this route public and the response is CDN-cached,
    // so a leak here is world-readable and persisted at the edge.
    expect(src).toContain("Cache-Control");
    expect(src).toContain("select: publicReviewSelect");
    // The write paths too: `include` returns every scalar on the row.
    expect(src).not.toMatch(/\binclude,\n/);
  });
});

describe("participant rosters do not return full User rows", () => {
  const ROUTES = [
    "app/api/participants/consultations/[consultationId]/route.ts",
    "app/api/participants/subscriptions/[subscriptionId]/route.ts",
  ];

  it.each(ROUTES)("%s narrows the user select", (rel) => {
    // `user: true` shipped phone, address, dateOfBirth, city and country on
    // every roster poll. The class/ and webinar/ siblings were hardened in the
    // #946 sweep; these two were missed.
    const src = read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/user: true/);
    expect(src).toContain("PARTICIPANT_USER_SELECT");
  });
});
