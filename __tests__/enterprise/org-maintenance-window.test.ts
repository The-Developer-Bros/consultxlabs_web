/**
 * @jest-environment node
 */

/**
 * Coverage for the per-org maintenance read helper
 * (`getActiveOrgMaintenanceWindow`).
 *
 * The schema column `MaintenanceWindow.organizationId` shipped in PR #655
 * as Tier 1 multi-tenant scaffolding; the read helper added here is the
 * first piece of runtime enforcement. The payout-batch script consults
 * this helper to skip a single tenant during a planned OFFLINE window
 * without affecting the rest of the batch.
 */

import { getActiveOrgMaintenanceWindow } from "@/lib/maintenance";
import prisma from "@/lib/prisma";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    maintenanceWindow: {
      findFirst: jest.fn(),
    },
  },
}));

const findFirst = prisma.maintenanceWindow.findFirst as jest.MockedFunction<
  typeof prisma.maintenanceWindow.findFirst
>;

describe("getActiveOrgMaintenanceWindow", () => {
  beforeEach(() => {
    findFirst.mockReset();
  });

  it("returns the active row when an org-specific OFFLINE window exists", async () => {
    const row = {
      phase: "OFFLINE" as const,
      reason: "Annual maintenance",
      estimatedEnd: new Date("2026-06-01T00:00:00.000Z"),
    };
    findFirst.mockResolvedValueOnce(row as never);

    const result = await getActiveOrgMaintenanceWindow("org-1");
    expect(result).toEqual(row);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        phase: { not: "OFF" },
      },
      orderBy: { createdAt: "desc" },
      select: { phase: true, reason: true, estimatedEnd: true },
    });
  });

  it("returns null when no org-specific window is active", async () => {
    findFirst.mockResolvedValueOnce(null);
    expect(await getActiveOrgMaintenanceWindow("org-2")).toBeNull();
  });

  it("scopes by organizationId so platform-wide (NULL) windows are excluded", async () => {
    // The query filter is the contract: `organizationId: "org-3"`
    // excludes rows where organizationId IS NULL (platform-wide).
    findFirst.mockResolvedValueOnce(null);
    await getActiveOrgMaintenanceWindow("org-3");
    const call = findFirst.mock.calls[0][0]!;
    expect((call.where as { organizationId: string }).organizationId).toBe(
      "org-3",
    );
  });

  it("treats DEGRADED as active (caller decides whether to block)", async () => {
    const row = {
      phase: "DEGRADED" as const,
      reason: "Partial outage",
      estimatedEnd: null,
    };
    findFirst.mockResolvedValueOnce(row as never);
    const result = await getActiveOrgMaintenanceWindow("org-4");
    expect(result?.phase).toBe("DEGRADED");
  });
});
