/**
 * @jest-environment node
 */

/**
 * The open-call traversal that gates the call-type hardening rollout.
 *
 * This existed and could never complete. `ensure-call-type-grants.ts --apply`
 * refuses unless it can prove every member of every open call already holds
 * `call_member`, and the proof requires walking all of them — so a traversal
 * that throws is a rollout that cannot happen. It failed with an opaque Stream
 * error that read like a transient outage:
 *
 *   QueryCalls failed with error: "cannot specify sort and next/prev at the
 *   same time"
 *
 * Measured against the live app on 2026-09-01: the cap is 100, there are 84
 * open calls, and EVERY request carrying `next` fails regardless of limit,
 * filter, or an explicit `sort: []`. The old page size of 25 therefore
 * guaranteed a second page, and the second page always threw.
 */

const mockQueryCalls = jest.fn();
const mockQueryMembers = jest.fn();

jest.mock("../../lib/stream-client", () => ({
  getStreamVideoClient: jest.fn(),
  isStreamConfigured: () => true,
}));

import {
  iterateOpenCalls,
  anyOpenCallMemberHolds,
  OpenCallScanTruncatedError,
  MEMBER_ROLE,
} from "../../scripts/stream/backfill-call-member-role";

type Client = Parameters<typeof iterateOpenCalls>[0];

const client = {
  video: {
    queryCalls: (...a: unknown[]) => mockQueryCalls(...a),
    call: () => ({ queryMembers: (...a: unknown[]) => mockQueryMembers(...a) }),
  },
} as unknown as Client;

/** `n` open calls in one page, with an optional cursor. */
function page(n: number, next?: string) {
  return {
    calls: Array.from({ length: n }, (_, i) => ({
      call: { id: `slot-${i}`, type: "default" },
    })),
    next,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQueryMembers.mockResolvedValue({
    members: [{ user_id: "u1", role: MEMBER_ROLE }],
    next: undefined,
  });
});

describe("iterateOpenCalls", () => {
  it("asks for the API maximum, not a size that forces pagination", async () => {
    mockQueryCalls.mockResolvedValue(page(84));

    const seen = [];
    for await (const c of iterateOpenCalls(client)) seen.push(c);

    expect(seen).toHaveLength(84);
    // 100 is Stream's documented ceiling — 250 is refused with "limit must be
    // 100 or less". Anything smaller invents a second page that cannot be
    // fetched.
    expect(mockQueryCalls).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    );
  });

  it("never sends `next`, because every request carrying it is rejected", async () => {
    mockQueryCalls.mockResolvedValue(page(84));

    for await (const _ of iterateOpenCalls(client)) void _;

    expect(mockQueryCalls).toHaveBeenCalledTimes(1);
    expect(mockQueryCalls.mock.calls[0][0]).not.toHaveProperty("next");
  });

  it("announces truncation instead of returning a prefix", async () => {
    // More than one page of open calls, and no supported way to reach the rest.
    // Returning what it has would let the caller conclude "every member holds
    // the role" from an arbitrary 100 of them.
    mockQueryCalls.mockResolvedValue(page(100, "cursor-abc"));

    const walk = async () => {
      for await (const _ of iterateOpenCalls(client)) void _;
    };

    await expect(walk()).rejects.toBeInstanceOf(OpenCallScanTruncatedError);
  });
});

describe("anyOpenCallMemberHolds", () => {
  it("reports the members missing the role, with their calls", async () => {
    mockQueryCalls.mockResolvedValue(page(2));
    mockQueryMembers
      .mockResolvedValueOnce({
        members: [{ user_id: "u1", role: MEMBER_ROLE }],
        next: undefined,
      })
      .mockResolvedValueOnce({
        members: [{ user_id: "u2", role: "user" }],
        next: undefined,
      });

    const scan = await anyOpenCallMemberHolds(client, MEMBER_ROLE);

    // A PARTIAL roster is a refusal: the write makes this role the only thing
    // that admits anyone, so one uncovered member is one lockout.
    expect(scan.callsScanned).toBe(2);
    expect(scan.membersMissingRole).toBe(1);
    expect(scan.found).toBe(false);
    expect(scan.callsWithUncoveredMembers).toContain("slot-1");
  });

  it("passes only when EVERY member is covered", async () => {
    mockQueryCalls.mockResolvedValue(page(2));

    const scan = await anyOpenCallMemberHolds(client, MEMBER_ROLE);

    expect(scan.found).toBe(true);
    expect(scan.membersMissingRole).toBe(0);
  });
});
