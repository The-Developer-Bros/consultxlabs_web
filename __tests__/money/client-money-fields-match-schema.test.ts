/**
 * The back-office refunds and disputes tables rendered a literal "₹NaN".
 *
 * `Refund` and `Dispute` both store money in a column called `amountPaise`,
 * and the money Prisma extension computes that column to a Number still in
 * paise. The hand-written client interfaces declared `amount` instead — a
 * field no payload has ever carried — so every row formatted `undefined`.
 *
 * The refunds page compounded it by passing the value to
 * `formatCurrencyFromMajorUnit`, which expects rupees. Had `amount` existed in
 * paise, that table would have shown every refund at 100× its true value,
 * which is the worse failure: ₹NaN is obviously broken, ₹2,50,000 where the
 * truth is ₹2,500 is not.
 *
 * These interfaces are hand-written rather than generated, so `tsc` cannot
 * catch the drift — it happily typechecks a lie about the payload. This test
 * is the thing that does, by reading the schema and the interfaces and
 * requiring them to name the same field.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const SCHEMA = read("prisma/schema.prisma");

/** The money column a Prisma model actually declares. */
function schemaMoneyField(model: string): string {
  const block = SCHEMA.slice(
    SCHEMA.indexOf(`model ${model} {`),
    SCHEMA.indexOf("\n}", SCHEMA.indexOf(`model ${model} {`)),
  );
  const match = block.match(/^\s+(amount|amountPaise)\s+BigInt/m);
  expect(match).not.toBeNull();
  return match![1];
}

/** The money field a hand-written TS interface declares. */
function interfaceMoneyField(src: string, name: string): string {
  const start = src.indexOf(`export interface ${name} {`);
  expect(start).toBeGreaterThan(-1);
  const block = src.slice(start, src.indexOf("\n}", start));
  const match = block.match(/^\s+(amount|amountPaise)(\?)?:\s*number/m);
  expect(match).not.toBeNull();
  return match![1];
}

describe("client money interfaces name the field the schema declares", () => {
  it.each([
    ["Refund", "types/payments.ts", "Refund"],
    // The admin dashboard's Recent Refunds list had the same defect and this
    // test did not cover it, so it shipped the same literal "₹NaN" to the
    // operator home page. Covering every hand-written interface over a money
    // model is the point; covering some of them is how this recurred.
    ["Refund", "types/payments.ts", "RecentRefund"],
    // The shared payment-detail view (admin + staff) had it in both of its
    // money lists at once, which is what "£NaN" under Refunds AND Disputes on
    // one screen looks like. Its API used a bare `include`, so the payload
    // carried whatever the model declared and nothing typechecked the gap.
    ["Refund", "types/payments.ts", "PaymentDetailRefund"],
    ["Dispute", "types/payments.ts", "PaymentDetailDispute"],
    // Dormant when found — nothing renders the ticket's linked refund yet — so
    // this was a primed "₹NaN" rather than a live one. Covered because the
    // whole point is to catch these before someone wires up the JSX.
    ["Refund", "types/tickets.ts", "LinkedRefund"],
    ["Dispute", "types/disputes.ts", "Dispute"],
    ["Dispute", "types/disputes.ts", "DisputeDetails"],
    // The `Payment`-backed interfaces. These are correct today and cost
    // nothing to hold in place; `RecentRefund` was correct once too. Their
    // model declares a bare `amount`, so they also stop an over-eager rename
    // sweep from "fixing" them into `amountPaise`.
    ["Payment", "types/payments.ts", "Payment"],
    ["Payment", "types/payments.ts", "RecentPayment"],
    ["Payment", "types/payments.ts", "PaymentDetail"],
    ["Payment", "types/tickets.ts", "LinkedPayment"],
    ["Payment", "types/subscriptions.ts", "SubscriptionListItem"],
    ["ConsultantPayout", "types/payouts.ts", "Payout"],
  ])("%s (schema) matches %s → %s", (model, file, iface) => {
    expect(interfaceMoneyField(read(file), iface)).toBe(
      schemaMoneyField(model),
    );
  });

  it("Payment really does declare a bare `amount`, so its readers stay correct", () => {
    // Guards against an over-eager sweep renaming every money field to
    // `*Paise`: the invoices and subscriptions tables read Payment.amount and
    // are correct today.
    expect(schemaMoneyField("Payment")).toBe("amount");
  });
});

describe("paise values reach a paise formatter", () => {
  const PAISE_PAGES = [
    "components/dashboard/shared/RefundsPage.tsx",
    "components/dashboard/shared/DisputesPage.tsx",
    "components/dashboard/shared/DisputeDetailPage.tsx",
  ];

  it.each(PAISE_PAGES)("%s renders the amountPaise field", (rel) => {
    const src = read(rel);
    expect(src).toMatch(/format\w*\(\s*(refund|dispute)\.amountPaise/);
  });

  it("no product code calls the major-unit formatter at all", () => {
    // This assertion used to name one page and one variable
    // (`formatCurrencyFromMajorUnit(refund`), which is why it did not notice
    // the collaborator cards passing `WebinarPlan.price` / `ClassPlan.price`
    // — BigInt paise, selected raw — to the rupee formatter and displaying a
    // ₹500 plan as ₹50,000, to the collaborator deciding whether to accept a
    // revenue share on it.
    //
    // Every money column in this schema is in the smallest unit, so there is
    // no longer any correct caller: the deprecated formatter is dead code and
    // the honest guard is repo-wide rather than per-page. If a genuine
    // major-unit value ever appears (raw user input before conversion),
    // convert at the boundary instead of relaxing this.
    // `git grep` exits 1 on no matches, which is the passing case here, so the
    // throw has to be read as "clean" rather than allowed to fail the test.
    let offenders = "";
    try {
      offenders = execFileSync(
        "git",
        [
          "grep",
          "-lF",
          "formatCurrencyFromMajorUnit(",
          "--",
          "app",
          "components",
          "lib",
        ],
        {
          encoding: "utf8",
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "pipe"],
        },
      ).trim();
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 1) throw err; // a real git failure, not "no matches"
    }
    expect(offenders).toBe("");
  });

  it("the admin home page formats its paise aggregates instead of printing them raw", () => {
    // These are `sumPaise(...)` totals — plain numbers in paise. They used to
    // be interpolated straight into a template literal, so the operator home
    // page read "264768347 total value" where the truth is ₹26,47,683.47.
    //
    // That is the more dangerous half of this bug class: ₹NaN is obviously
    // broken and gets reported, whereas a plausible-looking number that is
    // 100x off gets believed and acted on.
    const src = read("app/dashboard/admin/home/AdminHomePageClient.tsx");
    for (const field of [
      "totalPaymentsValue",
      "pendingPaymentsValue",
      "totalRefundsValue",
    ]) {
      expect(src).toMatch(
        new RegExp(`formatCurrencyAmount\\(\\s*stats\\?\\.${field}`),
      );
      // and never bare-interpolated
      expect(src).not.toMatch(new RegExp(`\\$\\{stats\\?\\.${field}`));
    }
  });
});
