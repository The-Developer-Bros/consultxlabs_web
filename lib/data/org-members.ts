/**
 * Shared read for the organization members list.
 *
 * Single source of truth for the members table the org Members page
 * renders. The org members server page calls this directly in its SSR
 * prefetch (queryKey ["org-members", orgId]) so hydration applies without
 * a fetch waterfall, and the payload matches the client useQuery shape.
 *
 * Returns a fully plain/JSON-safe object: the only non-scalar is the
 * membership `createdAt`, mapped to an ISO string here. The selected
 * relations (membership + user) are not money models, so no result
 * extension touches them and no inspect symbol is present — toPlain is
 * unnecessary.
 */

import type {
  MemberRole,
  MemberStatus,
  PayoutRecipient,
} from "@prisma/client";
import prisma from "@/lib/prisma";

export interface MemberRow {
  id: string;
  role: MemberRole;
  status: MemberStatus;
  // #729 — keep the hydrated shape byte-for-byte with the API payload (the
  // route returns it via `include`), so the edit dialog reads it pre-refetch.
  payoutRecipient: PayoutRecipient;
  createdAt: string;
  user: {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
  };
}

// #902 — the page size is shared from a client-safe module (schemas/) so both
// this server prefetch and the client component use the same value without
// pulling prisma into the client bundle.
export { ORG_MEMBERS_PER_PAGE } from "@/schemas/organizations";
import { ORG_MEMBERS_PER_PAGE } from "@/schemas/organizations";

/**
 * #902 — the prefetch and the client query must produce the SAME cache entry:
 * the client keys `["org-members", orgId, q, page]` and expects `{members,total}`
 * (the members API's search + pagination). Mirror that here so the server
 * prefetch under `["org-members", orgId, "", 1]` hydrates without a fetch.
 */
export async function getOrgMembers(
  orgId: string,
  opts: { q?: string; page?: number; perPage?: number } = {},
): Promise<{ members: MemberRow[]; total: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const perPage = Math.min(100, Math.max(1, opts.perPage ?? ORG_MEMBERS_PER_PAGE));
  const q = opts.q?.trim() || undefined;

  const where = {
    organizationId: orgId,
    ...(q && {
      user: {
        OR: [
          { name: { contains: q, mode: "insensitive" as const } },
          { email: { contains: q, mode: "insensitive" as const } },
        ],
      },
    }),
  };

  const [total, rows] = await prisma.$transaction([
    prisma.membership.count({ where }),
    prisma.membership.findMany({
      where,
      select: {
        id: true,
        role: true,
        status: true,
        payoutRecipient: true,
        createdAt: true,
        user: { select: { id: true, name: true, email: true, image: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ]);

  return {
    total,
    members: rows.map((r) => ({
      id: r.id,
      role: r.role,
      status: r.status,
      payoutRecipient: r.payoutRecipient,
      createdAt: r.createdAt.toISOString(),
      user: r.user,
    })),
  };
}
