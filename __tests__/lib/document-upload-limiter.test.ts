/**
 * @jest-environment node
 */

/**
 * DOC-2 (#694) — regression guard for the document-upload rate limiter.
 *
 * The limiter is constructed at module-load time from `@/lib/redis-edge`,
 * which requires Upstash env vars. We mock that module so the test runs
 * without a live Redis and asserts only the limiter's configuration:
 * its dedicated prefix bucket and a working `limit` surface. If someone
 * drops the export or collapses it into a shared bucket, this fails.
 */

jest.mock("../../lib/redis-edge", () => ({
  __esModule: true,
  default: {},
}));

import { documentUploadLimiter } from "../../lib/rate-limit";

describe("documentUploadLimiter", () => {
  it("is configured with its own dedicated bucket", () => {
    expect(documentUploadLimiter).toBeDefined();
    // Own prefix so uploads never share quota with other mutations (#694).
    expect((documentUploadLimiter as unknown as { prefix: string }).prefix).toBe(
      "rl:document-upload",
    );
  });

  it("exposes the limiter surface applyRateLimit relies on", () => {
    expect(typeof documentUploadLimiter.limit).toBe("function");
  });
});
