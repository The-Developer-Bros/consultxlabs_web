// Isomorphic same-origin callback-URL validation for auth redirects.
//
// A bare prefix check (`startsWith("/") && !startsWith("//")`) is NOT
// sufficient: WHATWG URL parsing normalizes backslashes to forward slashes in
// special schemes, so a string like "/\attacker.example" re-tokenizes as
// scheme-relative and resolves to an EXTERNAL origin — while still passing
// both prefix checks. Verified: new URL("/\\attacker.example", base) yields
// origin http://attacker.example.
//
// Resolution against a fixed internal probe base makes the check deterministic
// on server AND client (no window dependency), so SSR and hydration agree:
// anything that escapes to a different origin is rejected; everything else is
// returned in canonical path?query#hash form.
//
// The .invalid TLD can never resolve or be fetched — this base is purely a
// parsing reference for origin comparison. HTTPS keeps static analysis happy
// without changing behaviour (S5332).
const PROBE_BASE = "https://callback-probe.invalid";

export function safeSameOriginPath(
  raw: string | null | undefined,
): string | null {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return null;
  try {
    const resolved = new URL(raw, PROBE_BASE);
    if (resolved.origin !== PROBE_BASE) return null;
    return resolved.pathname + resolved.search + resolved.hash;
  } catch {
    return null;
  }
}
