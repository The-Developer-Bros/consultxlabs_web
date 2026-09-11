/**
 * GET /api/org-workspace/[orgWorkspaceId]/activity
 *
 * Cross-org audit feed for an OrgWorkspace. Aggregates `OrgAuditLog` rows
 * from every org where the caller has an ACTIVE OWNER membership and
 * stitches them into a single timeline. Distinct from the per-org
 * /audit endpoint which scopes to one org and supports rich filters.
 * This one is intentionally simpler: latest-first, no filtering, used
 * to drive a "what changed across my portfolio in the last week"
 * widget.
 *
 * Pagination: cursor on `(createdAt DESC, id DESC)`. The
 * `@@index([organizationId, createdAt])` covers the per-org slice;
 * Postgres composes them via the `IN` clause without a new index.
 *
 * Auth: same IDOR posture as /billing — orgWorkspaceId in URL must match
 * the caller's `orgWorkspaceProfileId`.
 *
 * Returns enriched rows: each row carries the orgName + actor's display
 * name so the UI doesn't need a follow-up join.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireApiAuth } from "@/lib/auth-helpers";
import { getWorkspaceActivity } from "@/lib/data/org-workspace";

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgWorkspaceId: string }> },
) {
  const { orgWorkspaceId } = await params;
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;

  // `orgWorkspaceProfileId` is part of the customSession-augmented user
  // type (lib/auth.ts:522) — direct access is type-safe.
  if (auth.session.user.orgWorkspaceProfileId !== orgWorkspaceId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse(
    Object.fromEntries(url.searchParams.entries()),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const q = parsed.data;

  // Body extracted to lib/data/org-workspace so the activity page's SSR
  // prefetchInfiniteQuery reads through the same code path. The feed is
  // scoped to the orgs the caller OWNS (not the workspace id).
  const result = await getWorkspaceActivity(
    auth.session.user.id,
    q.cursor ?? null,
    q.limit,
  );
  return NextResponse.json(result);
}
