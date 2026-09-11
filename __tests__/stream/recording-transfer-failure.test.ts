/**
 * @jest-environment node
 */

/**
 * STR-2/3 — transfer-failure tracking + threshold alerting. On every failed
 * transfer the Recording row gets transferAttempts++ and lastTransferError set;
 * once attempts reach the alert threshold (>=3) and we haven't paged before
 * (transferFailureAlertedAt null), recordSystemError fires once and the dedupe
 * marker is stamped. A subsequent failure with the marker already set does NOT
 * re-page.
 */
jest.mock("../../lib/prisma", () => {
  const client = {
    recording: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  return { __esModule: true, default: client };
});
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: jest.fn().mockResolvedValue(undefined),
}));
// #1270 — the service reads the clients from the leaf module now, not from
// `lib/supabase`. That one carries an `import "server-only"` marker, which
// throws outside Next's `react-server` resolution and so cannot be reached from
// a cron process at all.
jest.mock("../../lib/supabase-storage-core", () => ({
  __esModule: true,
  supabase: { storage: {} },
  supabaseAdmin: { storage: {} },
  ensureBucketExists: jest.fn().mockResolvedValue(true),
  generateStorageFileName: jest.fn().mockReturnValue("file.mp4"),
}));

import prisma from "../../lib/prisma";
import { recordSystemError } from "../../lib/enterprise/system-events";
import { RecordingTransferService } from "../../lib/stream/recording-transfer-service";

const mockFindUnique = (
  prisma as unknown as { recording: { findUnique: jest.Mock } }
).recording.findUnique;
const mockUpdate = (
  prisma as unknown as { recording: { update: jest.Mock } }
).recording.update;
const mockRecordSystemError = recordSystemError as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  // Download fails → exercises the recordTransferFailure path without needing
  // a real blob/upload pipeline.
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status: 502,
    statusText: "Bad Gateway",
  }) as unknown as typeof fetch;
});

describe("transfer failure tracking (STR-2/3)", () => {
  it("increments transferAttempts and sets lastTransferError on failure", async () => {
    mockFindUnique.mockResolvedValue({
      id: "rec_1",
      recordingUrl: "https://stream.example/rec_1.mp4",
    });
    // The failure-tracking update returns the post-increment counters.
    mockUpdate.mockImplementation(({ data }: { data: Record<string, unknown> }) => {
      if (data.transferAttempts) {
        return Promise.resolve({
          organizationId: null,
          transferAttempts: 1,
          transferFailureAlertedAt: null,
        });
      }
      return Promise.resolve({});
    });

    const res = await RecordingTransferService.transferRecordingToSupabase("rec_1");

    expect(res.success).toBe(false);
    const failureUpdate = mockUpdate.mock.calls.find(
      ([arg]) => arg.data.transferAttempts,
    );
    expect(failureUpdate).toBeDefined();
    expect(failureUpdate![0].data).toMatchObject({
      status: "READY",
      transferAttempts: { increment: 1 },
    });
    expect(failureUpdate![0].data.lastTransferError).toContain("502");
    // Below threshold → no page.
    expect(mockRecordSystemError).not.toHaveBeenCalled();
  });

  it("pages once when attempts cross the threshold and stamps the dedupe marker", async () => {
    mockFindUnique.mockResolvedValue({
      id: "rec_1",
      recordingUrl: "https://stream.example/rec_1.mp4",
    });
    mockUpdate.mockImplementation(({ data }: { data: Record<string, unknown> }) => {
      if (data.transferAttempts) {
        return Promise.resolve({
          organizationId: "org_1",
          transferAttempts: 3, // crosses the >=3 threshold
          transferFailureAlertedAt: null,
        });
      }
      return Promise.resolve({});
    });

    await RecordingTransferService.transferRecordingToSupabase("rec_1");

    expect(mockRecordSystemError).toHaveBeenCalledTimes(1);
    expect(mockRecordSystemError).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org_1",
        category: "RECORDING_TRANSFER",
        correlationId: "rec_1",
      }),
    );
    // Dedupe marker stamped after the page.
    const stamp = mockUpdate.mock.calls.find(
      ([arg]) => arg.data.transferFailureAlertedAt instanceof Date,
    );
    expect(stamp).toBeDefined();
  });

  it("does NOT re-page when already alerted (dedupe)", async () => {
    mockFindUnique.mockResolvedValue({
      id: "rec_1",
      recordingUrl: "https://stream.example/rec_1.mp4",
    });
    mockUpdate.mockImplementation(({ data }: { data: Record<string, unknown> }) => {
      if (data.transferAttempts) {
        return Promise.resolve({
          organizationId: "org_1",
          transferAttempts: 5,
          transferFailureAlertedAt: new Date("2026-06-15T00:00:00.000Z"),
        });
      }
      return Promise.resolve({});
    });

    await RecordingTransferService.transferRecordingToSupabase("rec_1");

    expect(mockRecordSystemError).not.toHaveBeenCalled();
  });
});
