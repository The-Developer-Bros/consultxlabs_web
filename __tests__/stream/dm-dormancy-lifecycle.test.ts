/**
 * @jest-environment node
 */

/**
 * #1280 PR F — direct-message channels, keyed on PAIR dormancy.
 *
 * Two things make this different from the event stage it shares a job with, and
 * both are load-bearing.
 *
 * An event ends on a schedule and never resumes, so a frozen event channel stays
 * frozen correctly. A pair resumes — they book again. Without a reversal, the
 * first thing a returning consultee finds is a channel they cannot post in, and
 * because Stream grants `use-frozen-channel` to no role there is no error text
 * explaining why. Freezing without unfreezing would be a worse bug than never
 * freezing at all.
 *
 * And the ledger is a property of the PAIR, not of a booking. DM ids are keyed
 * on the pair and `DM_ELIGIBLE_STATUSES` deliberately includes `COMPLETED`, so
 * the read takes MAX(chatFrozenAt) across every booking the pair shares and the
 * write has to cover all of them. Stamping one row would let a second booking
 * report the channel as unfrozen while it was not.
 */

const mockConsultationFindMany = jest.fn();
const mockSubscriptionFindMany = jest.fn();
const mockOrganizationFindMany = jest.fn();
const mockAppointmentFindMany = jest.fn();
const mockConsultationUpdateMany = jest.fn();
const mockSubscriptionUpdateMany = jest.fn();
const mockUpdatePartial = jest.fn();
const mockDeleteChannels = jest.fn();
const mockSendMessage = jest.fn();
/**
 * Captures `(type, id)` for every `client.channel()` call.
 *
 * Without it no test asserts WHICH channel was frozen: the identity case below
 * re-derived both ids from `getDmChannelId` and compared them to each other,
 * which passes even if the job addressed the wrong channel or the wrong Stream
 * type. `lib/stream-channel-ids.ts` records that a wrong type resolved silently
 * for months, which is exactly the failure this suite should catch.
 */
const mockChannel = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultation: {
      findMany: (...a: unknown[]) => mockConsultationFindMany(...a),
      updateMany: (...a: unknown[]) => mockConsultationUpdateMany(...a),
    },
    subscription: {
      findMany: (...a: unknown[]) => mockSubscriptionFindMany(...a),
      updateMany: (...a: unknown[]) => mockSubscriptionUpdateMany(...a),
    },
    organization: {
      findMany: (...a: unknown[]) => mockOrganizationFindMany(...a),
    },
    appointment: {
      findMany: (...a: unknown[]) => mockAppointmentFindMany(...a),
    },
    webinar: { updateMany: jest.fn() },
    class: { updateMany: jest.fn() },
    $disconnect: jest.fn(),
  },
}));

jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: () => true,
  getStreamChatClient: () => ({
    channel: (...args: unknown[]) => {
      mockChannel(...args);
      return {
        updatePartial: (...a: unknown[]) => mockUpdatePartial(...a),
        sendMessage: (...a: unknown[]) => mockSendMessage(...a),
      };
    },
    deleteChannels: (...a: unknown[]) => mockDeleteChannels(...a),
  }),
  withStreamCircuitBreaker: async (op: () => unknown) => op(),
}));

jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_n: string, _o: unknown, fn: () => unknown) => fn(),
}));

jest.mock("../../lib/stream/batch", () => ({
  ...jest.requireActual("../../lib/stream/batch"),
  pause: jest.fn(async () => undefined),
}));

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { warn: jest.fn(), info: jest.fn(), fmt: (s: unknown) => s },
}));

import { expireEventChannels } from "../../jobs/stream/expire-event-channels";
import { getDmChannelId } from "../../lib/stream-utils";

const DAY = 24 * 60 * 60 * 1000;
const CONSULTANT = "user-consultant";
const CONSULTEE = "user-consultee";

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY);
}

