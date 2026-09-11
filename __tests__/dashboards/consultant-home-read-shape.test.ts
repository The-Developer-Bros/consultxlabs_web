/**
 * @jest-environment node
 */

/**
 * #1101 — pins the three consultant-Home read regressions that shipped inside a
 * perf change and produced quietly-wrong numbers rather than errors.
 *
 * These are asserted here rather than on the deploy preview because the dev
 * database cannot reproduce any of them: its busiest consultant has 10
 * appointments (the display cap is 20) and there are 4 pending requests
 * platform-wide (the old badge cap was 40). Clicking through the preview
 * renders green on both the buggy and the fixed code.
 */

import prisma from "@/lib/prisma";
import { getConsultantDashboard } from "@/lib/data/consultant-dashboard";
import {
  getNeedsYouSummary,
  pendingConsultationWhere,
  pendingSubscriptionWhere,
} from "@/lib/data/needs-you";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    slotOfAppointment: { findMany: jest.fn(), groupBy: jest.fn() },
    appointment: { findMany: jest.fn() },
    consultation: { findMany: jest.fn(), count: jest.fn() },
    subscription: { findMany: jest.fn(), count: jest.fn() },
    activityLog: { findMany: jest.fn() },
    consultantEarnings: { aggregate: jest.fn() },
    consultantReview: { aggregate: jest.fn() },
    trialSession: { groupBy: jest.fn() },
    membership: { findMany: jest.fn() },
  },
}));

const slotFindMany = prisma.slotOfAppointment.findMany as jest.Mock;
const apptFindMany = prisma.appointment.findMany as jest.Mock;
const consultationCount = prisma.consultation.count as jest.Mock;
const subscriptionCount = prisma.subscription.count as jest.Mock;

