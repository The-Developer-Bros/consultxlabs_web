/**
 * @jest-environment node
 */

/**
 * The operator user-detail modal's verification badge.
 *
 * It switched on "VERIFIED", "PENDING_VERIFICATION" and "UNDER_REVIEW". None of
 * those are `ProfileVerificationStatus` values — only "REJECTED" happened to
 * match — so an APPROVED, PENDING or NEEDS_INFO consultant all fell through to
 * the default and were reported to operators as "Not Submitted".
 *
 * That is the same defect class as the ₹NaN money drift: a hand-written client
 * literal claiming to mirror the schema, with nothing tying the two together.
 * `tsc` cannot help, because the field arrives as `string` across an untyped
 * fetch boundary and every string literal is a valid `case`.
 */

import { readFileSync } from "fs";
import { join } from "path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/** Labels declared by a Prisma enum block. */
function schemaEnumValues(name: string): string[] {
  const schema = read("prisma/schema.prisma");
  const start = schema.indexOf(`enum ${name} {`);
  expect(start).toBeGreaterThan(-1);
  const block = schema.slice(start, schema.indexOf("\n}", start));
  return block
    .split("\n")
    .slice(1)
    .map((l) => l.replace(/\/\/.*$/, "").trim())
    .filter((l) => /^[A-Z_]+$/.test(l));
}

describe("the verification badge switches on real ProfileVerificationStatus values", () => {
  const MODAL = "components/admin/UserDetailModal.tsx";

  /** Cases inside getVerificationStatusBadge only, not the role switch below it. */
  function badgeCases(): string[] {
    const src = read(MODAL);
    const start = src.indexOf("const getVerificationStatusBadge");
    expect(start).toBeGreaterThan(-1);
    // The function ends at the next top-level `const ` declaration.
    const end = src.indexOf("\nconst ", start + 1);
    const block = src.slice(start, end === -1 ? undefined : end);
    return Array.from(block.matchAll(/case "([A-Z_]+)":/g)).map((m) => m[1]);
  }

  it("every case is a value the schema declares", () => {
    const valid = schemaEnumValues("ProfileVerificationStatus");
    const cases = badgeCases();

    expect(cases.length).toBeGreaterThan(0);
    const unknown = cases.filter((c) => !valid.includes(c));
    // An unknown case is dead code, and its real status silently takes the
    // default branch — which here asserts the consultant never submitted.
    expect(unknown).toEqual([]);
  });

  it("covers every status the schema can produce", () => {
    const valid = schemaEnumValues("ProfileVerificationStatus");
    const cases = badgeCases();

    // A missing case is not cosmetic: the default renders "Not Submitted",
    // so an uncovered status makes a false claim rather than an vague one.
    expect(valid.filter((v) => !cases.includes(v))).toEqual([]);
  });

  it("the default branch still exists for a consultant with no submission", () => {
    // `verificationStatus` is nullable, and null genuinely means not submitted.
    expect(read(MODAL)).toContain("Not Submitted");
  });
});
