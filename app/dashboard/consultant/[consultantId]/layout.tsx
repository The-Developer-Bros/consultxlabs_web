"use client";

import { useParams, usePathname, useRouter } from "next/navigation";
import { use, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Home,
  MessageSquare,
  CalendarCheck,
  CalendarRange,
  Inbox,
  Users,
  Video,
  FileText,
  Wallet,
  Gift,
  Settings,
  MessageSquareText,
  HelpCircle,
  LifeBuoy,
  Building2,
  UserRound,
  UserX,
  Lock,
  WifiOff,
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
import { useChatUnreadCount } from "@/hooks/useChatUnreadCount";
import { useSession } from "@/lib/auth-client";
import { signOutEverywhere } from "@/lib/auth/sign-out";
import { getEffectiveUserId } from "@/utils/auth";
import { useServerUserId } from "@/components/dashboard/ServerUserId";
import { consultantFetchers, schedulePrefetch } from "@/lib/dashboard-queries";
import { verificationStatusBadge } from "@/lib/labels/session-labels";
import {
  VerificationPendingOverlay,
  VerificationBanner,
} from "@/components/verification/VerificationPendingOverlay";
import type { VerificationStatus } from "@/components/verification/VerificationStatusBadge";
import { useVerificationStatus } from "./hooks/useVerificationStatus";

// Grouped sidebar nav (Services / Resources / Finance / Support), rendered by
// the shared CollapsibleSidebar.
//
// Trials and Analytics used to be entries here and are now tabs on Appointments
// and Earnings respectively — see the group comments below. This array is still
// static and unfiltered, unlike the org sidebar's permission-driven one: every
// surface on a personal dashboard belongs to the one person who owns it, so
// there is nothing to filter on.
const NAV_GROUPS: CollapsibleSidebarGroup[] = [
  {
    items: [
      { name: "Home", icon: Home, path: "home" },
      { name: "Messages", icon: MessageSquare, path: "messages" },
      { name: "Appointments", icon: CalendarCheck, path: "appointments" },
    ],
  },
  {
    // Trials is absent by ADR 19's rule that a nav entry must be a distinct
    // destination: a trial IS an appointment, which is why the org sidebar
    // already folded it onto Appointments. It lives at
    // `appointments?tab=trials` now.
    label: "Services",
    items: [
      { name: "Event Planner", icon: CalendarRange, path: "planner" },
      { name: "Requests", icon: Inbox, path: "requests" },
      { name: "Collaborations", icon: Users, path: "collaborations" },
    ],
  },
  {
    // "Resources" rather than "Content", matching the consultee side — the
    // same two artifacts under the same name on both dashboards, so a
    // consultant who also books sessions is not learning two vocabularies.
    label: "Resources",
    items: [
      { name: "Documents", icon: FileText, path: "documents" },
      { name: "Recordings", icon: Video, path: "recordings" },
    ],
  },
  {
    // Analytics is absent for the same reason as Trials: it read the very same
    // /api/consultant/earnings endpoint as Earnings, only adding
    // `?includeMonthly=1`. Two entries over one object is exactly what ADR 19
    // forbids, so it is the Analytics tab of Earnings now.
    label: "Finance",
    items: [
      { name: "Earnings", icon: Wallet, path: "earnings" },
      { name: "Referrals", icon: Gift, path: "referrals" },
    ],
  },
  {
    // A real group now rather than a lone entry: requests, feedback and help
    // were tabs on one page and are distinct destinations. Settings joins them
    // as the fourth — the other thing people go looking for when something is
    // wrong. Mirrors the consultee shell exactly.
    label: "Support",
    items: [
      { name: "Support requests", icon: LifeBuoy, path: "support" },
      { name: "Feedback", icon: MessageSquareText, path: "feedback" },
      { name: "Help", icon: HelpCircle, path: "help" },
      { name: "Settings", icon: Settings, path: "settings" },
    ],
  },
];

// Mobile bottom-tab configuration — 5 most-accessed consultant pages.
const MOBILE_TABS: { label: string; path: string; Icon: LucideIcon }[] = [
  { label: "Home", path: "home", Icon: Home },
  { label: "Appointments", path: "appointments", Icon: CalendarCheck },
  { label: "Requests", path: "requests", Icon: Inbox },
  { label: "Earnings", path: "earnings", Icon: Wallet },
  { label: "Settings", path: "settings", Icon: Settings },
];

// Map URL segments to human-readable page names so the breadcrumbs match
// the heading the user actually sees on the page.
const PAGE_LABELS: Record<string, string> = {
  home: "Home",
  messages: "Messages",
  appointments: "Appointments",
  participants: "Participants",
  classes: "Class",
  class: "Class",
  consultations: "Consultation",
  consultation: "Consultation",
  subscriptions: "Subscription",
  subscription: "Subscription",
  webinars: "Webinar",
  webinar: "Webinar",
  offerings: "Offerings",
  planner: "Event Planner",
  requests: "Requests",
  // Task routes hanging off a record id. Without these the trail ends on the
  // raw lowercase segment ("timings").
  timings: "Timings",
  allocate: "Allocate",
  reschedule: "Reschedule",
  collaborations: "Collaborations",
  recordings: "Recordings",
  documents: "Documents",
  earnings: "Earnings",
  referrals: "Referrals",
  settings: "Settings",
  support: "Support requests",
  feedback: "Feedback",
  help: "Help",
  edit: "Edit",
  new: "New",
};

// Segments that group routes without owning a page of their own — a crumb that
// links the accumulated path makes Next prefetch a URL that 404s. Verified
// against the route tree: `offerings` has only `[type]/…` children and
// `participants` only `[eventType]/…`.
//
// Offerings is special-cased below: the crumb stays, but its href is rewritten
// to the Event Planner, which is the actual listings surface for those rows.
const PATHLESS_SEGMENTS = new Set(["offerings", "participants"]);

/** Offering types that appear as `/offerings/[type]/…` URL segments. */
const OFFERING_TYPE_SEGMENTS = new Set([
  "consultation",
  "subscription",
  "webinar",
  "class",
]);

// Opaque record ids (cuid / uuid) in nested routes carry no meaning as crumbs.
const looksLikeRecordId = (segment: string) =>
  /^[a-z0-9]{20,}$/i.test(segment) ||
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    segment,
  );

