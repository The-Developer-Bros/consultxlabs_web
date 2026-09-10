"use client";

import { usePathname, useRouter } from "next/navigation";
import { use, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Home,
  CalendarCheck,
  MessageSquare,
  CreditCard,
  Gift,
  LifeBuoy,
  Settings,
  FileText,
  Video,
  MessageSquareText,
  HelpCircle,
  Building2,
  UserRound,
  Lock,
  AlertTriangle,
  type LucideIcon,
} from "lucide-react";

import {
  PersonalDashboardShell,
  PersonalDashboardShellSkeleton,
} from "@/components/dashboard/PersonalDashboardShell";
import type { CollapsibleSidebarGroup } from "@/components/dashboard/CollapsibleSidebar";
import {
  BreadcrumbOverrideProvider,
  useBreadcrumbOverride,
} from "@/components/dashboard/breadcrumb-override";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import StreamProvider from "@/providers/StreamProvider";
import NovuProvider from "@/providers/NovuProvider";
import { useNovuSubscriberSync } from "@/hooks/useNovuSubscriberSync";
import { useSession } from "@/lib/auth-client";
import { signOutEverywhere } from "@/lib/auth/sign-out";
import { getEffectiveUserId } from "@/utils/auth";
import { useServerUserId } from "@/components/dashboard/ServerUserId";
import { fetchConsulteeDetails, fetchUserDetails } from "@/lib/user";
import { schedulePrefetch } from "@/lib/dashboard-queries";
import { UserProvider } from "./UserContext";

// Grouped sidebar nav — same routes as the old top-nav, clustered for the
// shared CollapsibleSidebar (Activity / Billing / Support).
const NAV_GROUPS: CollapsibleSidebarGroup[] = [
  {
    items: [
      { name: "Home", icon: Home, path: "home" },
      { name: "Appointments", icon: CalendarCheck, path: "appointments" },
      { name: "Messages", icon: MessageSquare, path: "messages" },
    ],
  },
  {
    // Was "Activity" wrapping a single "Resources" item — a label that said
    // less than the thing under it. Now the group IS Resources, and the two
    // artifacts are the entries: "where is the recording" and "where is the
    // handout" are different errands, and one page tabbed by event type
    // answered neither directly.
    label: "Resources",
    items: [
      { name: "Documents", icon: FileText, path: "documents" },
      { name: "Recordings", icon: Video, path: "recordings" },
    ],
  },
  {
    label: "Billing",
    items: [
      { name: "Payments", icon: CreditCard, path: "payments" },
      { name: "Referrals", icon: Gift, path: "referrals" },
    ],
  },
  {
    // Now a real group rather than a lone entry: requests, feedback and help
    // were tabs on one page, and they are distinct destinations — a ticket
    // list, a form and an FAQ share no state and answer different questions.
    // Settings sits here as the fourth: it is the other thing people come
    // looking for when something is wrong.
    label: "Support",
    items: [
      { name: "Support requests", icon: LifeBuoy, path: "support" },
      { name: "Feedback", icon: MessageSquareText, path: "feedback" },
      { name: "Help", icon: HelpCircle, path: "help" },
      { name: "Settings", icon: Settings, path: "settings" },
    ],
  },
];

// Mobile bottom-tab configuration — 5 most-accessed consultee pages.
const MOBILE_TABS: { label: string; path: string; Icon: LucideIcon }[] = [
  { label: "Home", path: "home", Icon: Home },
  { label: "Appointments", path: "appointments", Icon: CalendarCheck },
  { label: "Messages", path: "messages", Icon: MessageSquare },
  { label: "Payments", path: "payments", Icon: CreditCard },
  { label: "Support", path: "support", Icon: LifeBuoy },
];

// Map URL segments to human-readable page names so the breadcrumbs match
// the heading the user actually sees on the page.
const PAGE_LABELS: Record<string, string> = {
  home: "Home",
  appointments: "Appointments",
  resources: "Resources",
  messages: "Messages",
  payments: "Payments",
  referrals: "Referrals",
  support: "Support",
  settings: "Settings",
  documents: "Documents",
  recordings: "Recordings",
  feedback: "Feedback",
  help: "Help",
  // Task route hanging off a record id; without this the trail ends on the
  // raw lowercase segment.
  reschedule: "Reschedule",
};

// Opaque record ids (cuid / uuid) in nested routes carry no meaning as crumbs.
const looksLikeRecordId = (segment: string) =>
  /^[a-z0-9]{20,}$/i.test(segment) ||
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    segment,
  );

interface PageProps {
  children: React.ReactNode;
  params: Promise<{ consulteeId: string }>;
}

