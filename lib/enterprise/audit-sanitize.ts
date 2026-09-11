/**
 * Read-side scrub for OrgAuditLog rows before they reach an org-visible
 * surface. The audit list endpoint, CSV exporter, and any other path
 * that surfaces audit rows to org members should pipe the description
 * through this helper.
 *
 * Why a read-side guard alongside the write-side discipline (sanitize
 * at the call site): defense in depth. The schema doesn't enforce
 * "description is human prose" and many call sites exist. A read-side
 * sanitizer catches:
 *   - legacy rows already written before the fix
 *   - any future regression where a developer interpolates a raw error
 *   - third-party / cron writes we didn't anticipate
 *
 * Engineering-facing internals (Prisma error syntax, stack frames, JSON
 * dumps) get redacted to a stable placeholder. The audit row itself
 * stays on the table for compliance — only the user-visible projection
 * gets sanitized.
 *
 * For the engineering-facing version of the same event, use the
 * `SystemEvent` table (admin-only). See `lib/enterprise/system-events.ts`.
 */

// Patterns considered "engineering noise" that should never reach an
// org member. Each entry is a (label, RegExp) tuple; matches replace
// the line with a redaction marker.
const ENGINEERING_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  // Prisma-style argument enumerations leak the entire schema.
  // Matches "Invalid `prisma.*.findUnique()` invocation" or any
  // surfaced ProgramWhereInput-style schema names.
  {
    label: "Prisma error",
    pattern: /Invalid\s+`prisma\.[a-zA-Z]+\.[a-zA-Z]+\(\)`\s+invocation/i,
  },
  {
    label: "Prisma schema",
    pattern: /\b[A-Z][a-zA-Z]*(?:WhereInput|ScalarFilter|RelationFilter|UpdateInput|CreateInput|OrderByInput|UncheckedCreateInput)\b/,
  },
  // Node stack frames.
  { label: "stack trace", pattern: /\bat\s+[^\s]+\s+\(.*:\d+:\d+\)/ },
  { label: "stack trace", pattern: /node:internal\//i },
  // Bare JSON blobs in the description — `details` is the right home.
  { label: "JSON payload", pattern: /\{\s*"[^"]+"\s*:\s*"[^"]{40,}"/ },
];

const REDACTION = "[redacted — engineering details available to platform admins only]";

/**
 * Sanitize a single audit-log description string. Returns the original
 * if no engineering patterns matched; otherwise returns a stable
 * redacted form. Idempotent — calling twice is the same as once.
 *
 * The first sentence (up to the first colon or newline) is preserved
 * when it appears to be safe prose, so a description like
 * "Data export bundle failed: <prisma stack>" becomes
 * "Data export bundle failed: [redacted — …]" rather than losing
 * the user-meaningful prefix entirely.
 */
export function sanitizeAuditDescription(description: string): string {
  if (!description) return description;
  // If no engineering pattern matches, the string is safe as-is.
  const matched = ENGINEERING_PATTERNS.some(({ pattern }) =>
    pattern.test(description),
  );
  if (!matched) return description;

  // Try to keep the lead "Header: " prefix from prose like
  // "Data export bundle failed: <noise>" so the user still knows what
  // kind of event this was. We split on the first colon and check
  // that the prefix itself is clean prose.
  const firstColon = description.indexOf(":");
  if (firstColon > 0 && firstColon < 80) {
    const prefix = description.slice(0, firstColon).trim();
    const prefixHasEngineering = ENGINEERING_PATTERNS.some(({ pattern }) =>
      pattern.test(prefix),
    );
    if (!prefixHasEngineering) {
      return `${prefix}: ${REDACTION}`;
    }
  }

  return REDACTION;
}

/**
 * Sanitize the `details` JSON payload. Strips known engineering-noise
 * keys (`error`, `stack`, `prismaError`) so the org-visible projection
 * carries only safe context fields like {invoiceId, programId, poNumber}.
 *
 * The same row in the system_events table keeps the full original
 * payload for engineering use.
 */
export function sanitizeAuditDetails(
  details: unknown,
): Record<string, unknown> | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return null;
  }
  const SENSITIVE_KEYS = new Set([
    "error",
    "stack",
    "prismaError",
    "errorStack",
    "rawError",
  ]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}
