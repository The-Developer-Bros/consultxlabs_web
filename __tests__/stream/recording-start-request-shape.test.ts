/**
 * @jest-environment node
 */

/**
 * #1580 §4 E2E — every recording start answered 500 because the request named
 * `recording_type: "default"`. In @stream-io/node-sdk the recording type is a
 * PATH segment of `/recordings/{recording_type}/start` and Stream accepts only
 * `composite | individual | raw` (the values its own recording events carry), so
 * "default" was refused and no recording has been startable since 2026-08-15.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const startRecording = jest.fn(async (_req?: Record<string, unknown>) => ({
  duration: "1ms",
}));
jest.mock("../../lib/stream-client", () => ({
  getStreamVideoClient: () => ({
    video: { call: () => ({ startRecording }) },
  }),
  withStreamCircuitBreaker: (op: () => unknown) => op(),
}));

describe("RecordingService.startRecording", () => {
  it("starts a composite recording, a type Stream actually accepts", async () => {
    const { RecordingService } =
      await import("../../lib/stream/recording-service");
    const result = await RecordingService.startRecording(
      "default:slot-1",
      "user-1",
    );

    expect(result).toEqual({ success: true });
    expect(startRecording).toHaveBeenCalledTimes(1);
    const arg = startRecording.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(arg?.recording_type).toBe("composite");
  });
});
