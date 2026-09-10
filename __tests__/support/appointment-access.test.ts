/**
 * @jest-environment node
 */

/**
 * #support-hub — the ONE appointment authz gate (lib/api/appointment-access).
 *
 * Pinned behaviors:
 * - coded failures (UNAUTHORIZED / NOT_FOUND / FORBIDDEN) before any grant;
 * - the org-party grant is OPT-IN: with `orgParty` unset, an org operator who
 *   is neither participant nor staff gets FORBIDDEN — the grant must never
 *   silently widen read access (ADR 20);
 * - with `orgParty: true`, only an ACTIVE membership holding `operations.read`
 *   earns the operator their own conversation, and success carries the org id
 *   + the already-loaded detail.
 */

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(),
}));

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  isPrivileged: jest.fn(),
}));

jest.mock("../../lib/auth/org-permissions", () => ({
  __esModule: true,
  hasOrgPermission: jest.fn(),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    membership: { findFirst: jest.fn() },
  },
}));

jest.mock("../../lib/data/appointment-detail", () => ({
  __esModule: true,
  readAppointmentDetail: jest.fn(),
  canAccessAppointment: jest.fn(),
}));

import { getSession } from "../../lib/auth-server";
import { isPrivileged } from "../../lib/auth-helpers";
import { hasOrgPermission } from "../../lib/auth/org-permissions";
import prisma from "../../lib/prisma";
import {
  readAppointmentDetail,
  canAccessAppointment,
} from "../../lib/data/appointment-detail";
import { authorizeAppointment } from "../../lib/api/appointment-access";
import type { TAppointmentDetail } from "../../lib/data/appointment-detail";

const mockedGetSession = getSession as jest.Mock;
const mockedIsPrivileged = isPrivileged as jest.Mock;
const mockedHasOrgPermission = hasOrgPermission as jest.Mock;
const mockedMembershipFind = prisma.membership.findFirst as jest.Mock;
const mockedReadDetail = readAppointmentDetail as jest.Mock;
const mockedCanAccess = canAccessAppointment as jest.Mock;

const DETAIL = {
  appointment: { id: "demo0813-appt-ba", organizationId: "org-1" },
} as unknown as TAppointmentDetail;

beforeEach(() => {
  mockedReadDetail.mockResolvedValue(DETAIL);
  mockedCanAccess.mockReturnValue(false);
  mockedIsPrivileged.mockReturnValue(false);
  mockedHasOrgPermission.mockReturnValue(false);
  mockedMembershipFind.mockResolvedValue(null);
});

describe("authorizeAppointment — coded failures", () => {
  it("401 without a session", async () => {
    mockedGetSession.mockResolvedValue(null);
    expect(await authorizeAppointment("a1")).toEqual({
      code: "UNAUTHORIZED",
      status: 401,
    });
  });

  it("404 when the appointment does not exist", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "u1" } });
    mockedReadDetail.mockResolvedValue(null);
    expect(await authorizeAppointment("gone")).toEqual({
      code: "NOT_FOUND",
      status: 404,
    });
  });

  it("403 for a bystander with no privilege and no org grant", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "u1" } });
    expect(await authorizeAppointment("a1")).toEqual({
      code: "FORBIDDEN",
      status: 403,
    });
  });
});

describe("authorizeAppointment — legitimate access", () => {
  it("a participant passes without consulting memberships", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "u1" } });
    mockedCanAccess.mockReturnValue(true);
    const auth = await authorizeAppointment("a1");
    expect(auth).toMatchObject({ userId: "u1", isOrgParty: false });
    expect(mockedMembershipFind).not.toHaveBeenCalled();
  });

  it("platform staff passes without consulting memberships", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "staff1", role: "ADMIN" } });
    mockedIsPrivileged.mockReturnValue(true);
    const auth = await authorizeAppointment("a1");
    expect(auth).toMatchObject({ userId: "staff1", isOrgParty: false });
    expect(mockedMembershipFind).not.toHaveBeenCalled();
  });
});

describe("authorizeAppointment — the org-party grant is opt-in", () => {
  const operatorSession = { user: { id: "op1" } };
  const activeMembership = { role: "MANAGER" };

  it("without the flag, an org operator is still FORBIDDEN (detail/feedback surfaces)", async () => {
    mockedGetSession.mockResolvedValue(operatorSession);
    mockedMembershipFind.mockResolvedValue(activeMembership);
    mockedHasOrgPermission.mockReturnValue(true);
    const auth = await authorizeAppointment("a1");
    expect(auth).toEqual({ code: "FORBIDDEN", status: 403 });
    // The membership was never even consulted.
    expect(mockedMembershipFind).not.toHaveBeenCalled();
  });

  it("with orgParty, an ACTIVE member holding operations.read earns their own thread — metadata only, NO detail", async () => {
    mockedGetSession.mockResolvedValue(operatorSession);
    mockedMembershipFind.mockResolvedValue(activeMembership);
    mockedHasOrgPermission.mockReturnValue(true);
    const auth = await authorizeAppointment("a1", true);
    expect(auth).toMatchObject({
      userId: "op1",
      isOrgParty: true,
      organizationId: "org-1",
    });
    // ADR 20 hardening: the org operator's grant must not carry the session
    // content graph (recordings, payment, participants).
    expect((auth as { detail?: unknown })).not.toHaveProperty("detail");
    expect(mockedMembershipFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "op1",
          organizationId: "org-1",
          status: "ACTIVE",
        }),
      }),
    );
  });

  it("with orgParty, a member WITHOUT operations.read stays FORBIDDEN", async () => {
    mockedGetSession.mockResolvedValue(operatorSession);
    mockedMembershipFind.mockResolvedValue({ role: "LEARNER" });
    mockedHasOrgPermission.mockReturnValue(false);
    expect(await authorizeAppointment("a1", true)).toEqual({
      code: "FORBIDDEN",
      status: 403,
    });
  });

  it("with orgParty, no ACTIVE membership stays FORBIDDEN", async () => {
    mockedGetSession.mockResolvedValue(operatorSession);
    mockedMembershipFind.mockResolvedValue(null);
    expect(await authorizeAppointment("a1", true)).toEqual({
      code: "FORBIDDEN",
      status: 403,
    });
  });
});
