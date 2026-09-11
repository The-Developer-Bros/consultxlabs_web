"use client";

/**
 * Cross-org audit feed. Operators with 3+ orgs need one place to see
 * "what changed across my portfolio in the last week" without clicking
 * into each org's /audit tab. Read-only timeline; per-org audit lives
 * at /dashboard/organization/[orgId]/audit and supports rich filters
 * for compliance review.
 *
 * Pagination: cursor-based, 50/page. The same Load-more pattern used
 * elsewhere in the codebase keeps the bundle lean (no infinite-scroll
 * libraries).
 *
 * Client half of the split page. The server `page.tsx` SSR-prefetches the
 * FIRST page (cursor=null) under ["org-workspace-activity", orgWorkspaceId]
 * via prefetchInfiniteQuery; the useInfiniteQuery below hydrates from that
 * cache and drives Load-more client-side.
 */

import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Activity as ActivityIcon, Building2 } from "lucide-react";

import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/dashboard/DataCard";
import { formatDistanceToNow } from "date-fns";

interface ActivityRow {
  id: string;
  organizationId: string;
  organizationName: string | null;
  organizationSlug: string | null;
  category: string;
  action: string;
  description: string;
  createdAt: string;
  actorName: string | null;
}

interface ActivityResponse {
  data: ActivityRow[];
  pagination: {
    hasMore: boolean;
    nextCursor: string | null;
    limit: number;
  };
}

async function fetchActivity(
  orgWorkspaceId: string,
  cursor: string | null,
): Promise<ActivityResponse> {
  const url = new URL(
    `/api/org-workspace/${orgWorkspaceId}/activity`,
    window.location.origin,
  );
  if (cursor) url.searchParams.set("cursor", cursor);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error("Failed to load activity");
  return res.json();
}

const CATEGORY_LABEL: Record<string, string> = {
  MEMBER: "Member",
  CONTRACT: "Contract",
  PROGRAM: "Program",
  WALLET: "Wallet",
  INVOICE: "Invoice",
  PAYOUT: "Payout",
  SETTINGS: "Settings",
  CONSENT: "Consent",
  CATALOG: "Catalog",
  SYSTEM: "System",
};

function timeAgo(iso: string): string {
  const date = new Date(iso);
  // Guard a malformed timestamp — formatDistanceToNow throws a RangeError on an
  // Invalid Date instead of degrading gracefully.
  if (Number.isNaN(date.getTime())) return "—";
  // Beyond 30 days a relative label ("2 months ago") loses the precision an
  // audit feed wants — fall back to an absolute date there.
  const days = (Date.now() - date.getTime()) / 86_400_000;
  if (days > 30) {
    return date.toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  }
  return formatDistanceToNow(date, { addSuffix: true });
}

export function ActivityPageClient({
  orgWorkspaceId,
}: {
  orgWorkspaceId: string;
}) {
  const query = useInfiniteQuery({
    queryKey: ["org-workspace-activity", orgWorkspaceId],
    queryFn: ({ pageParam }) =>
      fetchActivity(orgWorkspaceId, pageParam as string | null),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.pagination.hasMore ? lastPage.pagination.nextCursor : undefined,
  });

  const rows = query.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <>
      <DashboardHeader
        title="Activity"
        subtitle="Recent changes across all the organisations you operate"
      />
      <DashboardContent>
        {query.isLoading ? (
          <Card>
            <CardContent className="p-0">
              <ul className="divide-y">
                {[1, 2, 3, 4, 5].map((i) => (
                  <li key={i} className="p-4">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="mt-2 h-4 w-3/4" />
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : query.isError ? (
          <Card>
            <CardContent className="py-10">
              <EmptyState
                icon={ActivityIcon}
                title="Couldn't load activity"
                description="We hit an error fetching your cross-org activity feed."
                action={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => query.refetch()}
                  >
                    Retry
                  </Button>
                }
              />
            </CardContent>
          </Card>
        ) : rows.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center">
              <ActivityIcon className="w-10 h-10 mx-auto mb-3 text-zinc-400" />
              <p className="text-sm text-zinc-600">
                No activity yet. As your members invite, book, and bill,
                events will appear here.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <ul className="divide-y">
                {rows.map((r) => (
                  <li key={r.id} className="p-4 hover:bg-muted/30">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant="outline" className="font-mono">
                            {CATEGORY_LABEL[r.category] ?? r.category}
                          </Badge>
                          {r.organizationName && (
                            <Link
                              href={`/dashboard/organization/${r.organizationId}/audit`}
                              className="inline-flex items-center gap-1 hover:underline"
                            >
                              <Building2 className="w-3 h-3" />
                              {r.organizationName}
                            </Link>
                          )}
                          <span>· {timeAgo(r.createdAt)}</span>
                        </div>
                        <p className="text-sm mt-1">{r.description}</p>
                        {r.actorName && (
                          <p className="text-xs text-muted-foreground mt-1">
                            by {r.actorName}
                          </p>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {query.hasNextPage && (
          <div className="mt-4 flex justify-center">
            <Button
              variant="outline"
              onClick={() => query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
            >
              {query.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </DashboardContent>
    </>
  );
}