/** One DM-eligible consultation for the pair, with a given last session end. */
function consultation(
  id: string,
  lastSessionDaysAgo: number,
  chatFrozenAt: Date | null = null,
  organizationId: string | null = null,
) {
  return {
    id,
    chatFrozenAt,
    requestedBy: { user: { id: CONSULTEE } },
    consultationPlan: {
      organizationId,
      consultantProfile: { user: { id: CONSULTANT } },
    },
    appointment: {
      organizationId,
      slotsOfAppointment: [{ endsAt: daysAgo(lastSessionDaysAgo) }],
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConsultationFindMany.mockResolvedValue([]);
  mockSubscriptionFindMany.mockResolvedValue([]);
  mockOrganizationFindMany.mockResolvedValue([]);
  mockAppointmentFindMany.mockResolvedValue([]);
  mockConsultationUpdateMany.mockResolvedValue({ count: 1 });
  mockSubscriptionUpdateMany.mockResolvedValue({ count: 1 });
  mockUpdatePartial.mockResolvedValue(undefined);
  mockDeleteChannels.mockResolvedValue(undefined);
  mockSendMessage.mockResolvedValue(undefined);
  mockChannel.mockReset();
});

describe("DM dormancy — freeze", () => {
  it("leaves an ACTIVE pair alone", async () => {
    // Two weeks between sessions is ordinary for a consulting relationship.
    // Freezing here would be a product regression dressed up as hygiene.
    mockConsultationFindMany.mockResolvedValue([consultation("c1", 14)]);

    const result = await expireEventChannels();

    expect(result.dmFrozen).toBe(0);
    expect(mockUpdatePartial).not.toHaveBeenCalled();
  });

  it("freezes a pair dormant past 90 days", async () => {
    mockConsultationFindMany.mockResolvedValue([consultation("c1", 120)]);

    const result = await expireEventChannels();

    expect(result.dmFrozen).toBe(1);
    expect(mockUpdatePartial).toHaveBeenCalledWith({ set: { frozen: true } });
  });

  it("announces the freeze BEFORE applying it", async () => {
    // Stream grants `use-frozen-channel` to no role, so a frozen channel
    // refuses every send with no error text. Sending after the freeze would
    // itself be refused — the order is the whole point.
    const order: string[] = [];
    mockSendMessage.mockImplementation(async () => {
      order.push("notice");
    });
    mockUpdatePartial.mockImplementation(async () => {
      order.push("freeze");
    });
    mockConsultationFindMany.mockResolvedValue([consultation("c1", 120)]);

    await expireEventChannels();

    expect(order).toEqual(["notice", "freeze"]);
  });

  it("measures dormancy on the pair's MOST RECENT booking", async () => {
    // An old completed consultation plus a recent one. `DM_ELIGIBLE_STATUSES`
    // includes COMPLETED precisely so a finished booking keeps the conversation
    // open, so keying on the older row would freeze a live relationship.
    mockConsultationFindMany.mockResolvedValue([
      consultation("old", 400),
      consultation("recent", 3),
    ]);

    const result = await expireEventChannels();

    expect(result.dmFrozen).toBe(0);
    expect(result.dmDeleteRequests).toBe(0);
  });

  it("does not re-freeze a pair the ledger already covers", async () => {
    mockConsultationFindMany.mockResolvedValue([
      consultation("c1", 120, daysAgo(5)),
    ]);

    const result = await expireEventChannels();

    // Each redundant updatePartial burns one of the 300/min app-wide budget.
    // That is how the 2026-08-23 burst happened.
    expect(result.dmFrozen).toBe(0);
    expect(result.skippedAlreadyFrozen).toBe(1);
    expect(mockUpdatePartial).not.toHaveBeenCalled();
  });
});

describe("DM dormancy — unfreeze, the branch the design turns on", () => {
  it("unfreezes a frozen pair that booked again", async () => {
    mockConsultationFindMany.mockResolvedValue([
      // Frozen while dormant, then a new session three days ago.
      consultation("old", 200, daysAgo(30)),
      consultation("new", 3),
    ]);

    const result = await expireEventChannels();

    expect(result.dmUnfrozen).toBe(1);
    expect(mockUpdatePartial).toHaveBeenCalledWith({ set: { frozen: false } });
  });

  it("clears the ledger across EVERY booking the pair shares", async () => {
    mockConsultationFindMany.mockResolvedValue([
      consultation("old", 200, daysAgo(30)),
      consultation("new", 3),
    ]);

    await expireEventChannels();

    // The read takes MAX(chatFrozenAt) across the pair, so leaving one row
    // stamped would report the channel as still frozen when it is not.
    const [args] = mockConsultationUpdateMany.mock.calls[0] as [
      { where: { id: { in: string[] } }; data: { chatFrozenAt: Date | null } },
    ];
    expect(args.where.id.in.sort()).toEqual(["new", "old"]);
    expect(args.data.chatFrozenAt).toBeNull();
  });

  it("does not announce an unfreeze", async () => {
    mockConsultationFindMany.mockResolvedValue([
      consultation("old", 200, daysAgo(30)),
      consultation("new", 3),
    ]);

    await expireEventChannels();

    // The channel simply works again. A "you may post now" notice in a
    // conversation nobody has touched for months is noise.
    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});

describe("DM dormancy — identity and retention", () => {
  it("keeps the personal and org-funded channels of one pair APART", async () => {
    // The id is a function of the pair AND the funding context, so the same two
    // people hold two channels. An org relationship can end while the personal
    // one continues; collapsing them would freeze the wrong conversation.
    mockOrganizationFindMany.mockResolvedValue([
      { id: "org-1", chatRetentionDays: 365 },
    ]);
    mockConsultationFindMany.mockResolvedValue([
      consultation("personal", 3),
      consultation("org", 200, null, "org-1"),
    ]);

    const result = await expireEventChannels();

    expect(result.dmFrozen).toBe(1);

    const personalId = getDmChannelId(CONSULTANT, CONSULTEE);
    const orgChannelId = getDmChannelId(CONSULTANT, CONSULTEE, "org-1");
    expect(personalId).not.toBe(orgChannelId);

    // The org channel is the dormant one, so it — and only it — is addressed.
    // Asserting the derived ids against each other proves nothing about what
    // the job actually did; asserting the call does.
    expect(mockChannel).toHaveBeenCalledWith("messaging", orgChannelId);
    expect(mockChannel).not.toHaveBeenCalledWith("messaging", personalId);
  });

  it("deletes past retention rather than freezing", async () => {
    mockConsultationFindMany.mockResolvedValue([consultation("c1", 400)]);

    const result = await expireEventChannels();

    expect(result.dmDeleteRequests).toBe(1);
    expect(result.dmFrozen).toBe(0);
    expect(mockDeleteChannels).toHaveBeenCalled();
  });

  it("honours a shorter per-org retention dial", async () => {
    mockOrganizationFindMany.mockResolvedValue([
      { id: "org-1", chatRetentionDays: 120 },
    ]);
    mockConsultationFindMany.mockResolvedValue([
      consultation("c1", 150, null, "org-1"),
    ]);

    const result = await expireEventChannels();

    // 150 days is under the 365 default but past this org's 120.
    expect(result.dmDeleteRequests).toBe(1);
  });

  it("REFUSES to delete when the booking page was truncated", async () => {
    // The critical case. Both queries cap at MAX_DM_PAIRS_PER_RUN and order by
    // `requestedAt`, which is not the key dormancy is measured on — a booking
    // requested once and running for years sorts old and is the first thing a
    // full page drops. If a pair keeps a low-activity booking and loses its
    // active one, `lastActivityAt` comes from the stale row, the pair reads as
    // past retention, and `hard_delete: true` destroys the chat history of a
    // live consulting relationship.
    const full = Array.from({ length: 5000 }, (_, i) =>
      consultation(`c${i}`, 400),
    );
    mockConsultationFindMany.mockResolvedValue(full);

    const result = await expireEventChannels();

    expect(mockDeleteChannels).not.toHaveBeenCalled();
    expect(result.dmDeleteRequests).toBe(0);
    // Reported, not silent: a run that skipped work must not pass green.
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.includes("truncated"))).toBe(true);
  });

  it("still FREEZES on a truncated page, because freezing is reversible", async () => {
    // Withholding the freeze too would be over-correction. An over-eager freeze
    // is undone by the next run's unfreeze branch; a hard delete is not undone
    // by anything.
    const full = Array.from({ length: 5000 }, (_, i) =>
      consultation(`c${i}`, 120),
    );
    mockConsultationFindMany.mockResolvedValue(full);

    const result = await expireEventChannels();

    expect(result.dmFrozen).toBeGreaterThan(0);
  });

  it("widens the scan window for an org whose retention exceeds the constant", async () => {
    // `MAX_RETENTION_DAYS` is 365. An org on 500 days would have every booking
    // dropped by a window derived from the constant, and get no deletion at all
    // — silently, and in the direction of keeping personal data forever.
    mockOrganizationFindMany.mockResolvedValue([
      { id: "org-1", chatRetentionDays: 500 },
    ]);
    mockConsultationFindMany.mockResolvedValue([
      consultation("c1", 520, null, "org-1"),
    ]);

    const result = await expireEventChannels();

    expect(result.dmDeleteRequests).toBe(1);
  });

  it("does not fail the event stage when the DM stage throws", async () => {
    mockConsultationFindMany.mockRejectedValue(new Error("db down"));

    const result = await expireEventChannels();

    expect(result.errors.some((e) => e.includes("dm stage"))).toBe(true);
    // The event stage's own counters survive; the caller reports them.
    expect(result.frozen).toBe(0);
  });
});
