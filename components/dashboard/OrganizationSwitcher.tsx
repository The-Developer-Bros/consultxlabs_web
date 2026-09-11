"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { Building2, Plus, ChevronDown, Check, User } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSession } from "@/lib/auth-client";
import {
  deriveCapabilityKind,
  CAPABILITY_LABEL,
  CAPABILITY_BADGE_CLASS,
  MEMBER_ROLE_LABEL,
} from "@/lib/labels/org-labels";
import {
  resolvePersonalDashboardHref,
  resolvePersonalDashboardFacets,
} from "@/lib/labels/personal-dashboard";

/**
 * Context switcher rendered in the consultant/consultee navbar and the
 * admin/staff layouts. Reads `session.user.organizationMemberships`
 * populated by the customSession callback in lib/auth.ts.
 *
 * Acts as a true context selector: a "Personal" entry (when the user has
 * a personal dashboard) plus each organization, with the ACTIVE context
 * derived from the current route and marked with a check. Self-hides for
 * users with no org memberships so the navbar stays unchanged for B2C
 * users (nothing to switch between).
 */
export function OrganizationSwitcher() {
  const { data: session } = useSession();
  const pathname = usePathname();
  const memberships = session?.user?.organizationMemberships ?? [];
  const isOrgWorkspace = session?.user?.role === "ORG_WORKSPACE";

  // ORG_WORKSPACE users always see the switcher (they need "Create or manage"
  // access). Other roles only see it when they have at least one org.
  if (memberships.length === 0 && !isOrgWorkspace) {
    return null;
  }

  // "Personal" is only offered when the user actually has a personal
  // dashboard — an org-only learner/operator won't (resolver returns null).
  const personalHref = session?.user
    ? resolvePersonalDashboardHref(session.user)
    : null;
  // A user who both delivers and consumes has MORE than one personal facet
  // (consultant + consultee). Offer each so they can act on either side.
  const personalFacets = session?.user
    ? resolvePersonalDashboardFacets(session.user)
    : [];

  // Active context from the route: an org dashboard pins to its orgId;
  // anything else is the personal context.
  const activeOrgId =
    pathname?.match(/^\/dashboard\/organization\/([^/]+)/)?.[1] ?? null;
  const activeOrg = activeOrgId
    ? memberships.find((m) => m.organizationId === activeOrgId)
    : undefined;
  const isPersonalActive = !activeOrgId;
  // Only frame the trigger as "Personal" on a non-org route where the user
  // actually has a personal dashboard. Otherwise fall back to the org
  // framing — covers org-only users (no personalHref) and org routes that
  // aren't in memberships (e.g. /dashboard/organization/create, or an
  // admin/staff viewing an org they don't belong to).
  const showPersonal = isPersonalActive && !!personalHref;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-9 gap-2 text-zinc-700 hover:text-zinc-900"
        >
          {showPersonal ? (
            <User className="h-4 w-4" />
          ) : (
            <Building2 className="h-4 w-4" />
          )}
          <span className="hidden max-w-[12rem] truncate sm:inline">
            {activeOrg
              ? activeOrg.organizationName
              : showPersonal
                ? "Personal"
                : "Organizations"}
          </span>
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Switch dashboard</DropdownMenuLabel>
        <DropdownMenuSeparator />

        {personalFacets.length > 0 && (
          <>
            {personalFacets.map((facet) => {
              // Per-facet active detection — a dual-profile user can be on
              // their consultant OR consultee home; only tick the current one.
              const facetActive =
                isPersonalActive &&
                pathname?.startsWith(
                  facet.kind === "org-workspace"
                    ? "/dashboard/org-workspace/"
                    : facet.kind === "consultant"
                      ? "/dashboard/consultant/"
                      : "/dashboard/consultee/",
                );
              return (
                <DropdownMenuItem asChild key={facet.kind}>
                  <Link
                    href={facet.href}
                    className="flex cursor-pointer items-center gap-3"
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-zinc-100">
                      <User className="h-4 w-4 text-zinc-500" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-zinc-900">
                        {personalFacets.length > 1 ? facet.label : "Personal"}
                      </p>
                      <p className="text-[11px] text-zinc-500">
                        Your own dashboard
                      </p>
                    </div>
                    {facetActive && (
                      <Check className="h-4 w-4 shrink-0 text-zinc-900" />
                    )}
                  </Link>
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
          </>
        )}

        {memberships.length > 0 && (
          <DropdownMenuLabel className="text-xs font-normal text-zinc-500">
            Organizations
          </DropdownMenuLabel>
        )}
        {memberships.map((m) => {
          const capability = deriveCapabilityKind(m.canSponsor, m.canHost);
          const isActive = m.organizationId === activeOrgId;
          return (
            <DropdownMenuItem key={m.organizationId} asChild>
              <Link
                href={`/dashboard/organization/${m.organizationId}/home`}
                className="flex cursor-pointer items-center gap-3"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-zinc-100">
                  {m.organizationLogo ? (
                    <Image
                      src={m.organizationLogo}
                      alt={m.organizationName}
                      width={32}
                      height={32}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <Building2 className="h-4 w-4 text-zinc-500" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-zinc-900">
                    {m.organizationName}
                  </p>
                  <div className="mt-0.5 flex items-center gap-1">
                    <Badge
                      variant="secondary"
                      className={`h-4 px-1 text-[10px] ${CAPABILITY_BADGE_CLASS[capability]}`}
                    >
                      {CAPABILITY_LABEL[capability]}
                    </Badge>
                    <Badge variant="outline" className="h-4 px-1 text-[10px]">
                      {MEMBER_ROLE_LABEL[m.role]}
                    </Badge>
                  </div>
                </div>
                {isActive && (
                  <Check className="h-4 w-4 shrink-0 text-zinc-900" />
                )}
              </Link>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link
            href="/dashboard/organization"
            className="flex cursor-pointer items-center gap-2 text-sm text-zinc-700"
          >
            <Plus className="h-4 w-4" />
            Create or manage organizations
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
