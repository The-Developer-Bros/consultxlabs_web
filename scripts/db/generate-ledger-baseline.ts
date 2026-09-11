/**
 * Regenerate lib/payments/ledger/baseline.ts from the latest reconciler report.
 *
 * The baseline excuses known, entity-specific drift so the nightly reconciler
 * is red only for NEW problems. Its entries must therefore come from findings
 * the reconciler actually produced — never from ids typed by hand, which is how
 * a baseline drifts into excusing things nobody looked at.
 *
 * Usage:  npm run ledger:baseline -- --expires 2026-10-31 --reason "seed artifact"
 *
 * Review the diff before committing. Every entry you keep is a finding you are
 * choosing not to be paged about until the expiry date.
 */
import fs from "node:fs";
import path from "node:path";

import prisma from "../../lib/prisma";
import { findingIdentity } from "../../lib/payments/ledger/baseline";

const OUT = path.join(
  __dirname,
  "..",
  "..",
  "lib",
  "payments",
  "ledger",
  "baseline.ts",
);

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const expires = arg("expires", "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
    console.error(
      "Refusing to generate a baseline without an explicit --expires YYYY-MM-DD.\n" +
        "An entry without an expiry is a permanently disabled check.",
    );
    process.exitCode = 1;
    return;
  }
  const reason = arg(
    "reason",
    "known drift — see the report this was generated from",
  );

  const report = await prisma.ledgerReconciliationReport.findFirst({
    where: { scope: "full" },
    orderBy: { runAt: "desc" },
    select: { id: true, runAt: true, findings: true },
  });

  if (!report) {
    console.error("No reconciler report found — run the reconciler first.");
    process.exitCode = 1;
    return;
  }

  const findings = (report.findings ?? []) as Array<
    Parameters<typeof findingIdentity>[0]
  >;

  // Dedupe by identity: one entry per (kind, entity), regardless of how many
  // times the run reported it.
  const seen = new Map<string, { kind: string; entityId: string }>();
  for (const f of findings) {
    const identity = findingIdentity(f);
    const [kind, ...rest] = identity.split(":");
    const entityId = rest.join(":");
    if (!entityId) continue; // un-keyable finding: never baseline it
    if (!seen.has(identity)) seen.set(identity, { kind, entityId });
  }

  const entries = Array.from(seen.values()).sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) || a.entityId.localeCompare(b.entityId),
  );

  const source = fs.readFileSync(OUT, "utf8");
  const marker = "export const LEDGER_BASELINE: BaselineEntry[] = [";
  const start = source.indexOf(marker);
  const end = source.indexOf("];", start);
  if (start === -1 || end === -1) {
    console.error(
      "Could not find LEDGER_BASELINE in baseline.ts — has it moved?",
    );
    process.exitCode = 1;
    return;
  }

  const body = entries
    .map(
      (e) =>
        `  {\n    kind: "${e.kind}",\n    entityId: "${e.entityId}",\n    reason: ${JSON.stringify(reason)},\n    expires: "${expires}",\n  },`,
    )
    .join("\n");

  const next =
    source.slice(0, start + marker.length) +
    (entries.length > 0 ? `\n${body}\n` : "") +
    source.slice(end);

  fs.writeFileSync(OUT, next);
  console.log(
    `Wrote ${entries.length} baseline entr(ies) from report ${report.id} (${report.runAt.toISOString()}), expiring ${expires}.`,
  );
  console.log(
    "Review the diff — each entry is an alert you are switching off.",
  );
}

main()
  .catch((err) => {
    console.error("generate-ledger-baseline failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
