/**
 * The "needs you now" queue is the one part of the home-page rework with real
 * logic in it, so it lives in a pure module and is pinned here. The bar it
 * encodes: an item appears only when the user is the one blocking something
 * and there is a single obvious next click.
 */

import {
  deriveConsultantActionItems,
  deriveConsulteeActionItems,
  imminentSessionItem,
} from "@/lib/dashboard/action-items";

const CONSULTANT_BASE = "/dashboard/consultant/c1";
const CONSULTEE_BASE = "/dashboard/consultee/e1";

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000);

describe("imminentSessionItem", () => {
  it("surfaces nothing when the next session is beyond the hour", () => {
    expect(
      imminentSessionItem(
        [{ startsAt: inMinutes(90), title: "Later" }],
        "/x",
      ),
    ).toBeNull();
  });

  it("warns about a session inside the hour", () => {
    const item = imminentSessionItem(
      [{ startsAt: inMinutes(40), title: "Career review" }],
      "/x",
    );
    expect(item?.severity).toBe("warning");
    expect(item?.title).toMatch(/Session in 4[01] min/);
    expect(item?.ctaLabel).toBe("View");
  });

  it("escalates to critical once inside the 10-minute join window", () => {
    const item = imminentSessionItem(
      [{ startsAt: inMinutes(5), title: "Career review" }],
      "/x",
    );
    expect(item?.severity).toBe("critical");
    // The label stays "View" at both severities: ctaHref is the appointments
    // list, not the meeting, so "Join" promised a call it could not deliver.
    // Urgency is carried by `severity` and the title instead.
    expect(item?.ctaLabel).toBe("View");
    expect(item?.title).toBe("Starting in 5 min");
  });

  it("uses the exact boundary, not rounded minutes, to decide the window", () => {
    // 10m29s rounds to 10 and used to read as inside the window.
    const justOutside = imminentSessionItem(
      [{ startsAt: new Date(Date.now() + 10 * 60_000 + 29_000), title: "x" }],
      "/x",
    );
    expect(justOutside?.severity).toBe("warning");

    const justInside = imminentSessionItem(
      [{ startsAt: new Date(Date.now() + 9 * 60_000 + 30_000), title: "x" }],
      "/x",
    );
    expect(justInside?.severity).toBe("critical");
  });

  it("keeps a session that is under way, and drops one that has ended", () => {
    expect(
      imminentSessionItem(
        [{ startsAt: inMinutes(-5), endsAt: inMinutes(55), title: "Now" }],
        "/x",
      ),
    ).not.toBeNull();
    expect(
      imminentSessionItem(
        [{ startsAt: inMinutes(-90), endsAt: inMinutes(-30), title: "Over" }],
        "/x",
      ),
    ).toBeNull();
  });

  // #1061 — the join window opens before the start and stays open for the
  // duration, so the single `joinable` flag announced a session 25 minutes in
  // as "starting now". These three are the states a reader has to tell apart.
  describe("distinguishes starting from already running", () => {
    const NOW = new Date("2026-08-01T12:00:00.000Z");
    const at = (minutesFromNow: number) =>
      new Date(NOW.getTime() + minutesFromNow * 60_000);

    it("reads as in progress 25 minutes into an hour-long session", () => {
      const item = imminentSessionItem(
        [{ startsAt: at(-25), endsAt: at(35), title: "Career review" }],
        "/x",
        NOW,
      );
      expect(item?.title).toBe("Session in progress");
      expect(item?.severity).toBe("critical");
    });

    it("reads as starting 5 minutes out", () => {
      const item = imminentSessionItem(
        [{ startsAt: at(5), endsAt: at(65), title: "Career review" }],
        "/x",
        NOW,
      );
      expect(item?.title).toBe("Starting in 5 min");
      expect(item?.severity).toBe("critical");
    });

    it("reads as a countdown an hour out", () => {
      const item = imminentSessionItem(
        [{ startsAt: at(60), endsAt: at(120), title: "Career review" }],
        "/x",
        NOW,
      );
      expect(item?.title).toBe("Session in 60 min");
      expect(item?.severity).toBe("warning");
    });

    it("treats the consecutive rows of one booking as a single session", () => {
      // Two 30-minute rows of the same 12:00–13:00 booking. The second row
      // must not announce itself as a separate session starting in 30 min.
      const item = imminentSessionItem(
        [
          {
            id: "s1",
            appointmentId: "a1",
            startsAt: at(0),
            endsAt: at(30),
            title: "Career review",
          },
          {
            id: "s2",
            appointmentId: "a1",
            startsAt: at(30),
            endsAt: at(60),
            title: "Career review",
          },
        ],
        "/x",
        NOW,
      );
      expect(item?.title).toBe("Session in progress");
    });
  });

  it("surfaces only the soonest — a list belongs on the Appointments tab", () => {
    const item = imminentSessionItem(
      [
        { startsAt: inMinutes(50), title: "Second" },
        { startsAt: inMinutes(20), title: "First" },
      ],
      "/x",
    );
    expect(item?.body).toBe("First");
  });
});

describe("deriveConsultantActionItems", () => {
  it("is empty when nothing is blocked on the consultant", () => {
    expect(
      deriveConsultantActionItems({
        pendingApprovals: 0,
        upcomingSessions: [{ startsAt: inMinutes(600), title: "Far off" }],
        basePath: CONSULTANT_BASE,
      }),
    ).toEqual([]);
  });

  it("raises slot allocation and links to Requests", () => {
    const [item] = deriveConsultantActionItems({
      pendingApprovals: 3,
      upcomingSessions: [],
      basePath: CONSULTANT_BASE,
    });
    expect(item.title).toBe("3 requests need slot allocation");
    expect(item.ctaHref).toBe(`${CONSULTANT_BASE}/requests`);
  });

  it("uses singular wording for one item", () => {
    const [item] = deriveConsultantActionItems({
      pendingApprovals: 1,
      upcomingSessions: [],
      basePath: CONSULTANT_BASE,
    });
    expect(item.title).toBe("1 request needs slot allocation");
  });

  it("orders the imminent session ahead of the backlog", () => {
    const items = deriveConsultantActionItems({
      pendingApprovals: 2,
      documentsAwaitingReview: 1,
      upcomingSessions: [{ startsAt: inMinutes(5), title: "Now" }],
      basePath: CONSULTANT_BASE,
    });
    expect(items.map((i) => i.key)).toEqual([
      "session-imminent",
      "pending-requests",
      "documents-review",
    ]);
  });
});

describe("deriveConsulteeActionItems", () => {
  it("treats an outstanding payment as critical — the booking isn't confirmed", () => {
    const [item] = deriveConsulteeActionItems({
      pendingPaymentCount: 2,
      pendingPaymentTotalPaise: 124_000,
      upcomingSessions: [],
      basePath: CONSULTEE_BASE,
    });
    expect(item.severity).toBe("critical");
    expect(item.title).toContain("₹1,240");
    expect(item.ctaHref).toBe(`${CONSULTEE_BASE}/payments`);
  });

  it("omits the amount when it isn't known", () => {
    const [item] = deriveConsulteeActionItems({
      pendingPaymentCount: 1,
      upcomingSessions: [],
      basePath: CONSULTEE_BASE,
    });
    expect(item.title).toBe("1 payment is outstanding");
  });

  it("is empty with nothing owed and nothing imminent", () => {
    expect(
      deriveConsulteeActionItems({
        pendingPaymentCount: 0,
        upcomingSessions: [],
        basePath: CONSULTEE_BASE,
      }),
    ).toEqual([]);
  });
});
