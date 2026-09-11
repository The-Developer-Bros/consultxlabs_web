/**
 * #780 CI guard — money columns must be BigInt, never Int. An Int money
 * column silently overflows at ₹2.14cr (int4). Heuristic: any field whose
 * name reads as a money amount, declared Int, fails the build. Counts,
 * basis points, and credit units are excluded by name; genuinely dual-unit
 * fields are allowlisted explicitly.
 */
import fs from "fs";
import path from "path";

const schemaPath = path.join(__dirname, "..", "..", "prisma", "schema.prisma");
const schema = fs.readFileSync(schemaPath, "utf8");

// Dual-unit or deliberately-Int fields that match the money heuristic.
const ALLOWLIST = new Set<string>([
  "DiscountCode.discountValue", // percent OR paise depending on discountType
]);

const MONEY_NAME =
  /(Paise|paise)$|^(amount|originalAmount|taxAmount|netAmount|grossAmount|price|walletBalance|creditLimit|maxDiscount|totalEarned|tdsDeducted|cumulativeAmountCredited|referrerReward|refereeReward|referrerRewardAmount|refereeRewardAmount|usedAmount|remainingAmount|restoredAmount)$/;

const offenders: string[] = [];
const modelRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
let m: RegExpExecArray | null;
while ((m = modelRe.exec(schema))) {
  const [, model, body] = m;
  const fieldRe = /^\s*(\w+)\s+Int\??(?:\s|$)/gm;
  let f: RegExpExecArray | null;
  while ((f = fieldRe.exec(body))) {
    const field = f[1];
    if (!MONEY_NAME.test(field)) continue;
    if (ALLOWLIST.has(`${model}.${field}`)) continue;
    offenders.push(`${model}.${field}`);
  }
}

if (offenders.length > 0) {
  console.error(
    `#780 violation — money columns declared Int (must be BigInt + added to the lib/prisma.ts extension map):\n` +
      offenders.map((o) => `  - ${o}`).join("\n"),
  );
  process.exit(1);
}
console.log("check-money-columns: ok (no Int money columns)");
