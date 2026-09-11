"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import React, { use, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { usePrefetchNavPaths } from "@/hooks/usePrefetchNavPaths";
import {
  Home,
  Users,
  GraduationCap,
  Briefcase,
  CreditCard,
  BarChart3,
  ClipboardList,
  Settings,
  Wallet,
  UserCog,
  Building2,
  LayoutDashboard,
  Clock,
  FileText,
  CalendarCheck,
  MessageSquare,
  ClipboardCheck,
  Video,
  Receipt,
  ShieldCheck,
  ShieldAlert,
  Library,
  LifeBuoy,
  type LucideIcon,
} from "lucide-react";

// Mobile bottom-tab configuration — 5 most-accessed org pages. Gated by
// the same permission matrix as the desktop sidebar (a LEARNER previously
// saw all five and got redirected by four of them).
const MOBILE_TABS: {
  label: string;
  path: string;
  Icon: LucideIcon;
  surface?: OrgSurface;
  needsSponsor?: boolean;
}[] = [
  { label: "Overview", path: "home", Icon: Home },
  { label: "Members", path: "members", Icon: Users, surface: "members.read" },
  {
    label: "Billing",
    path: "billing",
    Icon: CreditCard,
    surface: "billing.read",
    needsSponsor: true,
  },
  {
    label: "Analytics",
    path: "analytics",
    Icon: BarChart3,
    surface: "operations.read",
  },
  {
    // No surface gate, matching the desktop entry (ADR 23). The Settings page
    // floors at active membership and each tab carries its own gate, so an
    // ordinary member reaches it for the Notifications tab and nothing else.
    // Gating only the desktop sidebar would have left mobile LEARNER/EXPERT
    // users with no route to their own notification preferences.
    label: "Settings",
    path: "settings",
    Icon: Settings,
  },
];

import {
  CollapsibleSidebar,
  CollapsibleSidebarSkeleton,
  type CollapsibleSidebarGroup,
} from "@/components/dashboard/CollapsibleSidebar";
import { DashboardContextBar } from "@/components/dashboard/DashboardContextBar";
import { LinkPendingIcon } from "@/components/ui/NavLink";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { useSession } from "@/lib/auth-client";
import { useNovuSubscriberSync } from "@/hooks/useNovuSubscriberSync";
import { signOutEverywhere } from "@/lib/auth/sign-out";
import { hasOrgPermission, type OrgSurface } from "@/lib/auth/org-permissions";
import {
  MEMBER_ROLE_LABEL,
  deriveCapabilityKind,
  CAPABILITY_LABEL,
  CAPABILITY_BADGE_CLASS,
  FUNDING_SOURCE_LABEL,
  FUNDING_SOURCE_BADGE_CLASS,
} from "@/lib/labels/org-labels";
import { resolvePersonalDashboardHref } from "@/lib/labels/personal-dashboard";
import type { OrgStatus } from "@prisma/client";
import {
  fetchOrgDetails,
  orgDetailsQueryKey,
} from "@/lib/api/organizations/org-details";

/**
 * Banner rendered across the org dashboard when `Organization.status !== ACTIVE`.
 * A newly created org sits in PENDING_VERIFICATION until a platform admin
 * runs the verify action. OWNER can still configure branding, draft programs,
 * and explore the product — but invitations, wallet top-ups, and contracts
 * are paused server-side. The banner explains why the write surfaces are
 * returning 409 ORG_NOT_VERIFIED.
 */
