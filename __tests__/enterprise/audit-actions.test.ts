/**
 * @jest-environment node
 */

/**
 * Issue #699 ENT-4: audit-log action label sweep.
 *
 * The constants in `lib/enterprise/audit-actions.ts` are the source of
 * truth for OrgAuditLog.action strings. Free-form strings at call sites
 * defeat the convention (no autocomplete, drift over time).
 *
 * This test grep-asserts every `tx.orgAuditLog.create({ ..., action: "X" })`
 * and `prisma.orgAuditLog.create({ ..., action: "X" })` site under
 * app/api/organizations/, jobs/, and scripts/cleanup/ uses an
 * AUDIT_ACTIONS constant.
 *
 * If a new event genuinely needs a new label, add it to AUDIT_ACTIONS
 * first, then reference the constant at the call site. Don't add a
 * literal here — the test will fail.
 */

import { execSync } from "child_process";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function rg(pattern: string, paths: string[]): string {
  // Use grep -rEn so we get file:line:body and ERE alternation.
  // The -h flag is omitted intentionally — we want filenames in output.
  try {
    return execSync(
      `grep -rEn ${JSON.stringify(pattern)} ${paths.map((p) => JSON.stringify(p)).join(" ")}`,
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
  } catch (err) {
    // grep returns non-zero on no-matches, which is the success case here.
    const status = (err as { status?: number }).status;
    if (status === 1) return "";
    throw err;
  }
}

describe("audit-log action label sweep", () => {
  it("no free-form action: \"...\" string under app/api/organizations/", () => {
    const matches = rg(
      'action:[[:space:]]*"[A-Z_]+"',
      ["app/api/organizations"],
    );
    // The audit-export endpoint is allowed to write its own action label
    // string because it self-audits via `AUDIT_ACTIONS.SETTINGS.AUDIT_LOG_EXPORTED`
    // which the grep matches as a constant access — it shouldn't show up.
    expect(matches).toBe("");
  });

  it("no free-form action: \"...\" string under jobs/ or scripts/cleanup/", () => {
    const matches = rg(
      'action:[[:space:]]*"[A-Z_]+"',
      ["jobs", "scripts/cleanup"],
    );
    expect(matches).toBe("");
  });
});
