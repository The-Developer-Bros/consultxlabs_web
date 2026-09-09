/**
 * #705 / #1319 — the one parser for "which objects do the sidecars promise?".
 *
 * `scripts/db/assert-sidecar-applied.ts` (the post-push assertion) and
 * `scripts/ci/check-db-sidecars.ts` (the CI guard) both read this, so a
 * regression test guards the script instead of a copy of it. Two parsers used
 * to exist: the CI one was quote-aware and saw triggers and non-unique
 * indexes across all three .sql files, the local one saw only unique indexes
 * in check-constraints.sql and stripped comments by line prefix. They could
 * disagree about what "applied" meant; now they cannot.
 *
 * Staged-for-the-reset objects are commented out, so stripping comments is
 * what excludes them. Splitting on the STAGED banner did NOT — active SQL sat
 * below it, which is how `appointment_doc_thread_version_unique` and
 * `onboarding_draft_payload_size` went unasserted.
 */

import fs from "node:fs";
import path from "node:path";

export type SidecarObjectKind = "constraint" | "index" | "trigger";

export interface SidecarObject {
  kind: SidecarObjectKind;
  name: string;
  table?: string;
  /** File name inside prisma/sql, e.g. check-constraints.sql. */
  source: string;
}

/** Index just past the closing quote of a single-quoted literal opened at `i`. */
function scanSingleQuoted(sql: string, i: number): number {
  let j = i + 1;
  while (j < sql.length && sql[j] !== "'") j++;
  return Math.min(j + 1, sql.length);
}

/** Index just past the closing tag of a dollar-quoted body opened at `i`. */
function scanDollarQuoted(sql: string, i: number, tag: string): number {
  const close = sql.indexOf(tag, i + tag.length);
  return close === -1 ? sql.length : close + tag.length;
}

/**
 * Index just past the end of a block comment opened at `i`. Block comments
 * NEST in Postgres, unlike C, so scanning to the first close is wrong.
 */
function scanBlockComment(sql: string, i: number): number {
  let depth = 1;
  let j = i + 2;
  while (j < sql.length && depth > 0) {
    if (sql.startsWith("/*", j)) {
      depth++;
      j += 2;
    } else if (sql.startsWith("*/", j)) {
      depth--;
      j += 2;
    } else {
      j++;
    }
  }
  return j;
}

/**
 * Strip SQL comments before matching. Quote-aware: a `--` inside a string
 * literal is data, and trigger bodies live in dollar-quoted blocks that
 * routinely contain `--`. A comment becomes a SPACE, never nothing: Postgres
 * treats comments as whitespace, so one can legally separate two tokens.
 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;

  while (i < sql.length) {
    const dollar = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
    if (dollar) {
      const end = scanDollarQuoted(sql, i, dollar[0]);
      out += sql.slice(i, end);
      i = end;
    } else if (sql[i] === "'") {
      const end = scanSingleQuoted(sql, i);
      out += sql.slice(i, end);
      i = end;
    } else if (sql.startsWith("--", i)) {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
    } else if (sql.startsWith("/*", i)) {
      i = scanBlockComment(sql, i);
      out += " ";
    } else {
      out += sql[i++];
    }
  }
  return out;
}

/** Every declared object in one sidecar file's text. */
export function parseSidecarSql(sql: string, source: string): SidecarObject[] {
  const active = stripSqlComments(sql);
  const out: SidecarObject[] = [];
  for (const m of active.matchAll(
    /ALTER\s+TABLE\s+"?(\w+)"?\s+ADD\s+CONSTRAINT\s+"?([A-Za-z0-9_]+)"?/gi,
  )) {
    out.push({ kind: "constraint", table: m[1], name: m[2], source });
  }
  for (const m of active.matchAll(
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?/gi,
  )) {
    out.push({ kind: "index", name: m[1], source });
  }
  for (const m of active.matchAll(
    /CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+(\w+)/gi,
  )) {
    out.push({ kind: "trigger", name: m[1], source });
  }
  return out;
}

/** Every declared object across every .sql file in a sidecar directory. */
export function parseSidecarDirectory(dir: string): SidecarObject[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((file) =>
      parseSidecarSql(fs.readFileSync(path.join(dir, file), "utf8"), file),
    );
}

export interface SidecarObjects {
  constraints: string[];
  indexes: string[];
}

/**
 * Back-compat shape used by the idempotency test: constraint names plus
 * UNIQUE index names from one file's text. Thin wrapper over parseSidecarSql.
 */
export function parseSidecarObjects(sql: string): SidecarObjects {
  const active = stripSqlComments(sql);
  return {
    constraints: parseSidecarSql(sql, "inline")
      .filter((o) => o.kind === "constraint")
      .map((o) => o.name),
    indexes: [
      ...active.matchAll(
        /CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?/gi,
      ),
    ].map((m) => m[1]),
  };
}
