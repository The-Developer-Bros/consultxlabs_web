/**
 * @jest-environment node
 */

/**
 * #1347 — a serialization abort used to cost an org a whole billing cycle.
 *
 * The rollup runs Serializable so two concurrent runs can't both issue an
 * invoice for the same accruals. The loser aborts with P2034, and the cron
 * treated every P2034 as a benign skip: "an overlapping run claimed this org".
 * That reading only holds when the rival was a same-org rollup. Postgres also
 * aborts on a read-write dependency with an unrelated writer touching Payment
 * or OverageEvent, and there the org simply went unbilled until the next
 * monthly run, with a console.log as its only trace.
 *
 * These pin the two halves of the fix: the abort is retried before it is
 * believed, and an exhausted retry is reported rather than swallowed.
 */

const mockTransaction = jest.fn();
const mockOrgFindUnique = jest.fn();
const mockPaymentFindMany = jest.fn();
const mockRecordSystemError = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (...a: unknown[]) => mockTransaction(...a),
    organization: { findUnique: (...a: unknown[]) => mockOrgFindUnique(...a) },
    payment: { findMany: (...a: unknown[]) => mockPaymentFindMany(...a) },
    $disconnect: jest.fn(),
  },
}));

jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: (...a: unknown[]) => mockRecordSystemError(...a),
}));

jest.mock("../../lib/maintenance-cron", () => ({
  abortIfMaintenance: jest.fn(),
}));

import { Prisma } from "@prisma/client";
import { rollupOrgInvoiceAccruals } from "@/lib/payments/billing/invoice-rollup";
import { settleInvoiceAccruals } from "@/jobs/billing/settle-invoice-accruals";

function p2034() {
  return new Prisma.PrismaClientKnownRequestError("write conflict", {
    code: "P2034",
    clientVersion: "test",
  });
}

function invoice(id: string) {
  return {
    invoiceId: id,
    invoiceNumber: `ACME/26-27/${id}`,
    billedPaymentCount: 2,
    subtotalPaise: 500000,
    totalPaise: 590000,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ENABLE_CONSOLIDATED_INVOICE;
  mockOrgFindUnique.mockResolvedValue({
    id: "org_1",
    slug: "acme",
    invoiceNumberPrefix: null,
    billingAccountId: "ba_1",
    dataResidencyRegion: "IN",
    paymentTermsDays: 30,
    taxInfo: null,
  });
});

describe("rollupOrgInvoiceAccruals — serialization retry", () => {
  it("retries a P2034 and issues exactly one invoice", async () => {
    // The first attempt loses the race; the second commits.
    mockTransaction
      .mockRejectedValueOnce(p2034())
      .mockResolvedValueOnce(invoice("inv_1"));

    const result = await rollupOrgInvoiceAccruals({ organizationId: "org_1" });

    expect(result.invoiceId).toBe("inv_1");
    // Two attempts, one committed invoice — a retry must not double-bill.
    expect(mockTransaction).toHaveBeenCalledTimes(2);
  });
});

describe("settleInvoiceAccruals — exhausted retries", () => {
  it("records a system error and still bills the next org", async () => {
    mockPaymentFindMany.mockResolvedValue([
      { organizationId: "org_contended" },
      { organizationId: "org_ok" },
    ]);
    // withSerializableRetry burns its four attempts on the first org, then the
    // second org commits on its first try.
    mockTransaction
      .mockRejectedValueOnce(p2034())
      .mockRejectedValueOnce(p2034())
      .mockRejectedValueOnce(p2034())
      .mockRejectedValueOnce(p2034())
      .mockResolvedValueOnce(invoice("inv_2"));

    const r = await settleInvoiceAccruals();

    expect(mockRecordSystemError).toHaveBeenCalledTimes(1);
    expect(mockRecordSystemError.mock.calls[0][0]).toMatchObject({
      organizationId: "org_contended",
      category: "INVOICE",
    });
    // The contended org is skipped, not fatal: the next org is still invoiced.
    expect(r.invoicesCreated).toBe(1);
  });
});
