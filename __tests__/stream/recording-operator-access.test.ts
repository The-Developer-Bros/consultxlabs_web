/**
 * @jest-environment node
 */

/**
 * #1270 — a recording is not an operator's to watch.
 *
 * `GET /api/stream/recordings/[recordingId]` opened with
 * `if (isPrivileged(session.user.role)) hasAccess = true`, and `isPrivileged`
 * is ADMIN *or* STAFF. Any staff member could therefore fetch a playback URL
 * for any recording on the platform — including a 1:1 consultation they had no
 * relationship to — and nothing was written anywhere to say they had. The
 * operator path was strictly less accountable than the tenant path, where
 * deleting or exporting a recording already wrote an `OrgAuditLog` row.
 *
 * This pins the fix on all three axes: staff get metadata and never a URL,
 * admin keeps playback, and either one reaching in leaves a trail.
 */

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

// Best-effort HTTP sink inside recordSystemEvent. Stubbed so the suite never
// depends on Better Stack config; the DB row is the assertion that matters.
jest.mock("../../lib/observability/betterstack-telemetry", () => ({
  __esModule: true,
  emitTelemetryLog: jest.fn(async () => undefined),
}));

jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(),
}));

jest.mock("../../lib/stream/recording-service", () => ({
  __esModule: true,
  RecordingService: { getRecordingById: jest.fn() },
}));

jest.mock("../../lib/stream/recording-storage", () => ({
  __esModule: true,
  getBestRecordingUrl: jest.fn(async () => "https://signed.example/play.mp4"),
  generateSignedUrl: jest.fn(async () => "https://signed.example/play.mp4"),
  isDurablyOurs: jest.fn(() => true),
  durablyOursWhere: jest.fn(() => ({})),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    recordingPurchase: { findFirst: jest.fn(async () => null) },
    payment: { findMany: jest.fn(async () => []) },
    collaborator: { findFirst: jest.fn(async () => null) },
    orgAuditLog: { create: jest.fn(async () => ({ id: "audit-1" })) },
    systemEvent: { create: jest.fn(async () => ({ id: "evt-1" })) },
  },
}));

import { readFileSync } from "fs";
import { join } from "path";
import { NextRequest } from "next/server";

import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import { resolveOperatorRecordingAccess } from "@/lib/stream/recording-operator-access";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

import prisma from "../../lib/prisma";
import { getSession } from "../../lib/auth-server";
import { RecordingService } from "../../lib/stream/recording-service";
import { getBestRecordingUrl } from "../../lib/stream/recording-storage";
import { GET } from "../../app/api/stream/recordings/[recordingId]/route";

const mockedGetSession = getSession as jest.Mock;
const mockedGetRecording = RecordingService.getRecordingById as jest.Mock;
const mockedBestUrl = getBestRecordingUrl as unknown as jest.Mock;
const db = prisma as unknown as {
  orgAuditLog: { create: jest.Mock };
  systemEvent: { create: jest.Mock };
  payment: { findMany: jest.Mock };
  recordingPurchase: { findFirst: jest.Mock };
};

const RECORDING_ID = "rec-1";

/**
 * A 1:1 consultation recording belonging to an org. Deliberately has no
 * webinar/class plan: the operator branch is the ONLY way in, so nothing else
 * can accidentally satisfy the access check and green the test.
 */
const recordingFixture = {
  id: RECORDING_ID,
  title: "Consultation — 12 Aug",
  durationInMinutes: 45,
  recordedAt: new Date("2026-08-12T10:00:00Z"),
  status: "AVAILABLE",
  storageType: "PLATFORM",
  thumbnailUrl: "https://cdn.example/thumb.jpg",
  resolution: "1080p",
  previewClipUrl: "https://cdn.example/clip.mp4",
  previewClipDuration: 30,
  streamUrlExpiresAt: null,
  createdAt: new Date("2026-08-12T11:00:00Z"),
  meetingSession: {
    id: "ms-1",
    streamCallId: "slot-abc",
    organizationId: "org-1",
    slotOfAppointment: { appointment: { id: "appt-1" } },
  },
};

const sessionFor = (role: string) => ({
  user: {
    id: `user-${role.toLowerCase()}`,
    role,
    // No consultant profile and no purchases: every ownership and entitlement
    // path below the operator branch must fail.
    consultantProfileId: null,
    consulteeProfileId: null,
  },
});

const params = { params: Promise.resolve({ recordingId: RECORDING_ID }) };
const request = () =>
  new NextRequest(`http://localhost/api/stream/recordings/${RECORDING_ID}`);

