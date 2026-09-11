/**
 * The staff/admin split lives in exactly one place — BACKOFFICE_PERMISSIONS —
 * and three consumers read it: the sidebar (visibility), the page guards, and
 * the API routes. These tests pin the policy so a surface can't quietly widen,
 * and pin the invariant that made the two dashboards drift in the first place:
 * a nav item must never appear for a role whose guard would then reject it.
 */

import {
  BACKOFFICE_PERMISSIONS,
  hasBackofficePermission,
  type BackofficeSurface,
} from "@/lib/auth/backoffice-permissions";
import { buildBackofficeNav } from "@/lib/dashboard/backoffice-nav";

const flatten = (groups: ReturnType<typeof buildBackofficeNav>) =>
  groups.flatMap((g) => g.items.map((i) => i.path));

describe("BACKOFFICE_PERMISSIONS", () => {
  it("grants STAFF read on the money surfaces they need for ticket context", () => {
    for (const surface of [
      "payments.read",
      "refunds.read",
      "disputes.read",
      "invoices.read",
      "subscriptions.read",
    ] as BackofficeSurface[]) {
      expect(hasBackofficePermission("STAFF", surface)).toBe(true);
    }
  });

  it("never grants STAFF a money mutation", () => {
    for (const surface of [
      "payments.manage",
      "refunds.manage",
      "disputes.manage",
      "invoices.manage",
      "subscriptions.manage",
      "payouts.read",
      "payouts.manage",
      "approvalPayments.manage",
      "tds.read",
    ] as BackofficeSurface[]) {
      expect(hasBackofficePermission("STAFF", surface)).toBe(false);
    }
  });

  it("keeps destructive user actions and platform control admin-only", () => {
    for (const surface of [
      "users.moderate",
      "organizations.manage",
      "announcements.manage",
      "systemJobs.manage",
      "maintenance.manage",
    ] as BackofficeSurface[]) {
      expect(hasBackofficePermission("STAFF", surface)).toBe(false);
      expect(hasBackofficePermission("ADMIN", surface)).toBe(true);
    }
  });

  it("gives STAFF the whole support remit", () => {
    for (const surface of [
      "tickets.manage",
      "feedback.manage",
      "moderation.manage",
      "appointments.manage",
      "waitlist.manage",
      "users.read",
      "users.verify",
    ] as BackofficeSurface[]) {
      expect(hasBackofficePermission("STAFF", surface)).toBe(true);
    }
  });

  it("grants ADMIN every surface", () => {
    for (const surface of Object.keys(
      BACKOFFICE_PERMISSIONS,
    ) as BackofficeSurface[]) {
      expect(hasBackofficePermission("ADMIN", surface)).toBe(true);
    }
  });
});

describe("buildBackofficeNav", () => {
  it("never shows a staff-tree item the STAFF role cannot reach", () => {
    // The exact class of bug the matrix exists to prevent: a visible tab whose
    // page guard 403s. Every rendered path must resolve to a granted surface.
    const forbidden = [
      "payouts",
      "approval-payments",
      "tds",
      "organizations",
      "announcements",
      "system-jobs",
      "maintenance",
      "analytics",
    ];
    const staffPaths = flatten(buildBackofficeNav("staff", { showTds: true }));
    for (const path of forbidden) {
      expect(staffPaths).not.toContain(path);
    }
  });

  it("gives the admin tree the full surface list", () => {
    const adminPaths = flatten(buildBackofficeNav("admin", { showTds: true }));
    for (const path of [
      "home",
      "tickets",
      "feedback",
      "moderation",
      "appointments",
      "waitlist",
      "users",
      "payments",
      "refunds",
      "disputes",
      "invoices",
      "subscriptions",
      "payouts",
      "approval-payments",
      "tds",
      "analytics",
      "organizations",
      "announcements",
      "system-jobs",
      "maintenance",
    ]) {
      expect(adminPaths).toContain(path);
    }
  });

  it("keeps Metrics staff-only and Analytics admin-only", () => {
    // Not a rename of one another: different endpoints, different questions
    // (support-queue health vs platform revenue).
    expect(flatten(buildBackofficeNav("staff"))).toContain("metrics");
    expect(flatten(buildBackofficeNav("staff"))).not.toContain("analytics");
    expect(flatten(buildBackofficeNav("admin"))).toContain("analytics");
    expect(flatten(buildBackofficeNav("admin"))).not.toContain("metrics");
  });

  it("honours the TDS feature flag on the admin tree", () => {
    expect(
      flatten(buildBackofficeNav("admin", { showTds: false })),
    ).not.toContain("tds");
    expect(flatten(buildBackofficeNav("admin", { showTds: true }))).toContain(
      "tds",
    );
  });

  it("emits no empty groups", () => {
    for (const tree of ["admin", "staff"] as const) {
      for (const group of buildBackofficeNav(tree)) {
        expect(group.items.length).toBeGreaterThan(0);
      }
    }
  });

  it("gives the staff tree strictly fewer items than the admin tree", () => {
    const staff = flatten(buildBackofficeNav("staff", { showTds: true }));
    const admin = flatten(buildBackofficeNav("admin", { showTds: true }));
    expect(staff.length).toBeLessThan(admin.length);
  });
});
