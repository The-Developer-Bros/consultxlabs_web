/**
 * Narrows a caller-supplied `?returnTo=` hop to a path on this site.
 *
 * `startsWith("/")` plus a "not // or /\" lookahead is not enough. The URL
 * parser deletes tab, LF and CR from anywhere in the input and treats `\` as
 * `/`, so `/<TAB>\evil.example` passes any leading-character test and still
 * resolves to https://evil.example. Next.js also hands back `string[]` when a
 * query key repeats, and a non-string coerces to a comma-joined string under a
 * regex test — so the type has to be checked, not assumed.
 *
 * Parsing against a sentinel origin is what actually decides it: whatever the
 * browser would do to the string has already been done by the time the origin
 * is compared, and only the part that stayed on the sentinel is handed back.
 */
const SENTINEL_ORIGIN = "https://return-to.invalid";

export function safeReturnTo(
  raw: string | string[] | undefined,
  fallback: string,
): string {
  // Site-relative only: a bare "dashboard/x" would resolve against the
  // sentinel root and look safe, but it is not the documented contract.
  if (typeof raw !== "string" || !raw.startsWith("/")) return fallback;

  let parsed: URL;
  try {
    parsed = new URL(raw, SENTINEL_ORIGIN);
  } catch {
    return fallback;
  }
  if (parsed.origin !== SENTINEL_ORIGIN) return fallback;

  // Re-serialized from the parse, never echoed raw, so the value that reaches
  // router.push() is the normalized one that was actually checked.
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
