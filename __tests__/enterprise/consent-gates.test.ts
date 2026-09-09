/**
 * @jest-environment node
 */

/**
 * #701 — the fail-closed contract the new consent gates (org-sponsored checkout,
 * invite acceptance, data export) all depend on: checkConsent returns true ONLY
 * for a live, non-withdrawn, non-expired artifact carrying the purpose code.
 */

const mockFindFirst = jest.fn();
const mockUpdateMany = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consentArtifact: {
      findFirst: (...a: unknown[]) => mockFindFirst(...a),
      updateMany: (...a: unknown[]) => mockUpdateMany(...a),
    },
  },
}));

// withdrawConsent fires a SESSION_BOOKING cascade event through a dynamic
// import; the gate under test does not depend on it.
jest.mock("../../lib/enterprise/system-events", () => ({
  __esModule: true,
  recordSystemEvent: jest.fn(),
}));

import { checkConsent, withdrawConsent } from "@/lib/compliance/dpdp";
import {
  PURPOSE_CODES,
  purposeCodeAliases,
} from "@/lib/compliance/purpose-codes";

beforeEach(() => {
  mockFindFirst.mockReset();
  mockUpdateMany.mockReset();
});

describe("checkConsent — fail-closed (#701)", () => {
  it("is true when a live artifact for the purpose exists", async () => {
    mockFindFirst.mockResolvedValue({ id: "c1" });
    const ok = await checkConsent({
      userId: "u1",
      purposeCode: PURPOSE_CODES.SESSION_BOOKING,
    });
    expect(ok).toBe(true);
    // The query must filter withdrawn + expired out and match the purpose code.
    const where = mockFindFirst.mock.calls[0][0].where;
    expect(where.userId).toBe("u1");
    // #1472 — the canonical code plus its legacy aliases, not an exact match.
    expect(where.purposeCodes.hasSome).toContain(PURPOSE_CODES.SESSION_BOOKING);
    expect(where.withdrawnAt).toBeNull();
    expect(where.auditRetainedUntil.gt).toBeInstanceOf(Date);
  });

  it("is false (fail-closed) when no matching artifact exists", async () => {
    mockFindFirst.mockResolvedValue(null);
    const ok = await checkConsent({
      userId: "u1",
      purposeCode: PURPOSE_CODES.PRIMARY_PROCESSING,
    });
    expect(ok).toBe(false);
  });

  it("SESSION_BOOKING + PRIMARY_PROCESSING are canonical codes the gates use", () => {
    expect(PURPOSE_CODES.SESSION_BOOKING).toBe("SESSION_BOOKING");
    expect(PURPOSE_CODES.PRIMARY_PROCESSING).toBe("PRIMARY_PROCESSING");
  });
});

/**
 * #1472 — the pre-taxonomy kebab-case codes are still on disk (no backfill:
 * pre-MVP reset). A consent record is a legal artifact, so the gate that
 * decides whether a consultant can be booked must recognise every code the
 * platform ever wrote for that purpose, and a narrow withdrawal must reach the
 * same rows the gate reads.
 */
describe("#1472 legacy purpose codes are recognised by the runtime gates", () => {
  /** Match an artifact's stored codes against a `hasSome` clause, as PG would. */
  const matches = (
    where: { purposeCodes: { hasSome: string[] } },
    stored: string[],
  ) => stored.some((code) => where.purposeCodes.hasSome.includes(code));

  it("lets a `session-booking` artifact satisfy a SESSION_BOOKING check", async () => {
    mockFindFirst.mockResolvedValue({ id: "legacy-artifact" });
    await checkConsent({
      userId: "u1",
      purposeCode: PURPOSE_CODES.SESSION_BOOKING,
    });

    const where = mockFindFirst.mock.calls[0][0].where;
    expect(matches(where, ["session-booking"])).toBe(true);
    // An unrelated legacy code is NOT swept in by the same alias set.
    expect(matches(where, ["marketing"])).toBe(false);
  });

  it("withdraws a `session-booking` artifact on a SESSION_BOOKING withdrawal", async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });
    await withdrawConsent({
      userId: "u1",
      purposeCode: PURPOSE_CODES.SESSION_BOOKING,
    });

    const where = mockUpdateMany.mock.calls[0][0].where;
    expect(matches(where, ["session-booking"])).toBe(true);
    expect(matches(where, ["third-party-sharing-with-stream"])).toBe(false);
  });

  it("resolves aliases per purpose, never across purposes", () => {
    expect(purposeCodeAliases(PURPOSE_CODES.SESSION_BOOKING)).toEqual([
      "SESSION_BOOKING",
      "session-booking",
    ]);
    expect(purposeCodeAliases(PURPOSE_CODES.MARKETING_COMMS)).not.toContain(
      "session-booking",
    );
  });
});
