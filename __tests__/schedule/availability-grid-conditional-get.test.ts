/**
 * @jest-environment node
 */

/**
 * #1319 PR 9 — conditional GET on the polled availability grid.
 *
 * ADR 16 keeps slot freshness on a 60s poll rather than a socket, so every
 * open calendar re-asks this endpoint once a minute and almost always gets
 * back the answer it already holds. The route now decides that from a single
 * indexed change marker before it runs any of the occupancy work.
 *
 * The pin: an unchanged marker answers 304 WITHOUT touching the heavy queries,
 * and a changed marker answers 200 with a different tag.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn(),
    consultantProfile: { findUnique: jest.fn(), count: jest.fn() },
    appointment: { findMany: jest.fn() },
    membership: { findFirst: jest.fn() },
  },
}));

jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(async () => null),
}));

import { NextRequest } from "next/server";
import { GET } from "../../app/api/slots/availability-with-allocation/[consultantId]/route";
import prisma from "@/lib/prisma";

const CONSULTANT_ID = "consultant-1";
const URL_BASE = `https://x.test/api/slots/availability-with-allocation/${CONSULTANT_ID}`;
const QUERY =
  "startDateInUtc=2026-09-07T00:00:00.000Z&endDateInUtc=2026-09-14T00:00:00.000Z&timezone=UTC";

const mockedMarker = prisma.$queryRaw as unknown as jest.Mock;
const mockedProfile = prisma.consultantProfile.findUnique as jest.Mock;
const mockedAppointments = prisma.appointment.findMany as jest.Mock;

function marker(overrides: Record<string, Date | number | null> = {}) {
  return [
    {
      profileUpdatedAt: new Date("2026-09-01T10:00:00.000Z"),
      availabilityUpdatedAt: new Date("2026-09-01T11:00:00.000Z"),
      availabilityRowCount: 3,
      paymentsUpdatedAt: null,
      slotsUpdatedAt: new Date("2026-09-02T09:00:00.000Z"),
      requestsUpdatedAt: new Date("2026-09-02T08:00:00.000Z"),
      nextHoldExpiry: null,
      ...overrides,
    },
  ];
}

function request(ifNoneMatch?: string) {
  return new NextRequest(`${URL_BASE}?${QUERY}`, {
    headers: ifNoneMatch ? { "If-None-Match": ifNoneMatch } : undefined,
  });
}

const params = Promise.resolve({ consultantId: CONSULTANT_ID });

beforeEach(() => {
  jest.clearAllMocks();
  mockedMarker.mockResolvedValue(marker());
  mockedProfile.mockResolvedValue({
    id: CONSULTANT_ID,
    userId: "user-consultant",
    scheduleType: "WEEKLY",
    slotsOfAvailabilityWeekly: [],
    slotsOfAvailabilityCustom: [],
  });
  mockedAppointments.mockResolvedValue([]);
});

describe("availability grid conditional GET", () => {
  it("answers 200 with a strong ETag when the caller sends no validator", async () => {
    const res = await GET(request(), { params });

    expect(res.status).toBe(200);
    const etag = res.headers.get("ETag");
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=30");
    expect(mockedProfile).toHaveBeenCalledTimes(1);
  });

  it("answers 304 and skips the occupancy queries when the marker has not moved", async () => {
    const first = await GET(request(), { params });
    const etag = first.headers.get("ETag") as string;

    jest.clearAllMocks();
    mockedMarker.mockResolvedValue(marker());

    const second = await GET(request(etag), { params });

    expect(second.status).toBe(304);
    expect(second.headers.get("ETag")).toBe(etag);
    expect(second.headers.get("Cache-Control")).toBe("private, max-age=30");
    // The whole point: no availability read, no occupancy read.
    expect(mockedProfile).not.toHaveBeenCalled();
    expect(mockedAppointments).not.toHaveBeenCalled();
    expect(mockedMarker).toHaveBeenCalledTimes(1);
  });

  it("answers 200 with a new ETag when a slot row has moved since", async () => {
    const first = await GET(request(), { params });
    const etag = first.headers.get("ETag") as string;

    mockedMarker.mockResolvedValue(
      marker({ slotsUpdatedAt: new Date("2026-09-02T09:30:00.000Z") }),
    );

    const second = await GET(request(etag), { params });

    expect(second.status).toBe(200);
    expect(second.headers.get("ETag")).not.toBe(etag);
    expect(mockedAppointments).toHaveBeenCalled();
  });

  it("answers 200 when only the clock fold moved — a hold lapsed with no write", async () => {
    const withHold = await GET(request(), {
      params,
    });
    const etag = withHold.headers.get("ETag") as string;

    // The earliest still-future PENDING deadline is what the marker carries;
    // when now() passes it the row drops out and the next one takes its place.
    mockedMarker.mockResolvedValue(
      marker({ nextHoldExpiry: new Date("2026-09-07T12:00:00.000Z") }),
    );

    const after = await GET(request(etag), { params });

    expect(after.status).toBe(200);
    expect(after.headers.get("ETag")).not.toBe(etag);
  });

  it("answers 200 when an availability row was deleted — count moved, timestamps equal", async () => {
    const withHold = await GET(request(), {
      params,
    });
    const etag = withHold.headers.get("ETag") as string;

    // The earliest still-future PENDING deadline is what the marker carries;
    // when now() passes it the row drops out and the next one takes its place.
    mockedMarker.mockResolvedValue(marker({ availabilityRowCount: 2 }));

    const after = await GET(request(etag), { params });

    expect(after.status).toBe(200);
    expect(after.headers.get("ETag")).not.toBe(etag);
  });
});