interface PageProps {
  children: React.ReactNode;
  params: Promise<{ consultantId: string }>;
}

// Error types and their configurations
type ErrorType = "not-found" | "session-expired" | "network" | "unknown";

function getErrorConfig(errorMessage: string): {
  type: ErrorType;
  title: string;
  description: string;
  suggestion: string;
  primaryAction: { label: string; href?: string; onClick?: () => void };
  secondaryAction?: { label: string; href: string };
} {
  const lowerMessage = errorMessage.toLowerCase();

  if (lowerMessage.includes("not found") || lowerMessage.includes("404")) {
    return {
      type: "not-found",
      title: "Profile Not Found",
      description:
        "We couldn't find your consultant profile. This might happen if you're logged into the wrong account or your profile hasn't been set up yet.",
      suggestion:
        "Try signing out and logging back in with the correct account.",
      primaryAction: {
        label: "Sign Out & Re-login",
        href: "/auth/signin?callbackUrl=/dashboard",
      },
      secondaryAction: { label: "Go to Home", href: "/" },
    };
  }

  if (
    lowerMessage.includes("unauthorized") ||
    lowerMessage.includes("401") ||
    lowerMessage.includes("session")
  ) {
    return {
      type: "session-expired",
      title: "Session Expired",
      description:
        "Your session has expired or you've been signed out. Please sign in again to continue.",
      suggestion: "This is normal after being inactive for a while.",
      primaryAction: {
        label: "Sign In Again",
        href: "/auth/signin?callbackUrl=/dashboard",
      },
    };
  }

  if (
    lowerMessage.includes("network") ||
    lowerMessage.includes("fetch") ||
    lowerMessage.includes("500")
  ) {
    return {
      type: "network",
      title: "Connection Issue",
      description:
        "We're having trouble connecting to our servers. This is usually temporary.",
      suggestion: "Check your internet connection and try again.",
      primaryAction: {
        label: "Try Again",
        onClick: () => window.location.reload(),
      },
    };
  }

  return {
    type: "unknown",
    title: "Something Went Wrong",
    description: "We encountered an unexpected issue loading your dashboard.",
    suggestion:
      "If this keeps happening, try signing out and back in, or contact support.",
    primaryAction: {
      label: "Sign Out & Re-login",
      href: "/auth/signin?callbackUrl=/dashboard",
    },
    secondaryAction: { label: "Try Again", href: "#" },
  };
}