const callAs = async (role: string) => {
  mockedGetSession.mockResolvedValue(sessionFor(role));
  mockedGetRecording.mockResolvedValue(recordingFixture);
  const res = await GET(request(), params);
  return { res, body: await res.json() };
};

beforeEach(() => {
  // Call history, not just return values — otherwise a later assertion can
  // pass on a call an earlier test made.
  jest.clearAllMocks();
  db.payment.findMany.mockResolvedValue([]);
  db.recordingPurchase.findFirst.mockResolvedValue(null);
  db.orgAuditLog.create.mockResolvedValue({ id: "audit-1" });
  db.systemEvent.create.mockResolvedValue({ id: "evt-1" });
  mockedBestUrl.mockResolvedValue("https://signed.example/play.mp4");
});

describe("the recordings permission matrix", () => {
  it("lets both operators read metadata but only ADMIN play", () => {
    expect(hasBackofficePermission("STAFF", "recordings.read")).toBe(true);
    expect(hasBackofficePermission("ADMIN", "recordings.read")).toBe(true);
    expect(hasBackofficePermission("STAFF", "recordings.play")).toBe(false);
    expect(hasBackofficePermission("ADMIN", "recordings.play")).toBe(true);
  });

  it("resolves the same answer through the shared helper", () => {
    expect(resolveOperatorRecordingAccess("ADMIN")).toEqual({
      canRead: true,
      canPlay: true,
    });
    expect(resolveOperatorRecordingAccess("STAFF")).toEqual({
      canRead: true,
      canPlay: false,
    });
  });

  it("treats every non-operator role as no grant at all", () => {
    // Including the shapes that are not UserRole values. A session minted
    // before a role rename must not index into the matrix and throw, and it
    // must certainly not be treated as an operator.
    for (const role of ["CONSULTANT", "CONSULTEE", "", null, undefined]) {
      expect(resolveOperatorRecordingAccess(role)).toEqual({
        canRead: false,
        canPlay: false,
      });
    }
  });
});

describe("GET /api/stream/recordings/[recordingId] — operator access", () => {
  it("gives STAFF metadata and no playable URL", async () => {
    const { res, body } = await callAs("STAFF");

    expect(res.status).toBe(200);
    expect(body.access.level).toBe("METADATA_ONLY");
    expect(body.recording.playbackUrl).toBeNull();

    // Not just the playback URL: a thumbnail is a frame of the session and the
    // preview clip is a cut of it. Withholding one and shipping the other two
    // would be theatre.
    expect(body.recording.thumbnailUrl).toBeNull();
    expect(body.recording.previewClipUrl).toBeNull();

    // The metadata a support agent actually needs still comes back.
    expect(body.recording).toMatchObject({
      id: RECORDING_ID,
      status: "AVAILABLE",
      storageType: "PLATFORM",
      durationInMinutes: 45,
    });

    // The strongest assertion here: the URL was never minted, so it cannot
    // have leaked into a log, a Sentry breadcrumb or a serialization bug.
    expect(mockedBestUrl).not.toHaveBeenCalled();
  });

  it("gives ADMIN the playback URL", async () => {
    const { res, body } = await callAs("ADMIN");

    expect(res.status).toBe(200);
    expect(body.access.level).toBe("FULL");
    expect(body.recording.playbackUrl).toBe("https://signed.example/play.mp4");
    expect(mockedBestUrl).toHaveBeenCalledTimes(1);
  });

  it("still refuses an unrelated consultee", async () => {
    // The guard against "fixed it by opening it to everyone".
    const { res } = await callAs("CONSULTEE");
    expect(res.status).toBe(403);
    expect(mockedBestUrl).not.toHaveBeenCalled();
  });
});