function AccessCard({
  Icon,
  title,
  tone = "amber",
  children,
}: {
  Icon: LucideIcon;
  title: string;
  tone?: "amber" | "red";
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-center min-h-svh bg-zinc-100">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white p-8 rounded-2xl shadow-xl border border-zinc-200 max-w-md text-center"
      >
        <div
          className={`w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center ${
            tone === "red" ? "bg-red-100" : "bg-amber-100"
          }`}
        >
          <Icon
            className={`w-8 h-8 ${tone === "red" ? "text-red-600" : "text-amber-600"}`}
          />
        </div>
        <h2 className="text-xl font-bold text-zinc-900 mb-2">{title}</h2>
        {children}
      </motion.div>
    </div>
  );
}

export default function ConsulteeLayout(props: Readonly<PageProps>) {
  return (
    <BreadcrumbOverrideProvider>
      <ConsulteeLayoutInner {...props} />
    </BreadcrumbOverrideProvider>
  );
}

function ConsulteeLayoutInner({ children, params }: Readonly<PageProps>) {
  const resolvedParams = use(params);
  const consulteeId = resolvedParams.consulteeId;
  const basePath = `/dashboard/consultee/${consulteeId}`;
  const pathname = usePathname();
  const { data: session, isPending: isSessionLoading } = useSession();
  const router = useRouter();

  // Fall back to the server-resolved id: useSession() is still pending during
  // SSR, so without this the query key below is ["user-details", undefined] and
  // the server seed in app/dashboard/layout.tsx can never be read (#1105).
  const serverUserId = useServerUserId();
  const userId = getEffectiveUserId(session) ?? serverUserId;

  // Sync user as Novu subscriber (once per session)
  useNovuSubscriberSync();

  // Fetch user details with placeholderData to prevent loading flashes
  const {
    data: userDetails,
    error: userError,
    isLoading: isLoadingUser,
  } = useQuery({
    queryKey: ["user-details", userId],
    queryFn: () => fetchUserDetails(userId!),
    enabled: !!userId && !isSessionLoading,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
    placeholderData: (previousData) => previousData,
  });

  // Consultee profile fetch — result unused directly, but it gates the
  // initial skeleton (profile 404s surface here) and warms the cache for
  // feature pages.
  const { error: profileError, isLoading: isLoadingProfile } = useQuery({
    queryKey: ["consultee-profile", consulteeId],
    queryFn: () => fetchConsulteeDetails(consulteeId),
    enabled: !!consulteeId,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
    placeholderData: (previousData) => previousData,
  });

  // Capability-based (#org-appts): access is owning THIS consulteeProfile, NOT
  // "role !== CONSULTANT". A marketplace CONSULTANT sponsored by an org as a
  // learner owns a consulteeProfile and must reach their consumer surfaces —
  // the old `role !== "CONSULTANT"` lock barred them from their own dashboard.
  // ADMIN/STAFF may inspect anyone's.
  const hasConsulteeAccess =
    userDetails &&
    (userDetails.role === "ADMIN" ||
      userDetails.role === "STAFF" ||
      userDetails.consulteeProfileId === consulteeId);

  // Redirect unauthorized users to their own dashboard (capability-routed).
  useEffect(() => {
    if (isLoadingUser || isSessionLoading || !userId) return;

    if (userDetails && !hasConsulteeAccess) {
      if (
        userDetails.consulteeProfileId &&
        userDetails.consulteeProfileId !== consulteeId
      ) {
        router.replace(
          `/dashboard/consultee/${userDetails.consulteeProfileId}/home`,
        );
      } else {
        router.replace("/dashboard");
      }
    }
  }, [
    userDetails,
    hasConsulteeAccess,
    isLoadingUser,
    isSessionLoading,
    userId,
    router,
    consulteeId,
  ]);

  // Prefetch
  useEffect(() => {
    if (!userId || !consulteeId || !hasConsulteeAccess) return;

    // Once per access-resolution, NOT per navigation: `pathname` used to be
    // a dep, re-scheduling this idle prefetch on every tab switch. Prefetching
    // /home while already on /home is deduped by the App Router, so the guard
    // isn't needed. Cancelled on unmount / dep change via schedulePrefetch's
    // cancel function (#1242).
    return schedulePrefetch(() => {
      router.prefetch(`${basePath}/home`);
    }, 3000);
  }, [userId, consulteeId, router, hasConsulteeAccess, basePath]);

  // Org memberships for the bottom chip's "Switch to organization" section
  const orgMemberships = useMemo(() => {
    const raw = (session?.user as Record<string, unknown> | undefined)
      ?.organizationMemberships;
    if (!Array.isArray(raw)) return [];
    return raw.map((m: Record<string, unknown>) => ({
      organizationId: String(m.organizationId ?? ""),
      organizationName: String(m.organizationName ?? ""),
    }));
  }, [session?.user]);

  const { overrideLabel } = useBreadcrumbOverride();

  // Full breadcrumb trail — opaque record ids are dropped (or replaced with
  // an override label such as the appointment title).
  const breadcrumbs = useMemo(() => {
    const parts = pathname.replace(basePath, "").split("/").filter(Boolean);

    const crumbs: { label: string; href?: string }[] = [];
    let acc = basePath;

    for (const seg of parts) {
      acc = `${acc}/${seg}`;
      if (looksLikeRecordId(seg)) {
        // The label goes HERE, in the id's own position — that segment IS the
        // record. Deferring it to after the loop only worked when the id was
        // the LAST segment, so a task route (…/<id>/reschedule) reset the flag
        // on its way past and the override never rendered.
        if (overrideLabel) crumbs.push({ label: overrideLabel, href: acc });
        continue;
      }
      crumbs.push({
        label: PAGE_LABELS[seg] ?? seg,
        href: acc,
      });
    }

    return crumbs.map((crumb, index) => {
      const isLast = index === crumbs.length - 1;
      if (isLast && crumb.href && pathname === crumb.href) {
        return { label: crumb.label };
      }
      return crumb;
    });
  }, [pathname, basePath, overrideLabel]);

  const isLoading = isLoadingUser || isLoadingProfile;
  const error = (userError || profileError) as Error | null;

  // Memoize StreamProvider children to prevent re-initialization on tab
  // switches. Must be called before any early returns (Rules of Hooks).
  const memoizedStreamContent = useMemo(
    () =>
      userDetails?.id ? (
        <StreamProvider
          userId={userDetails.id}
          enableChat={true}
          enableVideo={true}
        >
          <DashboardErrorBoundary>{children}</DashboardErrorBoundary>
        </StreamProvider>
      ) : (
        <DashboardErrorBoundary>{children}</DashboardErrorBoundary>
      ),
    [userDetails?.id, children],
  );

  // Auth check
  if (
    process.env.NODE_ENV !== "development" &&
    process.env.NODE_ENV !== "test" &&
    !session?.user?.id &&
    !isSessionLoading
  ) {
    return (
      <AccessCard Icon={Lock} title="Authentication Required">
        <p className="text-zinc-600">
          Please sign in to access your dashboard.
        </p>
        <a
          href="/auth/signin"
          className="inline-block mt-6 px-6 py-2.5 bg-zinc-900 text-white rounded-lg font-medium hover:bg-zinc-800 transition-colors"
        >
          Sign In
        </a>
      </AccessCard>
    );
  }

  // Access denied — before the skeleton so unauthorized users never see it
  if (userDetails && !hasConsulteeAccess) {
    return (
      <AccessCard Icon={Lock} title="Access Denied">
        <p className="text-zinc-600">
          You don&apos;t have permission to access this dashboard.
        </p>
        <p className="text-sm text-zinc-500 mt-2">
          Redirecting to your dashboard...
        </p>
      </AccessCard>
    );
  }

  // Initial loading — only while access is still being determined
  if ((isLoading || isSessionLoading) && !userDetails) {
    return <PersonalDashboardShellSkeleton />;
  }

  // Error state
  if (error) {
    return (
      <AccessCard Icon={AlertTriangle} title="Something went wrong" tone="red">
        <p className="text-zinc-600">
          {error.message || "Failed to load dashboard"}
        </p>
        <button
          onClick={() => window.location.reload()}
          className="mt-6 px-6 py-2.5 bg-zinc-900 text-white rounded-lg font-medium hover:bg-zinc-800 transition-colors"
        >
          Try Again
        </button>
      </AccessCard>
    );
  }

  if (!userDetails) {
    return <PersonalDashboardShellSkeleton />;
  }

  const userName = userDetails.name ?? session?.user?.name ?? null;
  const userImage = userDetails.image ?? session?.user?.image ?? null;

  // Bottom chip dropdown — account pages + org context switching (matches
  // the consultant/org shells' IA); Sign Out renders as the standalone red
  // button below the chip.
  const bottomUserChipActions = [
    // Settings deliberately absent: it is a sidebar entry under Support now,
    // and a second link to the same href is the duplicate-destination problem
    // ADR 19 exists to stop. The chip answers "who am I / which context",
    // the sidebar answers "where do I go".
    ...(orgMemberships.length > 0
      ? [
          { type: "separator" as const },
          { type: "label" as const, label: "Switch to organization" },
          ...orgMemberships.map((m) => ({
            type: "item" as const,
            label: m.organizationName,
            href: `/dashboard/organization/${m.organizationId}/home`,
            icon: Building2,
          })),
        ]
      : []),
  ];

  return (
    <NovuProvider>
      <UserProvider userDetails={userDetails}>
        <PersonalDashboardShell
          groups={NAV_GROUPS}
          basePath={basePath}
          title="My Dashboard"
          subtitle={userName}
          headerImage={userImage}
          bottomUserChip={{
            name: userName,
            image: userImage,
            role: "Client",
          }}
          bottomUserChipActions={bottomUserChipActions}
          contextBar={{
            identity: {
              name: userName ?? "My Dashboard",
              image: userImage,
              FallbackIcon: UserRound,
            },
            breadcrumbs,
          }}
          mobileTabs={MOBILE_TABS}
          pathname={pathname}
          onSignOut={() => void signOutEverywhere()}
        >
          {memoizedStreamContent}
        </PersonalDashboardShell>
      </UserProvider>
    </NovuProvider>
  );
}
