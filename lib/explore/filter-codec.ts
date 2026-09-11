/**
 * Shared URL <-> filter-state codec for the explore surfaces.
 *
 * Generalised out of app/explore/experts/utils.ts, which was the only surface
 * with bookmarkable filters. Two behaviours from that implementation are load-
 * bearing and preserved here:
 *
 *   1. Multi-value filters use REPEATED params (?tags=a&tags=b), never a
 *      comma-joined string — a literal comma inside a tag/company/industry name
 *      would otherwise split one value into two bogus filter terms.
 *   2. `0` is a legitimate numeric filter value (the price slider's "Free"
 *      state writes minPrice=0&maxPrice=0), so numbers are parsed with an
 *      explicit null check rather than `|| undefined`.
 */

export interface ReadonlyParams {
  get(name: string): string | null;
  getAll(name: string): string[];
}

export function parseIntegerParam(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function parseNumberParam(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function parseBooleanParam(raw: string | null): boolean {
  return raw === "true" || raw === "1";
}

/** Narrow a raw param to a known option, falling back when unrecognised. */
export function parseEnumParam<T extends string>(
  raw: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  return raw !== null && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : fallback;
}

/** Same, but for a nullable filter with no default selection. */
export function parseNullableEnumParam<T extends string>(
  raw: string | null,
  allowed: readonly T[],
): T | null {
  return raw !== null && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : null;
}

/** Repeated params, filtered to the known option set. */
export function parseEnumListParam<T extends string>(
  raws: string[],
  allowed: readonly T[],
): T[] {
  return raws.filter((raw): raw is T =>
    (allowed as readonly string[]).includes(raw),
  );
}

/**
 * Append a multi-value filter as repeated params. No-op when empty so default
 * state produces a clean URL.
 */
export function appendList(
  params: URLSearchParams,
  key: string,
  values: readonly string[],
): void {
  for (const value of values) params.append(key, value);
}

/** Set a param only when the value differs from its default. */
export function setIfChanged<T>(
  params: URLSearchParams,
  key: string,
  value: T,
  defaultValue: T,
): void {
  if (value === defaultValue) return;
  if (value === undefined || value === null || value === "") return;
  params.set(key, String(value));
}
