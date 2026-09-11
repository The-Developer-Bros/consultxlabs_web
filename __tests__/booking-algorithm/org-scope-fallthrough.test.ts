/**
 * @jest-environment node
 */

/**
 * Defect 13 / B2B gap 9 — `orgMember` must pin the org it names.
 *
 * `resolveOrgScope` downgrades an active member below `operations.read` from
 * `org` to `orgMember`: same org, but only their own rows. Five call sites
 * projected the resolved scope by hand and tested `kind === "org"` alone, so
 * that downgrade fell through to the "no filter" arm — a LEARNER who picked
 * ONE org got every org they belong to plus their personal rows, which is the
 * exact cross-tenant blur the picker exists to prevent.
 *
 * Every projection now routes through `scopeOrgId` / `scopeToWhereOrgId`,
 * which are the only code that knows which kinds pin. One case per site here.
 */

import fs from "fs";
import path from "path";
import {
  resolveOrgScope,
  scopeOrgId,
  scopeToWhereOrgId,
} from "../../lib/api/scope/parse";
import { buildOrgChannelFilter } from "../../components/chat/utils/channelUtils";

const ORG = "org-acme";
const OTHER_ORG = "org-zeta";
const USER = "user-1";

function learnerAt(orgId: string) {
  return [
    { organizationId: orgId, status: "ACTIVE" as const, role: "LEARNER" },
    { organizationId: OTHER_ORG, status: "ACTIVE" as const, role: "LEARNER" },
  ];
}

/** The downgrade every case below depends on. */
function resolveAsLearner() {
  const resolution = resolveOrgScope({
    raw: ORG,
    memberships: learnerAt(ORG) as never,
    userRole: "CONSULTEE",
    userId: USER,
  });
  if (!resolution.ok) throw new Error("expected the scope to resolve");
  return resolution.scope;
}

describe("resolveOrgScope downgrades a plain member to orgMember", () => {
  it("a LEARNER naming their own org gets orgMember, not org and not a 403", () => {
    expect(resolveAsLearner()).toEqual({
      kind: "orgMember",
      orgId: ORG,
      userId: USER,
    });
  });

  it("the projectors treat orgMember as a pin", () => {
    const scope = resolveAsLearner();
    expect(scopeOrgId(scope)).toBe(ORG);
    expect(scopeToWhereOrgId(scope)).toEqual({ organizationId: ORG });
  });
});

describe("fall-through 1 — the chat sidebar's Stream filter", () => {
  it("pins an orgMember to the org's channels", () => {
    expect(buildOrgChannelFilter(resolveAsLearner())).toEqual({
      organization_id: { $eq: ORG },
    });
  });

  it("still handles the other three kinds", () => {
    expect(buildOrgChannelFilter({ kind: "personal" })).toEqual({
      organization_id: { $exists: false },
    });
    expect(buildOrgChannelFilter({ kind: "org", orgId: ORG })).toEqual({
      organization_id: { $eq: ORG },
    });
    // `all` is the only genuinely unfiltered kind — admin/staff only.
    expect(buildOrgChannelFilter({ kind: "all" })).toEqual({});
  });
});

describe("fall-through 2 — the consultee events read", () => {
  it("pins every booking model to the org for an orgMember", async () => {
    jest.resetModules();
    // Typed as jest.Mock so `.mock.calls[n][0]` is readable — the inferred
    // empty-tuple return would make every argument index a type error.
    const findMany: jest.Mock = jest.fn(async () => []);
    jest.doMock("../../lib/prisma", () => ({
      __esModule: true,
      default: {
        consulteeProfile: {
          findUnique: jest.fn(async () => ({ userId: USER })),
        },
        consultation: { findMany },
        subscription: { findMany },
        webinar: { findMany },
        class: { findMany },
        trialSession: { findMany },
      },
    }));
    const { readConsulteeEvents } =
      await import("../../lib/data/consultee-events-read");

    await readConsulteeEvents("consultee-1", resolveAsLearner());

    // Five reads, every one carrying the org pin somewhere in its where.
    expect(findMany).toHaveBeenCalledTimes(5);
    for (const call of findMany.mock.calls) {
      expect(JSON.stringify((call as unknown[])[0])).toContain(ORG);
    }
  });
});