const ERROR_ICONS: Record<
  ErrorType,
  { Icon: LucideIcon; bg: string; color: string }
> = {
  "not-found": { Icon: UserX, bg: "bg-amber-100", color: "text-amber-600" },
  "session-expired": { Icon: Lock, bg: "bg-blue-100", color: "text-blue-600" },
  network: { Icon: WifiOff, bg: "bg-orange-100", color: "text-orange-600" },
  unknown: { Icon: AlertTriangle, bg: "bg-red-100", color: "text-red-600" },
};

function ErrorDisplay({ message }: { message: string }) {
  const config = getErrorConfig(message);
  const { Icon, bg, color } = ERROR_ICONS[config.type];

  return (
    <div className="flex items-center justify-center min-h-svh bg-zinc-100">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white p-8 rounded-2xl shadow-xl border border-zinc-200 max-w-md text-center mx-4"
      >
        <div
          className={`w-16 h-16 mx-auto mb-4 rounded-full ${bg} flex items-center justify-center`}
        >
          <Icon className={`w-8 h-8 ${color}`} />
        </div>

        <h2 className="text-xl font-bold text-zinc-900 mb-2">{config.title}</h2>
        <p className="text-zinc-600 mb-3">{config.description}</p>
        <p className="text-sm text-zinc-500 italic mb-6">{config.suggestion}</p>

        <div className="flex flex-col gap-3">
          {config.primaryAction.href ? (
            <a
              href={config.primaryAction.href}
              className="w-full px-6 py-2.5 bg-zinc-900 text-white rounded-lg font-medium hover:bg-zinc-800 transition-colors"
            >
              {config.primaryAction.label}
            </a>
          ) : (
            <button
              onClick={config.primaryAction.onClick}
              className="w-full px-6 py-2.5 bg-zinc-900 text-white rounded-lg font-medium hover:bg-zinc-800 transition-colors"
            >
              {config.primaryAction.label}
            </button>
          )}

          {config.secondaryAction && (
            <a
              href={config.secondaryAction.href}
              onClick={
                config.secondaryAction.href === "#"
                  ? (e) => {
                      e.preventDefault();
                      window.location.reload();
                    }
                  : undefined
              }
              className="w-full px-6 py-2.5 bg-zinc-100 text-zinc-700 rounded-lg font-medium hover:bg-zinc-200 transition-colors"
            >
              {config.secondaryAction.label}
            </a>
          )}
        </div>
      </motion.div>
    </div>
  );
}

function AccessCard({
  Icon,
  title,
  children,
}: {
  Icon: LucideIcon;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-center min-h-svh bg-zinc-100">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white p-8 rounded-2xl shadow-xl border border-zinc-200 max-w-md text-center"
      >
        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-amber-100 flex items-center justify-center">
          <Icon className="w-8 h-8 text-amber-600" />
        </div>
        <h2 className="text-xl font-bold text-zinc-900 mb-2">{title}</h2>
        {children}
      </motion.div>
    </div>
  );
}

export default function ConsultantLayout(props: Readonly<PageProps>) {
  return (
    <BreadcrumbOverrideProvider>
      <ConsultantLayoutInner {...props} />
    </BreadcrumbOverrideProvider>
  );
}

