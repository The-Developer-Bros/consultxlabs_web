/**
 * The recording size ceiling used to be the same magic number in three places:
 * the transfer pre-flight, the `fileSizeLimit` passed to `ensureBucketExists`,
 * and the value actually provisioned on the bucket. Raising one alone converts
 * a clean pre-flight rejection into a mid-upload 413, so what matters is that
 * there is exactly one of them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TRANSFER_SERVICE = join(
  __dirname,
  "../../lib/stream/recording-transfer-service.ts",
);

describe("recording object ceiling", () => {
  afterEach(() => {
    jest.resetModules();
    delete process.env.RECORDING_MAX_OBJECT_BYTES;
  });

  it("clears a real recording — the old 500MB cap did not", async () => {
    const { RECORDING_MAX_OBJECT_BYTES } = await import(
      "@/lib/stream/recording-storage"
    );
    // Sessions here run long; ~1GB per file is the planning number.
    expect(RECORDING_MAX_OBJECT_BYTES).toBeGreaterThan(1024 * 1024 * 1024);
    expect(RECORDING_MAX_OBJECT_BYTES).toBeGreaterThan(500 * 1024 * 1024);
  });

  it("stays within the 5GiB single-part S3 limit, so no silent truncation", async () => {
    const { RECORDING_MAX_OBJECT_BYTES } = await import(
      "@/lib/stream/recording-storage"
    );
    expect(RECORDING_MAX_OBJECT_BYTES).toBeLessThanOrEqual(
      5 * 1024 * 1024 * 1024,
    );
  });

  it("is overridable per environment", async () => {
    jest.resetModules();
    process.env.RECORDING_MAX_OBJECT_BYTES = String(2 * 1024 * 1024 * 1024);
    const { RECORDING_MAX_OBJECT_BYTES } = await import(
      "@/lib/stream/recording-storage"
    );
    expect(RECORDING_MAX_OBJECT_BYTES).toBe(2 * 1024 * 1024 * 1024);
  });

  it.each([
    ["empty string", ""],
    ["whitespace", "   "],
    ["non-numeric", "abc"],
    ["zero", "0"],
    ["negative", "-1"],
    ["Infinity", "Infinity"],
  ])("falls back to the default for %s", async (_label, raw) => {
    jest.resetModules();
    process.env.RECORDING_MAX_OBJECT_BYTES = raw;
    const { RECORDING_MAX_OBJECT_BYTES } = await import(
      "@/lib/stream/recording-storage"
    );
    // `??` does not catch "", and .env.sample ships this key blank — a ceiling
    // of 0 would reject every recording with a positive Content-Length.
    expect(RECORDING_MAX_OBJECT_BYTES).toBe(5 * 1024 * 1024 * 1024);
  });

  it("is not duplicated back into the transfer service", () => {
    const src = readFileSync(TRANSFER_SERVICE, "utf8");
    expect(src).not.toContain("MAX_TRANSFER_SIZE");
    // The literal 500MB, in the two spellings it appeared in.
    expect(src).not.toContain("524288000");
    expect(src).not.toContain("500 * 1024 * 1024");
    expect(src).toContain("RECORDING_MAX_OBJECT_BYTES");
  });

  it("uses the shared mime list for both the bucket and the content check", () => {
    const src = readFileSync(TRANSFER_SERVICE, "utf8");
    expect(src).not.toContain("ALLOWED_VIDEO_TYPES");
    expect(src).toContain("RECORDING_MIME_TYPES");
  });

  it("the bucket accepts every content type the transfer will pass through", async () => {
    const { RECORDING_MIME_TYPES } = await import(
      "@/lib/stream/recording-storage"
    );
    // Stream serves some recordings without a specific video type; if the
    // bucket rejected that, the upload would 400 after a full download.
    expect(RECORDING_MIME_TYPES).toContain("application/octet-stream");
    expect(RECORDING_MIME_TYPES).toContain("video/mp4");
  });
});
