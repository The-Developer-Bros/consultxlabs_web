/**
 * #1122 — `compiler.removeConsole: true` deleted every server-side diagnostic
 * from the deployed function, because SWC applies the transform to the server
 * layer as well as the client and Next offers no client-only scoping. It was
 * unnoticeable for months: the code compiles, `next dev` prints normally, and
 * production simply says nothing.
 *
 * That failure mode is exactly what makes it likely to be "simplified" back to a
 * bare `true` in a later cleanup, so the exclude list is pinned here. This reads
 * the config as SOURCE rather than importing it — `next.config.mjs` uses
 * top-level await and wraps its export in `withSentryConfig`, so importing it
 * under Jest would drag in the Sentry webpack plugin to assert one literal. Same
 * technique as __tests__/explore/isr-routes-never-fail-open.test.ts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(
  path.join(process.cwd(), "next.config.mjs"),
  "utf8",
);

// The `compiler: { ... }` block, isolated so a `removeConsole` mentioned in a
// comment elsewhere in the file cannot satisfy or break these assertions.
const compilerBlock = /compiler:\s*\{([\s\S]*?)\n\s{2}\},/.exec(src)?.[1] ?? "";

describe("#1122 — removeConsole must not strip server diagnostics", () => {
  it("finds the compiler block it is supposed to be guarding", () => {
    // Guards against the regex silently matching nothing and passing vacuously.
    expect(compilerBlock).toMatch(/removeConsole/);
  });

  it("never assigns removeConsole a bare boolean true", () => {
    expect(compilerBlock).not.toMatch(/removeConsole\s*:\s*true/);
    // The original bug's exact shape: `removeConsole: <NODE_ENV check>` with no
    // exclude list, which evaluates to `true` in production.
    expect(compilerBlock).not.toMatch(
      /removeConsole\s*:\s*process\.env\.NODE_ENV\s*===\s*"production"\s*,/,
    );
  });

  it("excludes both error and warn so deliberate diagnostics survive", () => {
    const exclude = /exclude:\s*\[([^\]]*)\]/.exec(compilerBlock)?.[1];
    expect(exclude).toBeDefined();
    expect(exclude).toMatch(/"error"/);
    expect(exclude).toMatch(/"warn"/);
  });

  it("still strips console.log, which is the bundle saving the option is for", () => {
    const exclude = /exclude:\s*\[([^\]]*)\]/.exec(compilerBlock)?.[1] ?? "";
    expect(exclude).not.toMatch(/"log"/);
  });
});
