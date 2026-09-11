import { resolvePersonalDashboardHref } from "@/lib/labels/personal-dashboard";

describe("resolvePersonalDashboardHref", () => {
  it("returns the org-workspace surface when orgWorkspaceProfileId is set", () => {
    expect(
      resolvePersonalDashboardHref({
        orgWorkspaceProfileId: "ow-1",
        consultantProfileId: "cp-1",
        consulteeProfileId: "ce-1",
      }),
    ).toBe("/dashboard/org-workspace/ow-1/home");
  });

  it("falls back to consultant when no orgWorkspace exists", () => {
    expect(
      resolvePersonalDashboardHref({
        orgWorkspaceProfileId: null,
        consultantProfileId: "cp-9",
        consulteeProfileId: "ce-1",
      }),
    ).toBe("/dashboard/consultant/cp-9/home");
  });

  it("falls back to consultee when only consulteeProfileId is set", () => {
    expect(
      resolvePersonalDashboardHref({
        orgWorkspaceProfileId: null,
        consultantProfileId: null,
        consulteeProfileId: "ce-7",
      }),
    ).toBe("/dashboard/consultee/ce-7/home");
  });

  it("returns null when no profile ids are set", () => {
    expect(
      resolvePersonalDashboardHref({
        orgWorkspaceProfileId: null,
        consultantProfileId: null,
        consulteeProfileId: null,
      }),
    ).toBeNull();
  });

  it("treats undefined and null the same way", () => {
    expect(
      resolvePersonalDashboardHref({
        orgWorkspaceProfileId: undefined,
        consultantProfileId: undefined,
        consulteeProfileId: "ce-only",
      }),
    ).toBe("/dashboard/consultee/ce-only/home");
  });
});
