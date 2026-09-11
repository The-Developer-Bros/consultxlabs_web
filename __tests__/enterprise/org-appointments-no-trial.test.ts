/**
 * @jest-environment node
 */

/**
 * Defect 13 tail — the org appointments surface no longer offers TRIAL.
 *
 * A trial is a B2C acquisition session: trial checkout never stamps
 * `Appointment.organizationId`, so the org scope's where clause can only ever
 * match zero trial rows (`lib/api/scope/list-appointments.ts` says as much and
 * excludes them from the member scope too). The filter was therefore a control
 * that always answered "no trials", which reads as "this org has none yet"
 * rather than the truth — an org does not have trials at all. The row shape
 * carried `trialSession` columns for the same never-populated case.
 */

import fs from "fs";
import path from "path";

const mockRequireOrgAccess = jest.fn();
const mockGetOrgAppointments = jest.fn();

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireOrgAccess: (...a: unknown[]) => mockRequireOrgAccess(...a),
}));

jest.mock("../../lib/data/org-appointments", () => ({
  __esModule: true,
  getOrgAppointments: (...a: unknown[]) => mockGetOrgAppointments(...a),
}));

import { GET } from "../../app/api/organizations/[orgId]/appointments/route";

const ORG = "org-acme";

function get(query: string) {
  return GET(
    new Request(
      `http://localhost/api/organizations/${ORG}/appointments${query}`,
    ) as never,
    { params: Promise.resolve({ orgId: ORG }) },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireOrgAccess.mockResolvedValue({
    session: { user: { id: "user-1" } },
    member: { id: "member-1", role: "MANAGER" },
    org: { id: ORG },
  });
  mockGetOrgAppointments.mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    perPage: 20,
  });
});

describe("GET /api/organizations/[orgId]/appointments", () => {
  it("rejects appointmentType=TRIAL instead of answering an empty page", async () => {
    const res = await get("?appointmentType=TRIAL");

    expect(res.status).toBe(400);
    expect(mockGetOrgAppointments).not.toHaveBeenCalled();
  });

  it("still accepts the four types an org can actually hold", async () => {
    for (const type of ["CONSULTATION", "SUBSCRIPTION", "WEBINAR", "CLASS"]) {
      const res = await get(`?appointmentType=${type}`);
      expect(res.status).toBe(200);
      expect(mockGetOrgAppointments).toHaveBeenLastCalledWith(
        ORG,
        expect.objectContaining({ appointmentType: type }),
      );
    }
  });
});

describe("the org appointments table (source contract)", () => {
  const src = fs.readFileSync(
    path.join(
      process.cwd(),
      "app/dashboard/organization/[orgId]/appointments/AppointmentsPageClient.tsx",
    ),
    "utf8",
  );

  it("has no trialSession column left to render", () => {
    expect(src).not.toContain("trialSession");
  });

  it("does not offer TRIAL in the type filter", () => {
    const list = src.slice(
      src.indexOf("const APPOINTMENT_TYPES"),
      src.indexOf("] as const", src.indexOf("const APPOINTMENT_TYPES")),
    );
    expect(list).toContain("CONSULTATION");
    expect(list).not.toContain('"TRIAL"');
  });
});