describe("fall-through 3 — the trial list", () => {
  it("pins the where clause to the org for an orgMember", async () => {
    jest.resetModules();
    const trialFindMany: jest.Mock = jest.fn(async () => []);
    jest.doMock("../../lib/prisma", () => ({
      __esModule: true,
      default: {
        membership: { findMany: jest.fn(async () => learnerAt(ORG)) },
        trialSession: {
          findMany: trialFindMany,
          count: jest.fn(async () => 0),
        },
      },
    }));
    jest.doMock("../../lib/auth-server", () => ({
      __esModule: true,
      getSession: jest.fn(async () => ({
        user: {
          id: USER,
          role: "CONSULTEE",
          consulteeProfileId: "consultee-1",
        },
      })),
    }));
    jest.doMock("../../lib/rate-limit", () => ({
      __esModule: true,
      trialRequestLimiter: {},
      applyRateLimit: jest.fn(async () => null),
    }));
    const { GET } = await import("../../app/api/trials/route");

    const res = await GET(
      new Request(`http://localhost/api/trials?orgScope=${ORG}`) as never,
    );

    expect(res.status).toBe(200);
    const where = trialFindMany.mock.calls[0][0].where;
    expect(where.organizationId).toBe(ORG);
  });
});

describe("fall-through 4 — the consultation request list", () => {
  it("pins the appointment to the org for an orgMember", async () => {
    jest.resetModules();
    const consultationFindMany: jest.Mock = jest.fn(async () => []);
    jest.doMock("../../lib/prisma", () => ({
      __esModule: true,
      default: {
        membership: { findMany: jest.fn(async () => learnerAt(ORG)) },
        consultation: {
          findMany: consultationFindMany,
          count: jest.fn(async () => 0),
        },
      },
    }));
    jest.doMock("../../lib/auth-helpers", () => ({
      __esModule: true,
      requireApiAuth: jest.fn(async () => ({
        session: {
          user: {
            id: USER,
            role: "CONSULTEE",
            consulteeProfileId: "consultee-1",
          },
        },
      })),
      isPrivileged: () => false,
      forbiddenResponse: (m: string) =>
        new Response(JSON.stringify({ error: m }), { status: 403 }),
    }));
    const { GET } = await import("../../app/api/bookings/consultations/route");

    const res = await GET(
      new Request(
        `http://localhost/api/bookings/consultations?orgScope=${ORG}`,
      ) as never,
    );

    expect(res.status).toBe(200);
    const where = consultationFindMany.mock.calls[0][0].where;
    expect(where.appointment).toEqual({ organizationId: ORG });
  });
});

describe("fall-through 5 — the consultant appointments list", () => {
  it("hands the resolved Scope down whole rather than a hand-rolled filter", async () => {
    jest.resetModules();
    const getConsultantAppointments: jest.Mock = jest.fn(async () => []);
    jest.doMock("../../lib/prisma", () => ({
      __esModule: true,
      default: {
        membership: { findMany: jest.fn(async () => learnerAt(ORG)) },
      },
    }));
    jest.doMock("../../lib/auth-helpers", () => ({
      __esModule: true,
      requireApiAuth: jest.fn(async () => ({
        session: {
          user: {
            id: USER,
            role: "CONSULTEE",
            consulteeProfileId: "consultee-1",
          },
        },
      })),
      isPrivileged: () => false,
    }));
    jest.doMock("../../lib/data/consultant-appointments", () => ({
      __esModule: true,
      getConsultantAppointments,
    }));
    const { GET } = await import("../../app/api/slots/appointments/route");

    const res = await GET(
      new Request(
        `http://localhost/api/slots/appointments?consulteeProfileId=consultee-1&orgScope=${ORG}`,
      ) as never,
    );

    expect(res.status).toBe(200);
    const args = getConsultantAppointments.mock.calls[0][0];
    expect(args.scope).toEqual({
      kind: "orgMember",
      orgId: ORG,
      userId: USER,
    });
    // And the read itself projects that scope to the pin.
    expect(scopeToWhereOrgId(args.scope)).toEqual({ organizationId: ORG });
  });
});

/**
 * The other half of defect 13: surfaces that legitimately span every tenant
 * used to get there by omission. The operator trees now name it.
 */
describe("the platform-wide surfaces declare `all` deliberately", () => {
  const read = (rel: string) =>
    fs.readFileSync(path.join(process.cwd(), rel), "utf8");

  it("both operator appointment pages pass an explicit scope", () => {
    for (const rel of [
      "app/dashboard/admin/appointments/page.tsx",
      "app/dashboard/staff/[staffId]/(features)/appointments/page.tsx",
    ]) {
      expect(read(rel)).toContain('scope={{ kind: "all" }}');
    }
  });

  it("getStaffAppointments takes a required Scope, so omission is a type error", () => {
    const src = read("lib/data/staff-appointments.ts");
    expect(src).toContain("scope: Scope;");
    expect(src).not.toContain("orgId?: string | null;");
    // The default-empty params object is gone with it — there is no longer a
    // way to call this without stating a scope.
    expect(src).not.toContain("params: StaffAppointmentsParams = {}");
  });
});
