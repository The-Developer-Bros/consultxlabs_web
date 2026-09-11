/**
 * Shared splitter for the `-- SPLIT`-delimited sidecar SQL files.
 *
 * `prisma db push` does not manage triggers or CHECK constraints, so three
 * scripts under this directory replay `prisma/sql/*.sql` after every push (see
 * `db:sidecars`). Prisma's `$executeRawUnsafe` runs one statement per call
 * (extended protocol), so each file is chunked on `-- SPLIT` markers. All three
 * had the same splitter copy-pasted; it lives here now so the next fix lands
 * once.
 */

/**
 * Is this chunk nothing but SQL comment lines?
 *
 * Replaces `/^(--.*\n?)*$/`, which SonarCloud flags as `typescript:S5852`
 * (super-linear backtracking) — the only CRITICAL security finding on `dev`
 * and the reason the branch's `new_security_rating` sat at 4.
 *
 * The flag is a heuristic, and here it is a false alarm. S5852 fires on the
 * shape — a quantified group whose body matches a variable span — but this
 * body cannot actually overlap itself: `.` never crosses a newline, so every
 * iteration is line-bounded and the engine has no ambiguous partition to
 * explore. Measured against six adversarial shapes (20k near-miss lines, a
 * 300k-char single line, alternating blanks), the old regex never exceeded
 * 1ms. There was no live denial of service to fix, and nobody should "re-fix"
 * this later believing there was.
 *
 * It is replaced anyway because clearing the gate is worth more than the
 * regex, and because these files are load-bearing: they recreate the money-path
 * invariants on a fresh database, so the splitter should be one nobody has to
 * squint at.
 *
 * Semantics match the old regex on LF input, including the two edge cases a
 * first pass got wrong (#1307 review): `""` is true, because the old regex's
 * `*` permitted zero iterations, and a trailing whitespace-only line is false,
 * because a space is not `--`.
 *
 * ONE deliberate divergence, on the non-`\n` terminators. `.` in the old regex
 * matched neither `\r` nor `\u2028`/`\u2029`, so `"-- a\r\n"` came back false —
 * "not all comments" for a chunk that is nothing but a comment — and the caller
 * handed a bare comment to `$executeRawUnsafe`. This returns true there, which
 * is a fix rather than a regression.
 *
 * Splitting on every terminator, not just `\n`, is the point (#1307 review).
 * CRLF was already fine either way — `"-- a\r"` still starts with `--`. The
 * case that was not fine is a terminator that is NOT `\n` at all: a lone CR or
 * a U+2028 leaves the statement glued to the comment above it on a single
 * "line" beginning `--`, so the whole chunk reads as comment-only and is
 * silently dropped, losing a trigger or CHECK constraint on a fresh database.
 * Lone-CR SQL is essentially extinct, so this is hardening rather than an
 * incident — but the failure is silent and lands on a money path.
 *
 * Pinned by `__tests__/db/sidecar-sql-splitter.test.ts`, which keeps the old
 * regex as an oracle, asserts agreement across every chunk of all three real
 * files plus the adversarial and degenerate inputs, and asserts the CRLF
 * divergence explicitly so it cannot be "corrected" back by accident.
 */
export function isOnlyComments(chunk: string): boolean {
  // Every JS line terminator, not just \n — otherwise a statement separated
  // from its comment by a lone CR or U+2028 stays on one `--` line and the
  // chunk is dropped as comment-only. See the docblock.
  const lines = chunk.split(/\r\n|[\n\r\u2028\u2029]/);
  // A trailing terminator yields one empty final element, which is exactly what
  // the old `\n?` permitted. Everything else — a blank line, a whitespace-only
  // line — is not a comment line and makes this false, as it did before.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.every((line) => line.startsWith("--"));
}

/** Chunk a sidecar SQL file into individually executable statements. */
export function splitSqlStatements(raw: string): string[] {
  return raw
    .split(/^--\s*SPLIT\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !isOnlyComments(s));
}
