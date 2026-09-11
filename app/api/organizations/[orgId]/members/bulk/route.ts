/**
 * Explicit 405 stub for `/api/organizations/[orgId]/members/bulk`.
 *
 * Bulk member operations (multi-remove, multi-role-change, CSV import)
 * are intentionally NOT supported in v1. The single-member PATCH
 * endpoint at `/api/organizations/[orgId]/members/[memberId]` is the
 * only sanctioned mutation surface — that route runs the last-OWNER
 * anti-lockout guard inside a Serializable transaction, and a bulk
 * operation would either need to replicate that guard per-row (slow,
 * inconsistent) or skip it (lockout risk).
 *
 * Returning a deterministic 405 here closes the door on a future
 * accidental implementation that bypasses the lockout invariant.
 * docs/enterprise/40-compliance-and-data/02-deletion-policy.md is the source of truth.
 */

import { NextResponse } from "next/server";

// Build a fresh Response per call. A Web Response body is one-shot —
// returning a single shared `NextResponse.json(...)` instance from
// multiple handlers (or for multiple concurrent requests on the same
// method) means the second consumer hits "Body has already been read".
// The factory keeps each request isolated.
const notSupported = () =>
  NextResponse.json(
    {
      error: "BULK_REMOVAL_NOT_SUPPORTED",
      message:
        "Bulk member operations are not supported. Use PATCH /api/organizations/<orgId>/members/<memberId> per member; the single-member route enforces the anti-lockout guard.",
    },
    { status: 405, headers: { Allow: "" } },
  );

export const GET = () => notSupported();
export const POST = () => notSupported();
export const PUT = () => notSupported();
export const PATCH = () => notSupported();
export const DELETE = () => notSupported();