describe("consultant Home read shape (#1101)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    slotFindMany.mockResolvedValue([]);
    apptFindMany.mockResolvedValue([]);
    consultationCount.mockResolvedValue(0);
    subscriptionCount.mockResolvedValue(0);
    (prisma.slotOfAppointment.groupBy as jest.Mock).mockResolvedValue([]);
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.subscription.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.activityLog.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.trialSession.groupBy as jest.Mock).mockResolvedValue([]);
    (prisma.membership.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.consultantEarnings.aggregate as jest.Mock).mockResolvedValue({
      _sum: { consultantSharePaise: null, refundedShareAmount: null },
    });
    (prisma.consultantReview.aggregate as jest.Mock).mockResolvedValue({
      _avg: { rating: null },
      _count: { rating: 0 },
    });
  });

  it("ranks Home appointments by slot time anchored at today, not by createdAt", async () => {
    await getConsultantDashboard("cp-1").catch(() => undefined);

    expect(slotFindMany).toHaveBeenCalledTimes(1);
    const args = slotFindMany.mock.calls[0][0];

    // Ordering must key off the slot clock. `createdAt` truncated on the wrong
    // key: a consultant who booked next month a fortnight ago and then took a
    // burst of bookings for last week got 20 all-past rows.
    expect(args.orderBy).toEqual({ startsAt: "asc" });

    // ...and the window must be anchored at the PRESENT. Ordering ascending
    // from a lower bound in the past returns the OLDEST slots, which
    // reproduces the same empty Today/Upcoming widgets in a new disguise.
    expect(args.where.endsAt?.gte).toBeInstanceOf(Date);
    expect(args.where.startsAt).toBeUndefined();
    const anchor: Date = args.where.endsAt.gte;
    const now = new Date();
    expect(anchor.getTime()).toBeLessThanOrEqual(now.getTime());
    // Start-of-today, so a session already running today survives.
    expect(anchor.getHours()).toBe(0);
    expect(anchor.getMinutes()).toBe(0);
    expect(now.getTime() - anchor.getTime()).toBeLessThan(24 * 60 * 60 * 1000);

    // Tombstoned slots must not steer the ranking.
    expect(args.where.deletedAt).toBeNull();
  });

  it("counts pending requests with count(), uncapped, so the badge cannot disagree with NeedsYou", async () => {
    // More pending than any list cap: the old badge read `approvals.length`
    // off a capped list and contradicted NeedsYou on the same screen.
    consultationCount.mockResolvedValue(37);
    subscriptionCount.mockResolvedValue(18);

    const result = await getConsultantDashboard("cp-1");

    expect(result.pendingRequestsCount).toBe(55);

    // NeedsYou counts every pending request regardless of age, so these must
    // not inherit the list's 90-day bound or the two numbers drift apart.
    for (const call of [
      consultationCount.mock.calls[0][0],
      subscriptionCount.mock.calls[0][0],
    ]) {
      expect(call.where.status).toBe("PENDING");
      expect(call.where.requestedAt).toBeUndefined();
    }
  });

  it("counts the badge in PERSONAL scope, so it still equals NeedsYou once org-funded requests exist (#1345)", async () => {
    // Home is a B2C surface (ADR 19): an org-funded pending request belongs to
    // that org's dashboard. The badge used to count every PENDING row with no
    // org filter while NeedsYou and the mini list beside it counted personal
    // ones, so one screen showed three different totals for the same cohort.
    const personalConsultations = JSON.stringify(
      pendingConsultationWhere("cp-1", { kind: "personal" }),
    );
    const personalSubscriptions = JSON.stringify(
      pendingSubscriptionWhere("cp-1", { kind: "personal" }),
    );
    // Deliberately larger org cohorts: a badge that ignored scope would answer
    // 8 + 6 rather than 3 + 2, so the assertion cannot pass vacuously.
    consultationCount.mockImplementation(({ where }: { where: unknown }) =>
      Promise.resolve(JSON.stringify(where) === personalConsultations ? 3 : 5),
    );
    subscriptionCount.mockImplementation(({ where }: { where: unknown }) =>
      Promise.resolve(JSON.stringify(where) === personalSubscriptions ? 2 : 4),
    );
    (prisma.membership.findMany as jest.Mock).mockResolvedValue([
      { organizationId: "org-1", organization: { name: "Acme" } },
    ]);

    const [dashboard, needsYou] = await Promise.all([
      getConsultantDashboard("cp-1"),
      getNeedsYouSummary("user-1", "cp-1"),
    ]);

    const personalContext = needsYou.contexts.find(
      (context) => context.organizationId === null,
    );
    expect(personalContext?.pendingRequests).toBe(5);
    expect(dashboard.pendingRequestsCount).toBe(
      personalContext?.pendingRequests,
    );
    // The org work is still visible — on the org's own context, not the badge.
    expect(needsYou.total).toBe(14);
  });

  it("issues no display read at all when there is nothing upcoming (#1121)", async () => {
    // slotFindMany resolves [] from beforeEach, so homeAppointmentIds is empty —
    // a new consultant, an entirely past book, or one whose upcoming work was
    // cancelled. Prisma renders an empty `in` as `IN (NULL)`, and the display
    // read's include graph then costs nine follow-up SELECTs on `users` for a
    // result that is guaranteed to be empty.
    await getConsultantDashboard("cp-1");

    const displayReads = apptFindMany.mock.calls.filter((c) => c[0].include);
    expect(displayReads).toEqual([]);

    // The active-book read is id-independent and MUST still run — the guard is
    // per-query, not an early return, or Financial Summary goes blank.
    expect(apptFindMany.mock.calls.some((c) => c[0].select)).toBe(true);
  });

  it("still issues the display read when there IS something upcoming (#1121)", async () => {
    // Non-vacuity anchor for the assertion above: prove the guard is keyed on
    // emptiness and has not simply deleted the read.
    slotFindMany.mockResolvedValue([{ appointmentId: "appt-1" }]);

    await getConsultantDashboard("cp-1");

    const displayReads = apptFindMany.mock.calls.filter((c) => c[0].include);
    expect(displayReads).toHaveLength(1);
    expect(displayReads[0][0].where.id.in).toEqual(["appt-1"]);
  });

  it("derives active clients from a dedicated query, not the truncated display list", async () => {
    // Display list is capped; the active book is not. Deriving counts from the
    // capped array under-reported Financial Summary for any real consultant.
    const activeBook = Array.from({ length: 64 }, (_, i) => ({
      consultation: { requestedBy: { id: `consultee-${i}` } },
      subscription: null,
      class: null,
    }));

    apptFindMany.mockImplementation((args: { select?: unknown }) =>
      // The active-book read is the `select` one; the display read uses `include`.
      Promise.resolve(args.select ? activeBook : []),
    );

    const result = await getConsultantDashboard("cp-1");

    expect(result.financialSummary.activeClients).toBe(64);

    const activeBookCall = apptFindMany.mock.calls.find((c) => c[0].select);
    expect(activeBookCall).toBeDefined();
    // No cap on the counting read.
    expect(activeBookCall![0].take).toBeUndefined();
    // Soft-deleted slots must not keep an appointment counted as active.
    for (const clause of activeBookCall![0].where.AND) {
      expect(clause.slotsOfAppointment.some.deletedAt).toBeNull();
    }
  });
});
