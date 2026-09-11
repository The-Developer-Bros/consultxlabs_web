/**
 * BILLING_ADMIN could not edit the billing email.
 *
 * The server had always allowed it: `BILLING_ADMIN_FIELDS` in the org PATCH
 * route is exactly `{ billingEmail, paymentTermsDays }`, and the field-level
 * gate admits the role for those two. The UI never caught up — both fields
 * lived only on the General panel, gated on `settings.manage`, which is
 * GOVERNANCE (OWNER + MAINTAINER). The disabled-state comments there pointed
 * at "the billing page" as the place BILLING_ADMIN would edit them, and no such
 * surface was ever built.
 *
 * The fix is a Settings tab keyed to `billing.manage`, carrying only those two
 * fields — rather than opening General conditionally, which would leave the
 * next field added there one oversight away from the wrong role.
 */

import { readFileSync } from "fs";
import { join } from "path";

import { hasOrgPermission } from "@/lib/auth/org-permissions";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const SETTINGS_DIR = "app/dashboard/organization/[orgId]/settings";
const TABS = `${SETTINGS_DIR}/SettingsTabs.tsx`;
const PANEL = `${SETTINGS_DIR}/BillingSettingsPanel.tsx`;
const ORG_PATCH = "app/api/organizations/[orgId]/route.ts";

describe("the matrix already drew this line", () => {
  it("BILLING_ADMIN holds billing.manage but not settings.manage", () => {
    expect(hasOrgPermission("BILLING_ADMIN", "billing.manage")).toBe(true);
    expect(hasOrgPermission("BILLING_ADMIN", "settings.manage")).toBe(false);
  });

  it("OWNER holds both, so nothing they could do before is taken away", () => {
    expect(hasOrgPermission("OWNER", "billing.manage")).toBe(true);
    expect(hasOrgPermission("OWNER", "settings.manage")).toBe(true);
  });

  it.each(["MAINTAINER", "MANAGER", "SUPPORT", "EXPERT", "LEARNER"])(
    "%s does not gain billing settings from this change",
    (role) => {
      expect(hasOrgPermission(role as never, "billing.manage")).toBe(false);
    },
  );
});

describe("the UI now matches the server contract", () => {
  it("the server has always permitted exactly these two fields", () => {
    const src = read(ORG_PATCH);
    expect(src).toContain(
      'const BILLING_ADMIN_FIELDS = new Set(["billingEmail", "paymentTermsDays"]);',
    );
  });

  it("the Billing tab is gated on billing.manage, not settings.manage", () => {
    const src = read(TABS);
    const tab = src.slice(src.indexOf('value: "billing"'));
    const end = tab.indexOf("},");
    expect(tab.slice(0, end)).toContain('show: can("billing.manage")');
  });

  it("General stays on settings.manage", () => {
    const src = read(TABS);
    const general = src.slice(src.indexOf('value: "general"'));
    expect(general.slice(0, general.indexOf("},"))).toContain(
      'show: can("settings.manage")',
    );
  });

  it("the panel writes only the two fields the server allows", () => {
    const src = read(PANEL);
    const body = src.slice(src.indexOf("body: JSON.stringify("));
    const patch = body.slice(0, body.indexOf("});"));

    expect(patch).toContain("billingEmail");
    expect(patch).toContain("paymentTermsDays");
    // Anything else would 403 for BILLING_ADMIN and, worse, would mean the tab
    // is a route into settings the role was never granted.
    for (const forbidden of ["name:", "slug:", "isPublic", "gstin", "logo"]) {
      expect(patch).not.toContain(forbidden);
    }
  });

  it("the panel carries the optimistic lock, since General edits the same row", () => {
    expect(read(PANEL)).toContain("expectedVersion");
  });
});
