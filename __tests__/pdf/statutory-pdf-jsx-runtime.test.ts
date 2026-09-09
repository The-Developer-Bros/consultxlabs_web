/**
 * @jest-environment node
 *
 * #1468 — the statutory PDFs must create their elements with the same React
 * that `@react-pdf/reconciler` loads, because that package picks one of three
 * bundled reconcilers by reading `React.version` and each one recognises only
 * its own era's element stamp. On the deployed build the renderer is an
 * external package resolved by Node while route-handler code is compiled
 * against Next's vendored React, and the two disagreed: every invoice PDF
 * answered 500 with React error #31.
 *
 * Jest cannot reproduce that split — it has exactly one React — so these
 * assertions pin the two halves that survive into the bundle: the runtime the
 * components compile against, and the fact that Next's vendored React is a
 * genuinely different stamp rather than an interchangeable one.
 */
import fs from "node:fs";
import path from "node:path";

import { nodeRequire } from "@/lib/pdf/react-runtime/node-require";
import * as pdfJsxRuntime from "@/lib/pdf/react-runtime/jsx-runtime";

/** The `react` that `@react-pdf/reconciler` resolves at runtime. */
function reconcilerJsxRuntime(): typeof import("react/jsx-runtime") {
  const reconcilerDir = path.dirname(
    require.resolve("@react-pdf/reconciler/package.json"),
  );
  return nodeRequire(
    require.resolve("react/jsx-runtime", { paths: [reconcilerDir] }),
  ) as typeof import("react/jsx-runtime");
}

describe("statutory PDF JSX runtime", () => {
  it("stamps elements the way the reconciler's React does", () => {
    const expected = reconcilerJsxRuntime().jsx("div", {});
    const actual = pdfJsxRuntime.jsx("div", {});

    expect(actual.$$typeof).toBe(expected.$$typeof);
    expect(pdfJsxRuntime.Fragment).toBe(reconcilerJsxRuntime().Fragment);
  });

  it("does not stamp elements the way Next's vendored React does", () => {
    const vendored = nodeRequire(
      "next/dist/compiled/react/jsx-runtime",
    ) as typeof import("react/jsx-runtime");

    expect(vendored.jsx("div", {}).$$typeof).not.toBe(
      pdfJsxRuntime.jsx("div", {}).$$typeof,
    );
  });

  it("compiles every react-pdf component file against that runtime", () => {
    const dir = path.join(process.cwd(), "lib", "pdf");
    const componentFiles = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => path.join(dir, f))
      .filter((f) =>
        fs.readFileSync(f, "utf8").includes("@react-pdf/renderer"),
      );

    expect(componentFiles.length).toBeGreaterThan(0);
    for (const file of componentFiles) {
      expect(fs.readFileSync(file, "utf8")).toContain(
        "@jsxImportSource @/lib/pdf/react-runtime",
      );
    }
  });
});
