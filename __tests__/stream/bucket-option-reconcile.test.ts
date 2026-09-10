/**
 * @jest-environment node
 */

/**
 * `ensureBucketExists` used to apply its options only at CREATE time, so a
 * bucket that already existed kept whatever limits it was born with and the
 * options argument was silently ignored. That is how the recordings bucket sat
 * at a 500MB limit while the code around it expected more.
 *
 * The MIME arm is the one that actually bites in practice: Stream's external
 * storage probe uploads a `text/plain` file, and a bucket still carrying a
 * video-only allow-list rejects it with a 415 that reads like a credentials
 * failure rather than a config one.
 */
const getBucket = jest.fn();
const updateBucket = jest.fn().mockResolvedValue({ error: null });
const list = jest.fn().mockResolvedValue({ data: [], error: null });

jest.mock("@/lib/supabase-config", () => ({}), { virtual: true });

jest.mock("../../lib/supabase-storage-core", () => {
  const actual = jest.requireActual("../../lib/supabase-storage-core");
  return actual;
});

describe("ensureBucketExists option reconciliation", () => {
  let ensureBucketExists: (
    name: string,
    options?: {
      public?: boolean;
      allowedMimeTypes?: string[];
      fileSizeLimit?: number;
    },
  ) => Promise<boolean>;

  beforeEach(async () => {
    jest.resetModules();
    getBucket.mockReset();
    updateBucket.mockReset().mockResolvedValue({ error: null });
    list.mockReset().mockResolvedValue({ data: [], error: null });

    jest.doMock("@supabase/supabase-js", () => ({
      createClient: () => ({
        storage: { from: () => ({ list }), getBucket, updateBucket },
      }),
    }));

    ({ ensureBucketExists } = await import(
      "../../lib/supabase-storage-core"
    ));
  });

  const bucket = (over: Record<string, unknown> = {}) => ({
    data: {
      name: "recordings",
      public: false,
      file_size_limit: 524288000,
      allowed_mime_types: ["video/mp4", "video/webm"],
      ...over,
    },
  });

  it("widens a stale file size limit", async () => {
    getBucket.mockResolvedValue(bucket());
    await ensureBucketExists("recordings", { fileSizeLimit: 5368709120 });
    expect(updateBucket).toHaveBeenCalledWith(
      "recordings",
      expect.objectContaining({ fileSizeLimit: 5368709120 }),
    );
  });

  it("reconciles a MIME-only change, with size and visibility already correct", async () => {
    getBucket.mockResolvedValue(bucket());
    await ensureBucketExists("recordings", {
      fileSizeLimit: 524288000,
      public: false,
      allowedMimeTypes: ["video/mp4", "video/webm", "application/octet-stream"],
    });
    expect(updateBucket).toHaveBeenCalledWith(
      "recordings",
      expect.objectContaining({
        allowedMimeTypes: [
          "video/mp4",
          "video/webm",
          "application/octet-stream",
        ],
      }),
    );
  });

  it("treats MIME order as insignificant", async () => {
    getBucket.mockResolvedValue(bucket());
    await ensureBucketExists("recordings", {
      allowedMimeTypes: ["video/webm", "video/mp4"],
    });
    expect(updateBucket).not.toHaveBeenCalled();
  });

  it("writes nothing when every option already matches", async () => {
    getBucket.mockResolvedValue(bucket());
    await ensureBucketExists("recordings", {
      public: false,
      fileSizeLimit: 524288000,
      allowedMimeTypes: ["video/mp4", "video/webm"],
    });
    expect(updateBucket).not.toHaveBeenCalled();
  });

  it("still reconciles when the bucket is already memoized", async () => {
    getBucket.mockResolvedValue(bucket());
    // First caller supplies nothing, which is what puts it in the cache.
    await ensureBucketExists("recordings");
    expect(updateBucket).not.toHaveBeenCalled();

    // A later caller with real options must not be silently ignored.
    await ensureBucketExists("recordings", { fileSizeLimit: 5368709120 });
    expect(updateBucket).toHaveBeenCalledWith(
      "recordings",
      expect.objectContaining({ fileSizeLimit: 5368709120 }),
    );
  });

  it("carries the bucket's own visibility through a size-only change", async () => {
    getBucket.mockResolvedValue(bucket({ public: true }));
    await ensureBucketExists("recordings", { fileSizeLimit: 5368709120 });
    // A size change must never flip a bucket public or private as a side effect.
    expect(updateBucket).toHaveBeenCalledWith(
      "recordings",
      expect.objectContaining({ public: true }),
    );
  });

  it("does not fail the caller when the bucket cannot be widened", async () => {
    getBucket.mockResolvedValue(bucket());
    updateBucket.mockResolvedValue({
      error: { message: "exceeds plan limit" },
    });
    // The Free plan clamps objects to 50MB whatever the bucket says; a bucket
    // that cannot be widened is still a usable bucket.
    await expect(
      ensureBucketExists("recordings", { fileSizeLimit: 5368709120 }),
    ).resolves.toBe(true);
  });
});