function ConsultantLayoutInner({ children, params }: Readonly<PageProps>) {
  const resolvedParams = use(params);
  const consultantId = resolvedParams.consultantId;
  const basePath = `/dashboard/consultant/${consultantId}`;
  const pathname = usePathname();
  const routeParams = useParams();
  const { data: session, isPending: isSessionLoading } = useSession();
  const router = useRouter();

  // Fall back to the server-resolved id: useSession() is still pending during
  // SSR, so without this the query key below is ["user-details", undefined] and
  // the server seed in app/dashboard/layout.tsx can never be read (#1105).
  const serverUserId = useServerUserId();
  const userId = getEffectiveUserId(session) ?? serverUserId;

  // Sync user as Novu subscriber (once per session)
  useNovuSubscriberSync();

  // Fetch user details to check consultant access
  const { data: userDetails, isLoading: isLoadingUserDetails } = useQuery({
    queryKey: ["user-details", userId],
    queryFn: async () => {
      const response = await fetch(`/api/user/${userId}`);
      if (!response.ok) throw new Error("Failed to fetch user details");
      const result = await response.json();
      return result.data;
    },
    enabled: !!userId && !isSessionLoading,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
  });

  // Fetch consultant data with placeholderData to prevent loading flashes
  const {
    data: consultantData,
    error,
    isLoading,
  } = useQuery({
    queryKey: ["consultant-data", consultantId],
    queryFn: () => consultantFetchers.details(consultantId),
    enabled: !!userId && !isSessionLoading,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
    placeholderData: (previousData) => previousData,
  });

  // Check if user has access to this consultant dashboard:
  // - ADMIN: Can access ANY dashboard
  // - STAFF: Can view consultant and consultee dashboards
  // - CONSULTANT: Can only access their OWN dashboard
  // Capability-based (#org-appts): access is owning the consultantProfile, NOT
  // holding UserRole=CONSULTANT — an org EXPERT whose marketplace identity is
  // CONSULTEE still owns a consultantProfile and must reach their delivery
  // surfaces. ADMIN/STAFF may inspect anyone's.
  const hasConsultantAccess =
    userDetails &&
    (userDetails.role === "ADMIN" ||
      userDetails.role === "STAFF" ||
      userDetails.consultantProfileId === consultantId);

  // Redirect unauthorized users to their appropriate dashboard
  useEffect(() => {
    if (isLoadingUserDetails || isSessionLoading || !userId) return;

    if (userDetails && !hasConsultantAccess) {
      if (userDetails.consultantProfileId) {
        router.replace(
          `/dashboard/consultant/${userDetails.consultantProfileId}/home`,
        );
      } else if (userDetails.consulteeProfileId) {
        router.replace(
          `/dashboard/consultee/${userDetails.consulteeProfileId}/home`,
        );
      } else {
        router.replace("/dashboard");
      }
    }
  }, [
    userDetails,
    hasConsultantAccess,
    isLoadingUserDetails,
    isSessionLoading,
    userId,
    router,
  ]);

  // Prefetch critical routes on mount
  useEffect(() => {
    if (!userId || !consultantId || !hasConsultantAccess) return;

    // Once per access-resolution, NOT per navigation: `pathname` used to be
    // a dep, re-scheduling this idle prefetch on every tab switch (even while
    // already on the target route). App Router dedupes redundant prefetches.
    return schedulePrefetch(() => {
      router.prefetch(`${basePath}/home`);
      router.prefetch(`${basePath}/appointments`);
    }, 3000);
  }, [userId, consultantId, router, hasConsultantAccess, basePath]);

  // Verification state + reviewer feedback. The consultant-data payload
  // carries the coarse status; the verification query adds the latest
  // submission's rejectionReason / feedbackDetails / per-document feedback
  // so the REJECTED gate can finally show WHY.
  const verificationStatus = consultantData?.verificationStatus as
    | VerificationStatus
    | undefined;
  // ADMIN/STAFF inspecting someone's dashboard must never be gated (and
  // /api/verification/status reads the SIGNED-IN user, which would be the
  // admin's own — mismatched — record). Gate + fetch only for the owner.
  const isOwnDashboard = userDetails?.consultantProfileId === consultantId;
  const { data: verification } = useVerificationStatus(
    userId,
    !!verificationStatus &&
      verificationStatus !== "VERIFIED" &&
      !!isOwnDashboard,
  );

  // Unread badge count for the Chats nav item
  const chatUnreadCount = useChatUnreadCount();
  const navGroups = useMemo(
    () =>
      NAV_GROUPS.map((group) => ({
        ...group,
        items: group.items.map((item) =>
          item.path === "messages" && chatUnreadCount > 0
            ? {
                ...item,
                badge: chatUnreadCount > 99 ? "99+" : chatUnreadCount,
              }
            : item,
        ),
      })),
    [chatUnreadCount],
  );

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

  // Every value the current route bound to a dynamic param. Such a segment is
  // never a URL of its own, so its crumb must not be a link.
  const paramValues = useMemo(() => {
    const values = new Set<string>();
    for (const value of Object.values(routeParams ?? {})) {
      for (const part of Array.isArray(value) ? value : [value]) {
        if (part) values.add(part);
      }
    }
    return values;
  }, [routeParams]);

  // Full breadcrumb trail — every URL segment after the consultant id
  // becomes a crumb; opaque record ids are dropped (or replaced with an
  // override label such as the appointment title). Parent crumbs keep an
  // href so users can click back (e.g. Appointments from a detail page),
  // but only when the accumulated path is a route the app can actually serve.
  const breadcrumbs = useMemo(() => {
    const parts = pathname.replace(basePath, "").split("/").filter(Boolean);
    const onOfferings = parts[0] === "offerings";
    // Offerings have no list route of their own — the Event Planner is where
    // those rows live. Point both the "Offerings" crumb and the type crumb
    // (consultation / subscription / …) there so the trail is clickable
    // without prefetching a 404.
    const offeringsListingHref = `${basePath}/planner`;

    const crumbs: { label: string; href?: string }[] = [];
    let acc = basePath;

    for (const seg of parts) {
      acc = `${acc}/${seg}`;
      if (looksLikeRecordId(seg)) {
        // The label goes HERE, in the id's own position — that segment IS the
        // record, so its human name belongs where the id was. Previously this
        // was deferred to after the loop and only applied when the id was the
        // LAST segment, so a task route (…/<id>/timings) reset the flag on its
        // way past and the override never rendered at all.
        if (overrideLabel) crumbs.push({ label: overrideLabel, href: acc });
        continue;
      }

      if (
        seg === "offerings" ||
        (onOfferings && OFFERING_TYPE_SEGMENTS.has(seg))
      ) {
        crumbs.push({
          label: PAGE_LABELS[seg] ?? seg,
          href: offeringsListingHref,
        });
        continue;
      }

      const navigable = !PATHLESS_SEGMENTS.has(seg) && !paramValues.has(seg);
      crumbs.push({
        label: PAGE_LABELS[seg] ?? seg,
        ...(navigable ? { href: acc } : {}),
      });
    }

    return crumbs.map((crumb, index) => {
      const isLast = index === crumbs.length - 1;
      // Keep a link when the visible crumb is still a parent of the URL
      // (happens when the last segment was an opaque id we stripped).
      if (isLast && crumb.href && pathname === crumb.href) {
        return { label: crumb.label };
      }
      return crumb;
    });
  }, [pathname, basePath, overrideLabel, paramValues]);

  // Memoize StreamProvider children to prevent re-initialization on tab
  // switches. Must be called before any early returns (Rules of Hooks).
  const memoizedStreamContent = useMemo(
    () =>
      consultantData?.user?.id ? (
        <StreamProvider
          userId={consultantData.user.id}
          enableChat={true}
          enableVideo={true}
        >
          <DashboardErrorBoundary>{children}</DashboardErrorBoundary>
        </StreamProvider>
      ) : (
        <DashboardErrorBoundary>{children}</DashboardErrorBoundary>
      ),
    [consultantData?.user?.id, children],
  );

  // Authentication check
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
  if (userDetails && !hasConsultantAccess) {
    return (
      <AccessCard Icon={Lock} title="Access Denied">
        <p className="text-zinc-600">
          You don&apos;t have permission to access this Consultant Dashboard.
        </p>
        <p className="text-sm text-zinc-500 mt-2">
          Redirecting to your dashboard...
        </p>
      </AccessCard>
    );
  }

  // Initial loading — only while access is still being determined
  if (
    (isLoading || isLoadingUserDetails || isSessionLoading) &&
    !consultantData &&
    !userDetails
  ) {
    return <PersonalDashboardShellSkeleton />;
  }

  // Error state
  if (error && !consultantData) {
    return (
      <ErrorDisplay
        message={
          error instanceof Error ? error.message : "Failed to load dashboard"
        }
      />
    );
  }

  const userName = consultantData?.user?.name ?? session?.user?.name ?? null;
  const userImage = consultantData?.user?.image ?? session?.user?.image ?? null;
  const settingsHref = `${basePath}/settings`;
  const verificationHref = `${settingsHref}?tab=verification`;

  // Bottom chip dropdown — org context switching only. Settings and Help are
  // sidebar entries under Support now, so this comment used to say the exact
  // opposite of what the code does; leaving it would have invited someone to
  // "restore" a second link to the same href. Sign Out renders as the
  // standalone red button below.
  const bottomUserChipActions = [
    // Settings is a sidebar entry under Support now; a second link to the same
    // href is the duplicate-destination problem ADR 19 exists to stop.
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

  // Gating policy: waiting states get a browsable dashboard + banner;
  // REJECTED gets the full-screen gate with the reviewer feedback threaded
  // in. Settings stays reachable in every state (it hosts the fix).
  const isSettingsPage = pathname.includes("/settings");
  const showRejectedGate =
    verificationStatus === "REJECTED" && !isSettingsPage && !!isOwnDashboard;
  const showVerificationBanner =
    (verificationStatus === "PENDING_VERIFICATION" ||
      verificationStatus === "UNDER_REVIEW") &&
    !isSettingsPage &&
    !!isOwnDashboard;

  return (
    <NovuProvider>
      {showRejectedGate && (
        <VerificationPendingOverlay
          status="REJECTED"
          rejectionReason={
            verification?.latestRequest?.rejectionReason ?? undefined
          }
          feedbackDetails={
            verification?.latestRequest?.feedbackDetails ?? undefined
          }
          documentFeedback={verification?.latestRequest?.documentFeedback}
          resubmitUrl={verificationHref}
        />
      )}
      <PersonalDashboardShell
        groups={navGroups}
        basePath={basePath}
        title="Consultant Dashboard"
        subtitle={userName}
        headerImage={userImage}
        bottomUserChip={{
          name: userName,
          image: userImage,
          role: "Consultant",
        }}
        bottomUserChipActions={bottomUserChipActions}
        contextBar={{
          identity: {
            name: userName ?? "Consultant",
            image: userImage,
            FallbackIcon: UserRound,
          },
          badges: verificationStatus
            ? [
                {
                  label: verificationStatusBadge(verificationStatus).label,
                  className:
                    verificationStatusBadge(verificationStatus).className,
                },
              ]
            : [],
          breadcrumbs,
        }}
        mobileTabs={MOBILE_TABS}
        banner={
          showVerificationBanner && verificationStatus ? (
            <VerificationBanner
              status={verificationStatus}
              resubmitUrl={verificationHref}
            />
          ) : undefined
        }
        pathname={pathname}
        onSignOut={() => void signOutEverywhere()}
      >
        {memoizedStreamContent}
      </PersonalDashboardShell>
    </NovuProvider>
  );
}
