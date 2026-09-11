"use client";

/**
 * Operator dashboard home — the canonical place to land after creating
 * an organisation. Replaces the prior 1-org-auto-redirect chooser stub
 * AND the old /dashboard/organization switcher list.
 *
 * What you see:
 *   1. Stats row — orgs you own, active members across them, outstanding
 *      INR across all your billing accounts.
 *   2. Org grid — every org you operate, capability + funding + role
 *      badges, click to enter that org's dashboard.
 *   3. "+ New organization" CTA — opens the create wizard inside this
 *      same dashboard chrome at /create.
 *
 * Design intent: this is a *cross-org* surface. Per-org operator views
 * (members, programs, billing) live one click deeper at
 * /dashboard/organization/[orgId]/*. The two layers don't overlap.
 *
 * Client half of the split page. The server `page.tsx` SSR-prefetches
 * the org list + billing roll-up into the React Query cache and hands
 * hydration down; the `useQuery`/`useWorkspaceBilling` calls below read
 * from that cache verbatim (matching query keys) and refetch client-side.
 */

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Building2, Plus, Users, Wallet } from "lucide-react";
import type { FundingSource, MemberRole, OrgStatus } from "@prisma/client";

import {
  DashboardHeader,
  DashboardContent,
  DashboardGrid,
} from "@/components/dashboard/PageScaffold";
import { StatCard, StatCardSkeleton } from "@/components/dashboard/StatCard";
import { EmptyState, DataCardSkeleton } from "@/components/dashboard/DataCard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatCurrencyAmount } from "@/utils/formatting";
import {
  deriveCapabilityKind,
  CAPABILITY_LABEL,
  CAPABILITY_BADGE_CLASS,
  FUNDING_SOURCE_LABEL,
  FUNDING_SOURCE_BADGE_CLASS,
  MEMBER_ROLE_LABEL,
} from "@/lib/labels/org-labels";
import { useWorkspaceBilling } from "../hooks/useWorkspaceBilling";

interface OrgMembershipRow {
  membershipId: string;
  role: MemberRole;
  status: string;
  organization: {
    id: string;
    name: string;
    slug: string;
    logo: string | null;
    status: OrgStatus;
    canSponsor: boolean;
    canHost: boolean;
    billingAccount: {
      fundingSource: FundingSource;
      walletBalance: number | null;
      currency: string;
    } | null;
  };
}

async function fetchOrgs(): Promise<{ data: OrgMembershipRow[] }> {
  const res = await fetch("/api/organizations");
  if (!res.ok) throw new Error("Failed to load organizations");
  return res.json();
}

export function HomePageClient({ orgWorkspaceId }: { orgWorkspaceId: string }) {
  const orgs = useQuery({
    queryKey: ["org-workspace-orgs"],
    queryFn: fetchOrgs,
  });
  // Shared with the billing page under one query key — see useWorkspaceBilling.
  const rollup = useWorkspaceBilling(orgWorkspaceId);
  const summary = rollup.data?.summary;

  const rows = (orgs.data?.data ?? []).filter((r) => r.role === "OWNER");

  return (
    <>
      <DashboardHeader
        title="Operator dashboard"
        subtitle="Cross-org snapshot of the organisations you run"
        actions={
          <Link href={`/dashboard/org-workspace/${orgWorkspaceId}/create`}>
            <Button size="sm">
              <Plus className="h-4 w-4 mr-1" /> New organization
            </Button>
          </Link>
        }
      />
      <DashboardContent>
        {rollup.isError ? (
          <Card>
            <CardContent className="py-6">
              <EmptyState
                icon={Wallet}
                title="Couldn't load the billing roll-up"
                description="We hit an error fetching your cross-org totals."
                action={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => rollup.refetch()}
                  >
                    Retry
                  </Button>
                }
              />
            </CardContent>
          </Card>
        ) : (
          <DashboardGrid>
            {rollup.isLoading ? (
              <>
                <StatCardSkeleton />
                <StatCardSkeleton />
                <StatCardSkeleton />
              </>
            ) : (
              <>
                <StatCard
                  title="Organisations"
                  value={summary?.orgsOwned?.toString() ?? "0"}
                  icon={Building2}
                />
                <StatCard
                  title="Active members"
                  value={summary?.totalActiveMembers?.toLocaleString("en-IN") ?? "0"}
                  icon={Users}
                />
                <StatCard
                  title="Outstanding (INR)"
                  value={formatCurrencyAmount(
                    summary?.totalOutstandingPaise ?? 0,
                    "INR",
                  )}
                  icon={Wallet}
                  variant={
                    summary && summary.totalOutstandingPaise > 0
                      ? "warning"
                      : "default"
                  }
                />
              </>
            )}
          </DashboardGrid>
        )}

        <section className="mt-6">
          <h2 className="text-lg font-medium mb-3">Your organisations</h2>
          {orgs.isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <DataCardSkeleton />
              <DataCardSkeleton />
              <DataCardSkeleton />
            </div>
          ) : orgs.isError ? (
            <Card>
              <CardContent className="py-10">
                <EmptyState
                  icon={Building2}
                  title="Couldn't load your organisations"
                  description="We hit an error fetching your org list. Check your connection and try again."
                  action={
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => orgs.refetch()}
                    >
                      Retry
                    </Button>
                  }
                />
              </CardContent>
            </Card>
          ) : rows.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {rows.map((row) => {
                const org = row.organization;
                const kind = deriveCapabilityKind(org.canSponsor, org.canHost);
                const funding = org.billingAccount?.fundingSource ?? null;
                return (
                  <Link
                    key={row.membershipId}
                    href={`/dashboard/organization/${org.id}/home`}
                    className="group"
                  >
                    <Card className="h-full hover:border-zinc-400 transition-colors">
                      <CardHeader>
                        <div className="flex items-center gap-3">
                          <Avatar className="h-10 w-10 rounded-lg">
                            <AvatarImage
                              src={org.logo ?? undefined}
                              alt={org.name}
                              className="object-cover"
                            />
                            <AvatarFallback className="rounded-lg bg-zinc-100 text-zinc-500">
                              <Building2 className="h-5 w-5" />
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <CardTitle className="truncate text-base">
                              {org.name}
                            </CardTitle>
                            <CardDescription className="text-xs">
                              {org.slug}
                            </CardDescription>
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="flex flex-wrap gap-2">
                        <Badge
                          variant="secondary"
                          className={CAPABILITY_BADGE_CLASS[kind]}
                        >
                          {CAPABILITY_LABEL[kind]}
                        </Badge>
                        {funding && (
                          <Badge
                            variant="outline"
                            className={FUNDING_SOURCE_BADGE_CLASS[funding]}
                          >
                            {FUNDING_SOURCE_LABEL[funding]}
                          </Badge>
                        )}
                        <Badge>{MEMBER_ROLE_LABEL[row.role]}</Badge>
                      </CardContent>
                    </Card>
                  </Link>
                );
              })}
            </div>
          ) : (
            <Card>
              <CardContent className="py-10 text-center">
                <Building2 className="w-10 h-10 mx-auto mb-3 text-zinc-400" />
                <p className="text-sm text-zinc-600">
                  You don&apos;t own any organisations yet.
                </p>
                <Link href={`/dashboard/org-workspace/${orgWorkspaceId}/create`}>
                  <Button size="sm" className="mt-4">
                    Create your first organisation
                  </Button>
                </Link>
              </CardContent>
            </Card>
          )}
        </section>
      </DashboardContent>
    </>
  );
}