describe("every privileged recording read is audited", () => {
  it("writes a tenant audit row naming the actor and whether they played it", async () => {
    await callAs("ADMIN");

    expect(db.orgAuditLog.create).toHaveBeenCalledTimes(1);
    const row = db.orgAuditLog.create.mock.calls[0][0].data;
    expect(row).toMatchObject({
      organizationId: "org-1",
      category: "SYSTEM",
      action: AUDIT_ACTIONS.SYSTEM.STREAM_RECORDING_ACCESSED,
    });
    expect(row.details).toMatchObject({
      actorUserId: "user-admin",
      actorRole: "ADMIN",
      recordingId: RECORDING_ID,
      played: true,
    });
  });

  it("audits the STAFF metadata read too, marked as not played", async () => {
    // A read that stops short of playback is still an operator reaching into
    // someone else's session, and is still the thing an investigation needs.
    await callAs("STAFF");

    const row = db.orgAuditLog.create.mock.calls[0][0].data;
    expect(row.details).toMatchObject({ actorRole: "STAFF", played: false });
  });

  it("writes the platform trail as well, so B2C reads are not invisible", async () => {
    await callAs("STAFF");
    expect(db.systemEvent.create).toHaveBeenCalledTimes(1);
    const evt = db.systemEvent.create.mock.calls[0][0].data;
    expect(evt.category).toBe("STREAM_RECORDING_ACCESS");
    expect(evt.severity).toBe("WARN");
  });

  it("audits before the playback URL is minted", async () => {
    // Ordering is the point: a trail written after the URL exists can be
    // skipped by anything that throws in between.
    const order: string[] = [];
    db.orgAuditLog.create.mockImplementation(async () => {
      order.push("audit");
      return { id: "audit-1" };
    });
    mockedBestUrl.mockImplementation(async () => {
      order.push("url");
      return "https://signed.example/play.mp4";
    });

    await callAs("ADMIN");
    expect(order).toEqual(["audit", "url"]);
  });

  it("does not serve the read when the audit write fails", async () => {
    db.orgAuditLog.create.mockRejectedValue(new Error("audit sink down"));
    const { res } = await callAs("ADMIN");
    expect(res.status).toBe(500);
    expect(mockedBestUrl).not.toHaveBeenCalled();
  });
});

describe("no route hands out a raw Stream S3 link", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

  it("the org call export names no field that reaches the media", () => {
    // `Recording.recordingUrl` is Stream's pre-signed S3 link: fourteen days of
    // validity, its own credentials, no session required. It was returned
    // verbatim to any org MANAGER+, so forwarding the JSON forwarded the video.
    //
    // ADR 20 — an organization sees THAT a session happened, not what happened
    // in it — governs this route, and explicitly rejected an "org role opens
    // content behind an audit row" arm. So the fix is a select allowlist with
    // no playback path at all, matching `recordingMetadataSelect` in
    // lib/api/scope/list-recordings.ts, which the July 2026 audit fixed on the
    // sibling surface while missing this one.
    const src = read("app/api/organizations/[orgId]/stream/calls/route.ts");
    for (const field of [
      "recordingUrl",
      "storageUrl",
      "storagePath",
      "thumbnailUrl",
      "previewClipUrl",
      "streamRecordingId",
    ]) {
      expect({ field, selected: src.includes(`${field}: true`) }).toEqual({
        field,
        selected: false,
      });
    }
    // And no signing helper was smuggled in as a substitute.
    expect(src).not.toContain("generateSignedUrl");
    expect(src).not.toContain("getBestRecordingUrl");
  });

  it("still returns the retention metadata the compliance pull exists for", () => {
    // The guard against over-correcting into a useless export.
    const src = read("app/api/organizations/[orgId]/stream/calls/route.ts");
    for (const field of ["status", "storageType", "streamUrlExpiresAt"]) {
      expect(src).toContain(`${field}: true`);
    }
  });

  it("routes both stream recording surfaces through the matrix, not isPrivileged", () => {
    for (const rel of [
      "app/api/stream/recordings/[recordingId]/route.ts",
      "app/api/stream/meetings/[streamCallId]/recording-info/route.ts",
    ]) {
      const src = read(rel);
      expect(src).toContain("resolveOperatorRecordingAccess");
      expect(src).toContain("auditOperatorRecordingAccess");
      expect(src).not.toContain("isPrivileged(");
    }
  });
});

describe("POST /api/stream/recordings/sync is rate limited", () => {
  it("applies a per-user limiter before doing any Stream work", () => {
    // Session-only and unbounded before: one POST fans out a listRecordings
    // call per session the caller touches, all of it billable.
    const src = readFileSync(
      join(process.cwd(), "app/api/stream/recordings/sync/route.ts"),
      "utf8",
    );
    expect(src).toContain("streamRecordingSyncLimiter");
    expect(src).toMatch(/applyRateLimit\(\s*streamRecordingSyncLimiter/);
    expect(src).toContain("if (limited) return limited;");
    // Keyed on the user, not the IP — the edge rule already covers the path by
    // IP and that is exactly what was insufficient.
    expect(src).toContain("`recordings-sync:${session.user.id}`");
  });
});
