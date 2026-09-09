/**
 * @jest-environment node
 */

/**
 * Sole-owner archive/restore for the four plan families (#1494). Table-driven
 * so the four PATCH routes cannot silently drift from each other: the owner
 * check, the idempotent `archivedAt` toggle, and the 403 on a mismatched
 * userId all have to hold for every family or the test for that family fails.
 */

// jest.mock() specifiers are resolved by Jest's own resolver before SWC
// rewrites "@/" imports, which is not aliased here (see the relative-path
// pattern in __tests__/enterprise/consumer-org-routing.test.ts) — so these
// two use relative paths while the route/type imports below use "@/".
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultationPlan: { findUnique: jest.fn(), update: jest.fn() },
    subscriptionPlan: { findUnique: jest.fn(), update: jest.fn() },
    webinarPlan: { findUnique: jest.fn(), update: jest.fn() },
    classPlan: { findUnique: jest.fn(), update: jest.fn() },
  },
}));

jest.mock("../../lib/auth-server", () => ({
  getSession: jest.fn(),
}));

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
}));

// schemas/plans pulls `bad-words` (ESM-only) in through utils/contentValidation
// at import time (see __tests__/booking-algorithm/class-crud-conflict-mapping.test.ts);
// none of these plan validations matter here, so boundary-mock the module
// rather than transform node_modules.
// webinar/class GET pulls in lib/data/plan-details, which wraps its export
// in React's `cache()` at module load time (RSC-only, absent in the test
// React build) — boundary-mock it the same way
// __tests__/plans/plan-detail-pages-gated.test.ts does. Only GET (untouched
// here) uses it.
jest.mock("../../lib/data/plan-details", () => ({
  fetchWebinarPlanDetail: jest.fn(),
  fetchClassPlanDetail: jest.fn(),
}));

jest.mock("../../utils/contentValidation", () => ({
  __esModule: true,
  hasDuplicates: () => false,
  containsGibberish: () => false,
  containsProfanity: () => false,
  isProfanityFree: () => true,
  isMeaningfulText: () => true,
  validateSensibleContent: () => true,
  cleanProfanity: (text: string) => text,
}));

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { PATCH as consultationPatch } from "@/app/api/plans/consultations/[consultationPlanId]/route";
import { PATCH as subscriptionPatch } from "@/app/api/plans/subscriptions/[subscriptionPlanId]/route";
import { PATCH as webinarPatch } from "@/app/api/plans/webinars/[webinarPlanId]/route";
import { PATCH as classPatch } from "@/app/api/plans/classes/[classPlanId]/route";

const mockedGetSession = getSession as jest.Mock;

type Delegate = { findUnique: jest.Mock; update: jest.Mock };

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost/api/plans/x", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

const OWNER_USER_ID = "user-owner";
const OTHER_USER_ID = "user-other";

const families = [
  {
    name: "consultation",
    patch: consultationPatch,
    delegate: prisma.consultationPlan as unknown as Delegate,
    paramKey: "consultationPlanId",
  },
  {
    name: "subscription",
    patch: subscriptionPatch,
    delegate: prisma.subscriptionPlan as unknown as Delegate,
    paramKey: "subscriptionPlanId",
  },
  {
    name: "webinar",
    patch: webinarPatch,
    delegate: prisma.webinarPlan as unknown as Delegate,
    paramKey: "webinarPlanId",
  },
  {
    name: "class",
    patch: classPatch,
    delegate: prisma.classPlan as unknown as Delegate,
    paramKey: "classPlanId",
  },
] as const;

describe.each(families)(
  "$name plan PATCH archive/restore",
  ({ patch, delegate, paramKey }) => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockedGetSession.mockResolvedValue({ user: { id: OWNER_USER_ID } });
    });

    function callRoute(body: unknown, planId = "plan-1") {
      return patch(makeRequest(body), {
        params: Promise.resolve({ [paramKey]: planId }) as never,
      });
    }

    it("owner archives: sets archivedAt", async () => {
      delegate.findUnique.mockResolvedValue({
        id: "plan-1",
        archivedAt: null,
        consultantProfile: { userId: OWNER_USER_ID },
      });
      delegate.update.mockImplementation(({ data }) =>
        Promise.resolve({ id: "plan-1", archivedAt: data.archivedAt }),
      );

      const res = await callRoute({ archived: true });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(delegate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "plan-1" },
          data: { archivedAt: expect.any(Date) },
        }),
      );
      expect(json.data.archivedAt).toBeTruthy();
    });

    it("archiving an already-archived plan keeps the original timestamp", async () => {
      const originalTimestamp = new Date("2026-01-01T00:00:00.000Z");
      delegate.findUnique.mockResolvedValue({
        id: "plan-1",
        archivedAt: originalTimestamp,
        consultantProfile: { userId: OWNER_USER_ID },
      });
      delegate.update.mockImplementation(({ data }) =>
        Promise.resolve({ id: "plan-1", archivedAt: data.archivedAt }),
      );

      await callRoute({ archived: true });

      expect(delegate.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { archivedAt: originalTimestamp } }),
      );
    });

    it("non-owner gets 403 and no write happens", async () => {
      delegate.findUnique.mockResolvedValue({
        id: "plan-1",
        archivedAt: null,
        consultantProfile: { userId: OTHER_USER_ID },
      });

      const res = await callRoute({ archived: true });

      expect(res.status).toBe(403);
      expect(delegate.update).not.toHaveBeenCalled();
    });

    it("an org-governed plan is 403 PLAN_ORG_GOVERNED with no write", async () => {
      delegate.findUnique.mockResolvedValue({
        id: "plan-1",
        archivedAt: null,
        organizationId: "org-1",
        consultantProfile: { userId: OWNER_USER_ID },
      });

      const res = await callRoute({ archived: true });
      const json = await res.json();

      expect(res.status).toBe(403);
      expect(json.code).toBe("PLAN_ORG_GOVERNED");
      expect(delegate.update).not.toHaveBeenCalled();
    });

    it("restore clears archivedAt", async () => {
      delegate.findUnique.mockResolvedValue({
        id: "plan-1",
        archivedAt: new Date(),
        consultantProfile: { userId: OWNER_USER_ID },
      });
      delegate.update.mockImplementation(({ data }) =>
        Promise.resolve({ id: "plan-1", archivedAt: data.archivedAt }),
      );

      const res = await callRoute({ archived: false });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(delegate.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { archivedAt: null } }),
      );
      expect(json.data.archivedAt).toBeNull();
    });

    it("rejects an invalid body", async () => {
      delegate.findUnique.mockResolvedValue({
        id: "plan-1",
        archivedAt: null,
        consultantProfile: { userId: OWNER_USER_ID },
      });

      const res = await callRoute({ archived: "yes" });

      expect(res.status).toBe(400);
      expect(delegate.update).not.toHaveBeenCalled();
    });

    it("a malformed JSON body is a 400, not a 5xx", async () => {
      const res = await patch(
        new NextRequest("http://localhost/api/plans/x", {
          method: "PATCH",
          body: "{not json",
        }),
        { params: Promise.resolve({ [paramKey]: "plan-1" }) as never },
      );

      expect(res.status).toBe(400);
      expect(delegate.findUnique).not.toHaveBeenCalled();
      expect(delegate.update).not.toHaveBeenCalled();
    });

    it("requires authentication", async () => {
      mockedGetSession.mockResolvedValueOnce(null);

      const res = await callRoute({ archived: true });

      expect(res.status).toBe(401);
      expect(delegate.findUnique).not.toHaveBeenCalled();
    });
  },
);
