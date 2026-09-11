/**
 * @jest-environment node
 */

/**
 * PM-34 (#677) — a failed refund-earning cascade must surface as failure.
 *
 * The cron used to exit green (exit 0 / HTTP 200) even when
 * result.success === false, so the monitor never paged while SUCCEEDED
 * refunds sat un-cascaded. Pins the shared decision helper and the wiring
 * at both consumers (GH Actions entry + HTTP shim).
 *
 * The wiring asserts are source-level (same pattern as
 * __tests__/security/audit-1132-security.test.ts) because the consumers'
 * import chains drag prisma + the Redis-backed cron lock into any direct
 * require — the leaf helper module exists precisely so the decision itself
 * stays unit-testable without them.
 */

import fs from "node:fs";
import path from "node:path";

import { cascadeRunFailed } from "@/scripts/refunds/cascade-run-outcome";

const ROOT = path.join(__dirname, "..", "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("PM-34 — cascade failure decision helper", () => {
  it("success=false → failed (page)", () => {
    expect(cascadeRunFailed({ success: false })).toBe(true);
  });

  it("success=true → not failed", () => {
    expect(cascadeRunFailed({ success: true })).toBe(false);
  });
});

describe("PM-34 — both consumers translate a failed run into their failure signal", () => {
  it("GH Actions entry exits non-zero via process.exitCode (never process.exit)", () => {
    const jobSrc = read("jobs/refunds/cascade-refund-earnings.ts");

    expect(jobSrc).toMatch(/if \(cascadeRunFailed\(result\)\)/);
    expect(jobSrc).toMatch(/process\.exitCode = 1;/);
    // Statement-level: a bare process.exit() would kill the Sentry flush.
    expect(jobSrc).not.toMatch(/^\s*process\.exit\(/m);
  });

  it("HTTP shim returns non-2xx on a failed run", () => {
    // #1319 — the shim is now the shared cleanupRoute factory; the route only
    // supplies the status callback, not the response wiring itself.
    const routeSrc = read("app/api/cleanup/cascade-refund-earnings/route.ts");

    expect(routeSrc).toMatch(
      /status:\s*\(result\)\s*=>\s*\(?\s*cascadeRunFailed\(result\)\s*\?\s*500\s*:\s*200/,
    );
  });
});