function OrgStatusBanner({ status }: { status: OrgStatus }) {
  const copy: Record<
    OrgStatus,
    { title: string; body: string; tone: string } | null
  > = {
    PENDING_VERIFICATION: {
      title: "Awaiting platform review",
      body: "You can set up branding and draft programs now. Inviting members and moving money unlocks as soon as an admin verifies your organization.",
      tone: "bg-amber-50 border-amber-200 text-amber-900",
    },
    SUSPENDED: {
      title: "Organization suspended",
      body: "Invitations and payments are paused. Contact support to restore access.",
      tone: "bg-rose-50 border-rose-200 text-rose-900",
    },
    ACTIVE: null,
    DEACTIVATED: {
      title: "Organization deactivated",
      body: "This organization is no longer operational.",
      tone: "bg-zinc-100 border-zinc-300 text-zinc-800",
    },
  };
  const message = copy[status];
  if (!message) return null;
  return (
    <div
      className={`border-b px-4 sm:px-6 py-2.5 flex items-start gap-3 text-sm ${message.tone}`}
    >
      <Clock className="w-4 h-4 mt-0.5 shrink-0" />
      <div className="flex-1">
        <span className="font-semibold">{message.title}.</span>{" "}
        <span>{message.body}</span>
      </div>
    </div>
  );
}

function AccessDenied({ title, message }: { title: string; message: string }) {
  return (
    <div className="flex items-center justify-center min-h-svh bg-zinc-100">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white p-8 rounded-2xl shadow-xl border border-zinc-200 max-w-md text-center"
      >
        <h2 className="text-xl font-bold text-zinc-900 mb-2">{title}</h2>
        <p className="text-zinc-600">{message}</p>
        <Link
          href="/dashboard/organization"
          className="inline-block mt-6 px-6 py-2.5 bg-zinc-900 text-white rounded-lg font-medium hover:bg-zinc-800 transition-colors"
        >
          Back to organizations
        </Link>
      </motion.div>
    </div>
  );
}

