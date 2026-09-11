/**
 * @jest-environment node
 */

/**
 * A signup writes the row first and sends the confirmation second. When the
 * send fails the row is already on the list, so the caller must be told —
 * silently reporting success strands the subscriber at PENDING with no
 * confirmation link to click.
 *
 * Regression pin for the production incident where `WAITLIST_HMAC_SECRET` was
 * unset: `buildConfirmUrl` threw from outside the sender's try block, the
 * throw escaped `subscribe()`, and the route 500'd after the row was written.
 */

const mockUpsert = jest.fn();
const mockFindUnique = jest.fn();
const mockSendConfirm = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    waitlist: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      upsert: (...args: unknown[]) => mockUpsert(...args),
    },
  },
}));

jest.mock("../../lib/email", () => ({
  __esModule: true,
  sendWaitlistConfirmEmail: (...args: unknown[]) => mockSendConfirm(...args),
  sendWaitlistWelcomeEmail: jest.fn(),
}));

const mockCaptureMessage = jest.fn();
const mockCaptureException = jest.fn();

jest.mock("@sentry/nextjs", () => ({
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

jest.mock("../../lib/waitlist/tokens", () => ({
  canSignLinks: () => true,
  verifyConfirmToken: jest.fn(),
  verifyUnsubscribeToken: jest.fn(),
}));

import { subscribe } from "../../lib/waitlist/service";

const input = { email: "Reader@Example.com ", source: "FOOTER" as never };

describe("subscribe — confirmation send failure", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindUnique.mockResolvedValue(null);
    mockUpsert.mockResolvedValue({});
  });

  it("reports CONFIRMATION_FAILED when the send fails, and still writes the row", async () => {
    mockSendConfirm.mockResolvedValue({ success: false, error: "no secret" });

    const result = await subscribe(input);

    expect(result).toEqual({ outcome: "CONFIRMATION_FAILED" });
    // The row must still be on the list — the address opted in.
    expect(mockUpsert).toHaveBeenCalledTimes(1);

    // Removing the reporting call must fail this test, not pass silently.
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining("waitlist confirmation email failed to send"),
      expect.objectContaining({
        level: "warning",
        tags: { subsystem: "waitlist" },
      }),
    );
    // Neither the address nor a signed link may reach the report.
    const reported = JSON.stringify(mockCaptureMessage.mock.calls);
    expect(reported).not.toContain("reader@example.com");
    expect(reported).not.toContain("token=");
  });

  it("does not throw when the sender reports failure", async () => {
    mockSendConfirm.mockResolvedValue({ success: false, error: "no secret" });
    await expect(subscribe(input)).resolves.toBeDefined();
  });

  it("reports CONFIRMATION_SENT on a successful send", async () => {
    mockSendConfirm.mockResolvedValue({ success: true, data: {} });

    await expect(subscribe(input)).resolves.toEqual({
      outcome: "CONFIRMATION_SENT",
    });
  });

  it("normalises the address before writing and sending", async () => {
    mockSendConfirm.mockResolvedValue({ success: true, data: {} });

    await subscribe(input);

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: "reader@example.com" } }),
    );
    expect(mockSendConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ email: "reader@example.com" }),
    );
  });

  it("short-circuits an already-subscribed address without sending", async () => {
    mockFindUnique.mockResolvedValue({ status: "SUBSCRIBED" });

    await expect(subscribe(input)).resolves.toEqual({
      outcome: "ALREADY_SUBSCRIBED",
    });
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockSendConfirm).not.toHaveBeenCalled();
  });
});
