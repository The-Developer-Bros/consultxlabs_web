/**
 * @jest-environment node
 */

/**
 * #1280 — `check-db-sidecars` parses declared objects out of the sidecar SQL by
 * regex, so what the comment stripper hands it decides what the guard checks.
 *
 * Two failure directions, both silent:
 *   - keep a comment and the guard demands objects nobody agreed to create
 *     (this is what it did: the commented-out PROPOSED constraints in
 *     check-constraints.sql counted as required, three phantoms out of four)
 *   - mangle real SQL and the guard stops seeing an object that IS declared,
 *     passing because it has stopped looking
 */

import { stripSqlComments } from "../../scripts/ci/check-db-sidecars";

const CONSTRAINT_RE =
  /ALTER\s+TABLE\s+"(\w+)"\s+ADD\s+CONSTRAINT\s+"([^"]+)"/gi;
const INDEX_RE =
  /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/gi;

const names = (sql: string, re: RegExp) =>
  [...stripSqlComments(sql).matchAll(re)].map((m) => m[m.length - 1]);

describe("stripSqlComments", () => {
  it("drops a commented-out proposal so the guard does not demand it", () => {
    const sql = `--    ALTER TABLE "ProgramAssignment" ADD CONSTRAINT "proposed_only"
ALTER TABLE "Real" ADD CONSTRAINT "really_declared" CHECK (x > 0);`;
    expect(names(sql, CONSTRAINT_RE)).toEqual(["really_declared"]);
  });

  it("leaves a block comment as WHITESPACE, not as nothing", () => {
    // Postgres treats a comment as whitespace, so it can be the ONLY separator
    // between two tokens. Removing it outright merged them and the object
    // vanished from the guard's view.
    const sql = `CREATE/* note */INDEX "idx_between_tokens" ON "T" (a);`;
    expect(names(sql, INDEX_RE)).toEqual(["idx_between_tokens"]);
  });

  it("handles nested block comments, which Postgres allows and C does not", () => {
    const sql = `/* outer /* inner */ still outer */
CREATE UNIQUE INDEX "idx_after_nested" ON "T" (a);`;
    expect(names(sql, INDEX_RE)).toEqual(["idx_after_nested"]);
  });

  it("does not treat a -- inside a string literal as a comment", () => {
    const sql = `ALTER TABLE "T" ADD CONSTRAINT "keeps_literal" CHECK (note <> 'a -- b');
ALTER TABLE "U" ADD CONSTRAINT "after_literal" CHECK (x > 0);`;
    expect(names(sql, CONSTRAINT_RE)).toEqual([
      "keeps_literal",
      "after_literal",
    ]);
  });

  it("leaves dollar-quoted trigger bodies intact", () => {
    // Trigger functions live in $$ ... $$ and routinely contain `--`. Stripping
    // inside them would swallow the rest of the body and every object after it.
    const sql = `CREATE FUNCTION f() RETURNS trigger AS $$
BEGIN
  -- this is inside the body
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE INDEX "idx_after_dollar_body" ON "T" (a);`;
    expect(names(sql, INDEX_RE)).toEqual(["idx_after_dollar_body"]);
  });

  it("survives an unterminated block comment without hanging", () => {
    const sql = `CREATE INDEX "before_unterminated" ON "T" (a);\n/* never closed`;
    expect(names(sql, INDEX_RE)).toEqual(["before_unterminated"]);
  });
});