export default function OrgDashboardShell({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const pathname = usePathname();
  const router = useRouter();
  const { data: session, isPending: isSessionLoading } = useSession();

  // ADR 23 — the personal dashboards did this and the org tree did not, so a
  // user onboarded straight into an org by invite was never POSTed to
  // /api/novu/subscriber. Their Novu record stayed bare and any template
  // interpolating subscriber.firstName / email degraded.
  useNovuSubscriberSync();

  const {
    data: org,
    error,
    isLoading,
  } = useQuery({
    queryKey: orgDetailsQueryKey(orgId),
    queryFn: () => fetchOrgDetails(orgId),
    enabled: !!orgId && !!session?.user?.id,
    staleTime: 60_000,
  });

  // Compute grouped sidebar items from capabilities + fundingSource + role.
  // Visibility comes from the org permission matrix
  // (lib/auth/org-permissions.ts) — the SAME source the page guards and
  // API routes check, so a tab can't drift into "shown but rejected".
  // Capability gates (canSponsor/canHost/requiresPO/fundingSource) remain
  // separate structural conditions combined per item. Five clusters
  // (People / Commerce / Resources / Insights / Configuration) plus an
  // ungrouped Overview block; groups with zero remaining items drop out.

  // Idle-warm the RSC payloads for the highest-traffic tabs so the first
  // click doesn't pay a full RSC round trip after the Router Cache's 30s
  // dynamic window. Mirrors the MOBILE_TABS permission gates exactly — a
  // surface the sidebar hides is also not prefetched (prefetching it would
  // burn a full guarded render that ends in "forbidden"). Home is
  // universal for ACTIVE members. No-op until `org` resolves.
  const prefetchPaths = useMemo(() => {
    if (!org?.organization || org.organization.status !== "ACTIVE") return [];
    const base = `/dashboard/organization/${orgId}`;
    const can = (surface: OrgSurface) =>
      hasOrgPermission(org.membership.role, surface);
    const paths = [`${base}/home`, `${base}/appointments`];
    if (can("members.read")) paths.push(`${base}/members`);
    if (can("operations.read")) paths.push(`${base}/analytics`);
    if (can("billing.read") && org.organization.canSponsor)
      paths.push(`${base}/billing`);
    return paths;
  }, [org, orgId]);
  usePrefetchNavPaths(prefetchPaths);

  const sidebarGroups: CollapsibleSidebarGroup[] = useMemo(() => {
    if (!org) return [];
    const { canSponsor, canHost, fundingSource, requiresPO } = org.organization;
    const membership = org.membership;
    const role = membership.role;
    const can = (surface: OrgSurface) => hasOrgPermission(role, surface);

    // Resources group defaults collapsed for OWNER + MAINTAINER — their
    // primary job isn't document triage. Open by default for MANAGER +
    // SUPPORT who live in those tabs.
    const resourcesCollapsedDefault = role === "OWNER" || role === "MAINTAINER";

    type ItemSpec = {
      name: string;
      icon: LucideIcon;
      path: string;
      show?: boolean;
    };

    // Top (no label) — Overview + consumer-role landing pages. The
    // LEARNER / EXPERT cases are the only sidebar items those roles
    // ever see. Operators (MANAGER+) get the richer per-tab views.
    //
    // My Program stays separate from Commerce's Programs on purpose: they are
    // different objects, not two scopes of one. `my-program` is a LEARNER's
    // own assignment and coverage detail; `programs` is the sponsor's catalog
    // CRUD. Appointments was the only genuine same-object scope split, and it
    // is now one entry with a Mine/Everyone toggle.
    const topItems: ItemSpec[] = [
      { name: "Overview", icon: Home, path: "home" },
      {
        name: "My Program",
        icon: GraduationCap,
        path: "my-program",
        show: can("myProgram.read") && canSponsor,
      },
      {
        name: "Compensation",
        icon: UserCog,
        path: "compensation",
        show: can("myArrangement.read") && canHost,
      },
      {
        // Any ACTIVE member — learners who ATTEND org sessions and experts
        // who DELIVER them both need their own per-org appointments surface.
        // Deliberately NOT gated on canHost (that would exclude pure
        // learners): requireOrgAccess already floors this at active
        // membership, so show it to everyone who reaches the org dashboard.
        // Operators additionally get the "Everyone" scope inside the page.
        name: "Appointments",
        icon: CalendarCheck,
        path: "appointments",
      },
      {
        // Participant surface, same floor as Appointments. Chat is scoped to
        // this org purely by living on this route — `useOrgScope` pins under
        // /dashboard/organization/[orgId]/ — so a member of several orgs gets
        // one clean inbox per org with no picker.
        //
        // Not an operator surface: Stream only returns channels the viewer is a
        // member of, and there is no org-wide chat query behind it. ADR 20
        // keeps session content with the participants.
        name: "Messages",
        icon: MessageSquare,
        path: "messages",
      },
      {
        // Delivery surface: allocating slots is something only the person
        // delivering the session can do, so it shows for members who hold a
        // consultant profile. The page itself redirects anyone else — gating on
        // the profile rather than on MemberRole.EXPERT means an OWNER who also
        // delivers still gets it.
        name: "Requests",
        icon: ClipboardCheck,
        path: "requests",
        // The comment above described this gate for months but the code did
        // not implement it: `myArrangement.read` is exact-role EXPERT, so an
        // OWNER or MANAGER who also delivers got no nav entry even though the
        // page admits anyone holding a consultantProfileId. That is ADR 19's
        // "gate and page disagree" failure inverted — a reachable page with no
        // way to reach it. The profile is the real predicate; the role check
        // stays as the cheap path for the common EXPERT case.
        show:
          (can("myArrangement.read") || membership.consultantProfileId !== null) &&
          canHost,
      },
    ];

    // People — governance + roster surfaces (BILLING_ADMIN is
    // operator-blind; SUPPORT reads Members for ticket investigation).
    //
    // Learners, Experts and Invitations are tabs on Members rather than
    // sidebar entries: the first two were `?role=` filters on the very
    // endpoint Members already reads, and splitting one roster across four
    // nav slots made the group harder to scan than the data warranted.
    const peopleItems: ItemSpec[] = [
      {
        // members.read is the widest of the four tab grants
        // (OPERATIONS_READERS, vs GOVERNANCE for invitations and OPERATORS
        // for learners/experts), so it alone decides the nav entry.
        name: "Members",
        icon: Users,
        path: "members",
        show: can("members.read"),
      },
      {
        // #org-appts / #1025 — collaborators on THIS org's hosted webinar/class
        // plans. Mirrors Compensation's gate: only host-capable orgs have
        // collaborator-bearing plans, and inviting/managing collaborators is
        // the plan-owning EXPERT's own surface.
        name: "Collaborations",
        icon: Users,
        path: "collaborations",
        show: can("myArrangement.read") && canHost,
      },
    ];

    // Commerce — money + entitlement surfaces, ordered to match the
    // setup flow: Contract first (commercial frame), then optional PO
    // (India AP 3-way-match), then Programs (the entitlement the
    // contract authorizes), then Billing (the invoices that result).
    // Payouts + Reimbursements appear at the bottom for HOST orgs and
    // for SPONSOR+PERSONAL orgs respectively — they're money-OUT
    // outcomes, not setup. Mutation gates stay on the route handlers;
    // the sidebar entries are visibility-only.
    const commerceItems: ItemSpec[] = [
      {
        // Contract terms are org-structural (spec: MAINTAINER floor) —
        // the old `≥MAINTAINER || finance` expression showed a dead tab
        // to MANAGER + BILLING_ADMIN, whose page guard rejected them.
        name: "Contracts",
        icon: FileText,
        path: "contracts",
        show: canSponsor && can("contracts.read"),
      },
      {
        // Only orgs running India AP 3-way-match (requiresPO=true) need
        // the PO tab in their primary nav. The PO surface itself stays
        // reachable by URL for orgs that opt in later — this is sidebar
        // visibility, not authz. See docs/enterprise/30-programs-and-lifecycle/04-dashboard-pages.md.
        name: "Purchase Orders",
        icon: Receipt,
        path: "purchase-orders",
        show: canSponsor && requiresPO && can("purchaseOrders.read"),
      },
      {
        // What the org SELLS, above what it SPONSORS — the two are different
        // objects, not two scopes of one, so this is a separate entry rather
        // than a toggle on Programs (ADR 19's my-program/programs precedent).
        // Catalog is the host-side offering the org owns; Programs is the
        // sponsor-side entitlement that funds bookings of anyone's plans.
        name: "Catalog",
        icon: Library,
        path: "catalog",
        show: canHost && can("catalog.manage"),
      },
      {
        name: "Programs",
        icon: Briefcase,
        path: "programs",
        show: canSponsor && can("programs.manage"),
      },
      {
        // canSponsor only — the old extra `fundingSource === "WALLET"`
        // branch was unreachable-by-construction (fundingSource lives on
        // BillingAccount, which only exists when canSponsor=true) and
        // produced a dead tab on any org where it could have fired.
        name: "Billing",
        icon: CreditCard,
        path: "billing",
        show: canSponsor && can("billing.read"),
      },
      {
        name: "Payouts",
        icon: Wallet,
        path: "payouts",
        show: canHost && can("payouts.read"),
      },
      {
        name: "Reimbursements",
        icon: Wallet,
        path: "reimbursements",
        show:
          canSponsor &&
          fundingSource === "PERSONAL" &&
          can("reimbursements.read"),
      },
      {
        // #776 §C — per-org dispute/chargeback surface. Finance-only; the
        // money-path (org-wallet-first clawback) settles server-side.
        name: "Disputes",
        icon: ShieldAlert,
        path: "disputes",
        show: can("disputes.read"),
      },
    ];

    // Resources — the artefacts a session leaves behind. MANAGER + SUPPORT
    // live here. OWNER + MAINTAINER have access but the group is collapsed
    // by default (see resourcesCollapsedDefault). BILLING_ADMIN is excluded
    // — no booking-side remit.
    //
    // Two entries, not one tabbed "Resources" page: a group labelled
    // Resources holding a single item also called Resources is redundant
    // nesting, and the two lists answer different questions — Documents is a
    // review queue, Recordings is an archive.
    //
    // Trials are deliberately absent: a trial IS an appointment, so it
    // belongs on Appointments rather than in a list of its own.
    const resourcesItems: ItemSpec[] = [
      {
        name: "Documents",
        icon: FileText,
        path: "documents",
        show: can("operations.read"),
      },
      {
        name: "Recordings",
        icon: Video,
        path: "recordings",
        show: can("operations.read"),
      },
      {
        // #support-hub — org TRIAGE over members' support conversations:
        // metadata only (status/category/who), never transcripts (ADR 20 —
        // a member's support chat is content). Also carries the org CSAT
        // aggregate and the org-party dispute entry point.
        name: "Support",
        icon: LifeBuoy,
        path: "support",
        show: can("operations.read"),
      },
    ];

    // Insights — analytics + compliance + audit trail. SUPPORT
    // gets Audit + Analytics for ticket investigation; the bulk
    // gate (`isOperationsReader`) covers both. Consent is MANAGER+
    // only (DPDP grant/withdraw is a governance surface).
    const insightsItems: ItemSpec[] = [
      {
        name: "Analytics",
        icon: BarChart3,
        path: "analytics",
        show: can("operations.read"),
      },
      {
        name: "Audit",
        icon: ClipboardList,
        path: "audit",
        show: can("audit.read"),
      },
      {
        name: "Consent",
        icon: ShieldCheck,
        path: "consent",
        show: can("consent.read"),
      },
    ];

    // Configuration — settings + outbound/inbound integrations.
    // Settings stays MAINTAINER+ (org-config is sensitive). Webhooks +
    // SCIM + Data exports are BILLING_ADMIN-reachable for finance
    // integrations.
    // Webhooks, SCIM and Data exports are tabs on Settings, alongside SSO —
    // which had no sidebar entry at all and was reachable only via a link
    // buried inside the settings page. One Configuration destination, five
    // tabs, each still gated on its own matrix key.
    const configurationItems: ItemSpec[] = [
      {
        name: "Settings",
        icon: Settings,
        path: "settings",
        // Ungated as of ADR 23. The PAGE has always floored at active
        // membership — each tab carries its own gate and UrlTabs renders
        // nothing when none apply — but the nav entry demanded an operator
        // grant, so a LEARNER or EXPERT could reach Settings only by typing the
        // URL. That gap became user-visible once the member-level Notifications
        // tab landed there. Non-operators now see Settings with that one tab.
      },
    ];

    const filterItems = (items: ItemSpec[]) =>
      items
        .filter((it) => it.show !== false)
        .map(({ show: _show, ...rest }) => rest);

    const groups: CollapsibleSidebarGroup[] = [
      { items: filterItems(topItems) },
      { label: "People", items: filterItems(peopleItems) },
      { label: "Commerce", items: filterItems(commerceItems) },
      {
        label: "Resources",
        items: filterItems(resourcesItems),
        defaultCollapsed: resourcesCollapsedDefault,
      },
      { label: "Insights", items: filterItems(insightsItems) },
      { label: "Configuration", items: filterItems(configurationItems) },
    ];

    // Drop empty groups — e.g. a LEARNER's sidebar has nothing in
    // People/Commerce/Operations/Insights/Configuration after
    // filtering, so they see only the top "Overview + My Program"
    // block without ghost headers.
    return groups.filter((g) => g.items.length > 0);
  }, [org]);

  // Redirect to /home when landing on the bare /[orgId] route.
  useEffect(() => {
    if (org && pathname === `/dashboard/organization/${orgId}`) {
      router.replace(`/dashboard/organization/${orgId}/home`);
    }
  }, [org, pathname, orgId, router]);

  const handleSignOut = () => {
    void signOutEverywhere();
  };

  if (!session?.user?.id && !isSessionLoading) {
    return (
      <AccessDenied
        title="Authentication Required"
        message="Please sign in to access the organization dashboard."
      />
    );
  }

  if ((isLoading || isSessionLoading) && !org) {
    return <CollapsibleSidebarSkeleton />;
  }

  if (error) {
    return (
      <AccessDenied
        title="Organization unavailable"
        message={
          error instanceof Error
            ? error.message
            : "We could not load this organization."
        }
      />
    );
  }

  // Split the context-switching surface across TWO dropdowns:
  //   - Top header (org identity)  → switch between orgs / personal dashboard
  //   - Bottom user chip (personal) → user identity + sign out
  // This mirrors the Linear / Agentstack pattern: the top answers "which
  // context am I in?", the bottom answers "who am I?".
  const userExt = session?.user as
    | (NonNullable<typeof session>["user"] & {
        orgWorkspaceProfileId?: string | null;
        consultantProfileId?: string | null;
        consulteeProfileId?: string | null;
        organizationMemberships?: Array<{
          organizationId: string;
          organizationName: string;
          organizationLogo: string | null;
          role: string;
        }>;
      })
    | undefined;

  const personalHref = resolvePersonalDashboardHref({
    orgWorkspaceProfileId: userExt?.orgWorkspaceProfileId,
    consultantProfileId: userExt?.consultantProfileId,
    consulteeProfileId: userExt?.consulteeProfileId,
  });

  // Other orgs the user belongs to (excluding the current one)
  const otherOrgs = (userExt?.organizationMemberships ?? []).filter(
    (m) => m.organizationId !== orgId,
  );

  // Bottom chip dropdown — context switching only.
  // Top header stays static (org identity + collapse arrow). Single dropdown
  // at the bottom keeps the "which dropdown has what" confusion at zero.
  //
  // No "Organization settings" entry here: it pointed at the very href the
  // Configuration → Settings sidebar item already owns, so the same
  // destination appeared twice in one sidebar.
  const bottomUserChipActions: NonNullable<
    React.ComponentProps<typeof CollapsibleSidebar>["bottomUserChipActions"]
  > = [
    ...(personalHref
      ? [
          {
            type: "item" as const,
            label: "Personal Dashboard",
            href: personalHref,
            icon: LayoutDashboard,
          },
        ]
      : []),
    ...(otherOrgs.length > 0
      ? [
          { type: "separator" as const },
          { type: "label" as const, label: "Switch organization" },
          ...otherOrgs.map((m) => ({
            type: "item" as const,
            label: m.organizationName,
            href: `/dashboard/organization/${m.organizationId}/home`,
            icon: Building2,
          })),
        ]
      : []),
  ];

  // Subtitle under the org name: the user's role in THIS org. Capability
  // badges (Sponsor/Host/Hybrid) + funding source live in the top-bar —
  // sidebar subtitle is user-specific, top-bar badges are org-specific.
  const topSubtitle = org ? MEMBER_ROLE_LABEL[org.membership.role] : null;

  // Map URL segments to human-readable page names so the breadcrumbs match
  // the heading the user actually sees on the page.
  const PAGE_LABELS: Record<string, string> = {
    home: "Overview",
    "my-program": "My Program",
    compensation: "Compensation",
    collaborations: "Collaborations",
    appointments: "Appointments",
    messages: "Messages",
    requests: "Requests",
    members: "Members",
    catalog: "Catalog",
    programs: "Programs",
    contracts: "Contracts",
    "purchase-orders": "Purchase Orders",
    documents: "Documents",
    recordings: "Recordings",
    support: "Support",
    billing: "Billing",
    payouts: "Payouts",
    reimbursements: "Reimbursements",
    disputes: "Disputes",
    analytics: "Analytics",
    audit: "Audit",
    consent: "Consent",
    settings: "Settings",
  };

  // Full breadcrumb trail — every URL segment after /organization/{orgId}
  // becomes a crumb. Forward-compatible with nested routes.
  const breadcrumbs = pathname
    .replace(`/dashboard/organization/${orgId}`, "")
    .split("/")
    .filter(Boolean)
    .map((seg) => PAGE_LABELS[seg] ?? seg);

  return (
    <div className="flex h-screen-maintenance overflow-hidden bg-zinc-50 dark:bg-zinc-950">
      {/* Collapsible sidebar — hidden on mobile, visible on md+ */}
      <div className="hidden h-full shrink-0 md:block">
        <CollapsibleSidebar
          groups={sidebarGroups}
          basePath={`/dashboard/organization/${orgId}`}
          title={org?.organization.name ?? "Organization"}
          avatarFallback={(org?.organization.name ?? "O")
            .charAt(0)
            .toUpperCase()}
          userName={org?.organization.name}
          userImage={org?.organization.logo}
          userSubtitle={topSubtitle}
          bottomUserChipActions={bottomUserChipActions}
          bottomUserChip={
            session?.user
              ? {
                  name: session.user.name ?? null,
                  image: session.user.image ?? null,
                  role: org?.membership.role ?? "",
                }
              : undefined
          }
          pathname={pathname}
          onSignOut={handleSignOut}
        />
      </div>

      {/* Right panel: context bar + page content */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* Sticky context bar — always shows org identity + back link */}
        {org &&
          (() => {
            const capability = deriveCapabilityKind(
              org.organization.canSponsor,
              org.organization.canHost,
            );
            const fundingSource = org.organization.fundingSource;
            return (
              <DashboardContextBar
                identity={{
                  name: org.organization.name,
                  image: org.organization.logo,
                }}
                badges={[
                  {
                    label: CAPABILITY_LABEL[capability],
                    className: CAPABILITY_BADGE_CLASS[capability],
                  },
                  ...(fundingSource
                    ? [
                        {
                          label: FUNDING_SOURCE_LABEL[fundingSource],
                          className: FUNDING_SOURCE_BADGE_CLASS[fundingSource],
                        },
                      ]
                    : []),
                ]}
                breadcrumbs={breadcrumbs}
                leftLink={
                  personalHref
                    ? { href: personalHref, label: "Personal" }
                    : null
                }
              />
            );
          })()}

        {org && org.organization.status !== "ACTIVE" && (
          <OrgStatusBanner status={org.organization.status} />
        )}

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="p-6">
            <DashboardErrorBoundary>{children}</DashboardErrorBoundary>
          </div>
        </main>

        {/* Mobile bottom tab bar — only visible below md breakpoint. In normal
            flow at the column's end (not fixed), so it takes real layout space
            and <main> needs no compensating bottom padding. */}
        <nav className="md:hidden shrink-0 bg-white border-t border-zinc-200 flex">
          {MOBILE_TABS.filter(
            ({ surface, needsSponsor }) =>
              !org ||
              ((!surface || hasOrgPermission(org.membership.role, surface)) &&
                (!needsSponsor || org.organization.canSponsor)),
          ).map(({ label, path, Icon }) => {
            const isActive = pathname.includes(
              `/dashboard/organization/${orgId}/${path}`,
            );
            return (
              <Link
                key={path}
                href={`/dashboard/organization/${orgId}/${path}`}
                className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 text-[10px] font-medium transition-colors ${
                  isActive
                    ? "text-zinc-900"
                    : "text-zinc-500 hover:text-zinc-700"
                }`}
              >
                <LinkPendingIcon
                  Icon={Icon}
                  className={`h-5 w-5 ${isActive ? "text-zinc-900" : "text-zinc-400"}`}
                />
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
