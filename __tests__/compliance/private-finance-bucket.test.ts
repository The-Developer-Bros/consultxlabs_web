/**
 * @jest-environment node
 */

/**
 * #1354 — the `org-invoices` bucket had never been created on the live Supabase
 * project, so the quarterly TDS return export died with `Bucket not found` and
 * the org invoice PDF route carried the same latent failure. These pins hold
 * the three properties the fix depends on: it creates the bucket only when it
 * is genuinely missing, it no-ops when the bucket is already there, and every
 * upload goes through the check so no writer can reintroduce the outage.
 */

const mockGetBucket = jest.fn();
const mockCreateBucket = jest.fn();
const mockUpload = jest.fn();

// Relative, not `@/`: jest.mock does not resolve the tsconfig alias here, so an
// aliased specifier registers against a path the module under test never loads.
jest.mock("../../lib/supabase-storage-core", () => ({
  supabaseAdmin: {
    storage: {
      getBucket: (...a: unknown[]) => mockGetBucket(...a),
      createBucket: (...a: unknown[]) => mockCreateBucket(...a),
      from: () => ({ upload: (...a: unknown[]) => mockUpload(...a) }),
    },
  },
}));

/** The memo lives at module scope, so each case needs a fresh module registry. */
async function freshModule() {
  jest.resetModules();
  return import("../../lib/storage/private-finance-object");
}

beforeEach(() => {
  mockGetBucket.mockReset();
  mockCreateBucket
    .mockReset()
    .mockResolvedValue({ data: { name: "org-invoices" } });
  mockUpload.mockReset().mockResolvedValue({ error: null });
});

describe("ensurePrivateFinanceBucket", () => {
  it("creates the bucket private, once, when getBucket reports it missing", async () => {
    mockGetBucket.mockResolvedValue({
      data: null,
      error: { message: "not found" },
    });
    const { ensurePrivateFinanceBucket } = await freshModule();

    await ensurePrivateFinanceBucket();
    await ensurePrivateFinanceBucket();

    expect(mockCreateBucket).toHaveBeenCalledTimes(1);
    expect(mockCreateBucket).toHaveBeenCalledWith("org-invoices", {
      public: false,
      fileSizeLimit: 25 * 1024 * 1024,
    });
    // Memoized: the second call skips the existence round trip entirely.
    expect(mockGetBucket).toHaveBeenCalledTimes(1);
  });

  it("no-ops when the bucket already exists", async () => {
    mockGetBucket.mockResolvedValue({
      data: { name: "org-invoices" },
      error: null,
    });
    const { ensurePrivateFinanceBucket } = await freshModule();

    await ensurePrivateFinanceBucket();
    await ensurePrivateFinanceBucket();

    expect(mockCreateBucket).not.toHaveBeenCalled();
    expect(mockGetBucket).toHaveBeenCalledTimes(1);
  });

  it("treats a lost create race as success, since the bucket now exists", async () => {
    mockGetBucket
      .mockResolvedValueOnce({ data: null, error: { message: "not found" } })
      .mockResolvedValueOnce({ data: { name: "org-invoices" }, error: null });
    mockCreateBucket.mockResolvedValue({ error: { message: "Duplicate" } });
    const { ensurePrivateFinanceBucket } = await freshModule();

    await expect(ensurePrivateFinanceBucket()).resolves.toBeUndefined();
  });

  it("does not memoize a rejection, so a transient failure is retried", async () => {
    mockGetBucket.mockResolvedValue({
      data: null,
      error: { message: "not found" },
    });
    mockCreateBucket
      .mockResolvedValueOnce({ error: { message: "boom" } })
      .mockResolvedValueOnce({ data: { name: "org-invoices" } });
    const { ensurePrivateFinanceBucket } = await freshModule();

    await expect(ensurePrivateFinanceBucket()).rejects.toThrow(
      /Failed to create bucket org-invoices/,
    );
    await expect(ensurePrivateFinanceBucket()).resolves.toBeUndefined();
  });
});

describe("uploadPrivateFinanceObject", () => {
  it("provisions the bucket before writing", async () => {
    const order: string[] = [];
    mockGetBucket.mockImplementation(() => {
      order.push("getBucket");
      return Promise.resolve({ data: null, error: { message: "not found" } });
    });
    mockCreateBucket.mockImplementation(() => {
      order.push("createBucket");
      return Promise.resolve({ data: { name: "org-invoices" } });
    });
    mockUpload.mockImplementation(() => {
      order.push("upload");
      return Promise.resolve({ error: null });
    });
    const { uploadPrivateFinanceObject } = await freshModule();

    await uploadPrivateFinanceObject({
      storagePath: "compliance/tds/2026-27-Q2.csv",
      body: Buffer.from("a,b\n"),
      contentType: "text/csv",
    });

    expect(order).toEqual(["getBucket", "createBucket", "upload"]);
  });
});
