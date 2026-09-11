/**
 * @jest-environment node
 */

/**
 * `POST /api/admin/refunds` executes a refund — it moves real money.
 *
 * It was guarded by `requirePrivilegedAuth`, which admits STAFF. The
 * dashboard only ever hid the button from staff, so a staff member could
 * still issue a refund by calling the route directly. This pins the fix: the
 * mutation now resolves `refunds.manage` through BACKOFFICE_PERMISSIONS,
 * which is ADMIN-only, while GET stays privileged so staff keep the money
 * read they need for ticket context.
 */

// Only the pure matrix module is imported. `lib/auth-helpers` drags the
// BetterAuth ESM chain through jest; the guard it exports is asserted at the
// source level below instead.
import { readFileSync } from "fs";
import { join } from "path";

import {
  hasBackofficePermission,
  type BackofficeSurface,
} from "@/lib/auth/backoffice-permissions";

describe("refund execution is admin-only", () => {
  it("route source guards POST on refunds.manage, not requirePrivilegedAuth", () => {
    // Source-level assertion: the alternative is standing up the whole
    // refundPayment path, and what matters here is which guard the mutation
    // reaches for.
    const src = readFileSync(
      join(process.cwd(), "app/api/admin/refunds/route.ts"),
      "utf8",
    );

    const postBody = src.slice(src.indexOf("export async function POST"));
    expect(postBody).toContain('requireBackofficeSurface("refunds.manage")');
    expect(postBody).not.toContain("requirePrivilegedAuth()");
    // The call on its own proves nothing: deleting the early return leaves
    // both assertions above green while refunds stay open to STAFF — the exact
    // regression this file exists to catch. Pin the short-circuit too.
    expect(postBody).toMatch(/if\s*\(auth\.error\)\s*return\s+auth\.error;/);

    // GET keeps the wider grant — staff read every money surface.
    const getBody = src.slice(
      src.indexOf("export async function GET"),
      src.indexOf("export async function POST"),
    );
    expect(getBody).toContain("requirePrivilegedAuth()");
  });

  it("refunds.manage excludes STAFF and admits ADMIN", () => {
    expect(hasBackofficePermission("STAFF", "refunds.manage")).toBe(false);
    expect(hasBackofficePermission("ADMIN", "refunds.manage")).toBe(true);
  });

  it("every money mutation surface is admin-only", () => {
    // The whole point of the split: staff read money, admin moves it.
    const mutations: BackofficeSurface[] = [
      "payments.manage",
      "refunds.manage",
      "disputes.manage",
      "invoices.manage",
      "subscriptions.manage",
      "payouts.manage",
      "approvalPayments.manage",
    ];
    for (const surface of mutations) {
      expect(hasBackofficePermission("STAFF", surface)).toBe(false);
      expect(hasBackofficePermission("ADMIN", surface)).toBe(true);
    }
  });

  it("auth-helpers exports the surface-scoped guard the route imports", () => {
    const src = readFileSync(
      join(process.cwd(), "lib/auth-helpers.ts"),
      "utf8",
    );
    expect(src).toContain("export async function requireBackofficeSurface");
  });
});
