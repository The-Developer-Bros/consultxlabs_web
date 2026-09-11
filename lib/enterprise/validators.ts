/**
 * Shared validators for enterprise API routes.
 *
 * These lived inline in multiple route handlers (domain-claims and the
 * SSO settings endpoint each had their own `DOMAIN_REGEX`; every list
 * endpoint parsed pagination params slightly differently). Centralising
 * them removes drift — tweak the regex here and every caller updates
 * together — and gives new endpoints a single import instead of
 * inventing their own schema.
 *
 * Keep this file purely declarative (no DB calls, no IO). Auth and
 * ownership checks live in `lib/auth-helpers`.
 */

import { z } from "zod";

/**
 * RFC 1035-ish domain regex. Lower-case alphanumeric labels separated by
 * dots, each 1–63 chars, hyphen allowed but not at the boundary. The `i`
 * flag keeps parity with the historical inline copies — callers should
 * `.toLowerCase()` before matching to canonicalise.
 *
 * Used by:
 *   - /api/organizations/[orgId]/domain-claims
 *   - /api/organizations/[orgId]/sso (allowedEmailDomains array)
 */
export const DOMAIN_REGEX =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * A single email domain as accepted by the enterprise APIs — trimmed,
 * lower-cased, and matched against {@link DOMAIN_REGEX}. Length capped
 * at 253 to align with the DNS label-length limit so validation catches
 * pathological input before it hits Prisma.
 */
export const DomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(253)
  .regex(DOMAIN_REGEX, "Invalid domain format");

/**
 * Shared `?page=&pageSize=` coercer for paginated list endpoints.
 *
 * Defaults match the convention already in use across the enterprise
 * routes (page=1, pageSize=20, capped at 100). Callers that want a
 * different page-size ceiling can clone via `.extend()` — we don't try
 * to make every knob configurable here because every divergence is a
 * signal that the UX on those lists probably differs too.
 */
export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

/**
 * Parse `?page=&pageSize=` off a request URL, returning 400 input as
 * the Zod defaults — callers that want strict parsing should use
 * `PaginationQuerySchema.safeParse` directly.
 */
export function parsePagination(url: URL): PaginationQuery {
  const raw = {
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
  };
  const result = PaginationQuerySchema.safeParse(raw);
  return result.success
    ? result.data
    : { page: 1, pageSize: 20 };
}
