"use client";

import { useEffect, useState } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Search,
  Flag,
  CheckCircle2,
  XCircle,
  Star,
  MessageSquare,
  User,
  FileText,
  Eye,
  ThumbsUp,
  ThumbsDown,
  Loader2,
  RefreshCw,
  ExternalLink,
  AlertTriangle,
  Trash2,
  ShieldOff,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type {
  ProfileVerification,
  ModerationCapabilities,
  ModerationLatestAction,
  ModerationReport,
  ModerationReview,
  ModerationSideEffects,
  ModerationStats,
} from "@/types/moderation";

const getStatusColor = (status: string) => {
  switch (status.toLowerCase()) {
    case "pending":
      return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300";
    case "resolved":
    case "approved":
    case "verified":
      return "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300";
    case "rejected":
    case "dismissed":
      return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
    case "in_progress":
      return "bg-muted text-foreground";
    default:
      return "bg-muted text-muted-foreground";
  }
};

const getTypeIcon = (type: string) => {
  switch (type.toLowerCase()) {
    case "review":
      return <Star className="h-4 w-4" />;
    case "profile":
      return <User className="h-4 w-4" />;
    case "message":
    case "chat":
      return <MessageSquare className="h-4 w-4" />;
    default:
      return <FileText className="h-4 w-4" />;
  }
};

const formatDate = (dateString: string) => {
  const date = new Date(dateString);
  return date.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
};

/**
 * The enforcement suffix shown beside a target's role. Extracted from a nested
 * ternary (Sonar S3358): "banned" and "suspended until X" are different states,
 * not two branches of one, and reading them as a lookup makes that plain.
 */
function describeEnforcementState(target: {
  banned?: boolean | null;
  banExpires?: string | null;
}): string {
  if (!target.banned) return "";
  if (!target.banExpires) return " • banned";
  return ` • suspended until ${formatDate(target.banExpires)}`;
}

/** Statuses the action route still accepts; anything else answers 409. */
const OPEN_REPORT_STATUSES = new Set<string>([
  "PENDING",
  "UNDER_REVIEW",
  "ESCALATED",
]);

const REPORT_STATUS_FILTERS = [
  { value: "PENDING", label: "Pending" },
  { value: "UNDER_REVIEW", label: "Under review" },
  { value: "ESCALATED", label: "Escalated" },
  { value: "ACTION_TAKEN", label: "Action taken" },
  { value: "DISMISSED", label: "Dismissed" },
] as const;

/**
 * What is still true about the target when the Stream half of an action never
 * landed (#1270). Written for the moderator, not for the log: "stream: failed"
 * on its own does not tell an admin that the account they just banned can still
 * message the person who reported it.
 */
const STREAM_GAP_BY_ACTION: Record<string, string> = {
  USER_BANNED:
    "the ban did NOT reach chat — the account's existing chat token still works and it has not been deactivated",
  USER_SUSPENDED:
    "the suspension did NOT reach chat — the account's existing chat token still works",
  CONTENT_REMOVED:
    "the message was NOT deleted — it is still visible in the conversation",
  USER_REINSTATED:
    "chat access was NOT restored — the account still cannot connect to chat",
};

const describeStreamGap = (actionType: string) =>
  STREAM_GAP_BY_ACTION[actionType] ??
  "the Stream side of this action did not land";

const enforcementIncomplete = (
  sideEffects: ModerationSideEffects | null | undefined,
) => sideEffects?.stream === "failed" || sideEffects?.stream === "gave_up";

/**
 * The persisted record of what an action actually did. `sideEffects` has been
 * written since #693 and read by nothing, which is how a ban that never reached
 * Stream looked identical to one that did.
 */
function EnforcementSummary({
  action,
}: Readonly<{ action: ModerationLatestAction }>) {
  const sideEffects = action.sideEffects;
  const incomplete = enforcementIncomplete(sideEffects);
  const cancelled = sideEffects?.cancellations?.engagementsCancelled ?? 0;
  const refunded = sideEffects?.cancellations?.refundsIssued ?? 0;

  return (
    <div
      className={`rounded-lg border p-4 ${
        incomplete ? "border-destructive/50 bg-destructive/10" : "bg-muted"
      }`}
    >
      <div className="flex items-center gap-2">
        {incomplete ? (
          <AlertTriangle className="h-4 w-4 text-destructive" />
        ) : (
          <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
        )}
        <Label className="text-sm font-medium">
          {action.actionType.replace(/_/g, " ")} —{" "}
          {formatDate(action.createdAt)}
        </Label>
      </div>
      {incomplete && (
        <p className="mt-2 text-sm text-destructive">
          Enforcement incomplete: {describeStreamGap(action.actionType)}.
          {sideEffects?.stream === "gave_up"
            ? " Automatic retries have been exhausted; this needs to be applied by hand."
            : " It will be retried automatically."}
        </p>
      )}
      <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
        {sideEffects?.sessionsRevoked !== undefined && (
          <li>{sideEffects.sessionsRevoked} session(s) revoked</li>
        )}
        {(cancelled > 0 || refunded > 0) && (
          <li>
            {cancelled} appointment(s) cancelled, {refunded} refund(s) issued
          </li>
        )}
        {sideEffects?.earningsHeld !== undefined && (
          <li>{sideEffects.earningsHeld} earning(s) held</li>
        )}
        {sideEffects?.reviewRemoved && <li>Review removed</li>}
        {sideEffects?.stream && <li>Chat enforcement: {sideEffects.stream}</li>}
        {sideEffects?.notification && (
          <li>Notification: {sideEffects.notification}</li>
        )}
      </ul>
      {sideEffects?.errors?.length ? (
        <ul className="mt-2 space-y-0.5 text-xs text-destructive">
          {sideEffects.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ModerationPage() {
  const [activeTab, setActiveTab] = useState("reports");
  const [searchQuery, setSearchQuery] = useState("");
  // #997 secondary findings — the reports list used to fetch all PENDING
  // reports and substring-search every keystroke client-side. Debounce and
  // send the query to the server instead.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedReport, setSelectedReport] = useState<ModerationReport | null>(
    null,
  );
  const [selectedProfile, setSelectedProfile] =
    useState<ProfileVerification | null>(null);
  const [moderationNote, setModerationNote] = useState("");
  const [suspensionDays, setSuspensionDays] = useState(7);
  // #1270 — a report whose enforcement half-failed leaves the PENDING queue the
  // moment it is actioned, so without a way to look at resolved reports the
  // persisted failure was unreachable from this page.
  const [statusFilter, setStatusFilter] = useState("PENDING");

  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Fetch moderation stats
  const {
    data: stats,
    isPending: loadingStats,
    isFetching: fetchingStats,
    refetch: refetchStats,
  } = useQuery({
    queryKey: ["staff-moderation-stats"],
    queryFn: async (): Promise<ModerationStats> => {
      const response = await fetch("/api/staff/moderation/stats");
      if (!response.ok) throw new Error("Failed to fetch stats");
      // The route wraps the counters in a `stats` envelope, alongside
      // reportsByType / actionsByType / period. Returning the envelope and
      // annotating it `ModerationStats` typechecked fine and left every card
      // reading `undefined`, so all four rendered their `?? 0` fallback
      // permanently — a moderation queue that always looked empty.
      const body = (await response.json()) as { stats: ModerationStats };
      return body.stats;
    },
  });

  // Fetch moderation reports
  const {
    data: reportsData,
    isPending: loadingReports,
    isFetching: fetchingReports,
    isError: reportsError,
    refetch: refetchReports,
  } = useQuery({
    queryKey: ["staff-moderation-reports", statusFilter, debouncedSearch],
    queryFn: async (): Promise<{
      reports: ModerationReport[];
      capabilities?: ModerationCapabilities;
    }> => {
      const params = new URLSearchParams({ status: statusFilter });
      if (debouncedSearch) params.set("search", debouncedSearch);
      const response = await fetch(`/api/staff/moderation/reports?${params}`);
      if (!response.ok) throw new Error("Failed to fetch reports");
      return response.json();
    },
    placeholderData: keepPreviousData,
  });
  const reports = reportsData?.reports ?? [];
  // Banning is ADMIN-only server-side. Trusting the server's answer rather than
  // guessing from the session keeps the button and the 403 in agreement.
  const canModerateUsers = reportsData?.capabilities?.canModerateUsers ?? false;

  // Fetch profile verifications
  const {
    data: profilesData,
    isPending: loadingProfiles,
    isFetching: fetchingProfiles,
    isError: profilesError,
    refetch: refetchProfiles,
  } = useQuery({
    queryKey: ["staff-moderation-profiles", "PENDING"],
    queryFn: async (): Promise<{ verifications: ProfileVerification[] }> => {
      const response = await fetch(
        "/api/staff/moderation/profiles?status=PENDING",
      );
      if (!response.ok) throw new Error("Failed to fetch profiles");
      return response.json();
    },
    placeholderData: keepPreviousData,
  });
  const profiles = profilesData?.verifications ?? [];

  // Fetch reviews
  const {
    data: reviewsData,
    isPending: loadingReviews,
    isFetching: fetchingReviews,
    isError: reviewsError,
    refetch: refetchReviews,
  } = useQuery({
    queryKey: ["staff-moderation-reviews", 10],
    queryFn: async (): Promise<{ reviews: ModerationReview[] }> => {
      const response = await fetch("/api/staff/moderation/reviews?limit=10");
      if (!response.ok) throw new Error("Failed to fetch reviews");
      return response.json();
    },
    placeholderData: keepPreviousData,
  });
  const reviews = reviewsData?.reviews ?? [];

  const isRefreshing =
    fetchingStats || fetchingReports || fetchingProfiles || fetchingReviews;

  const handleRefreshAll = () => {
    refetchStats();
    refetchReports();
    refetchProfiles();
    refetchReviews();
  };

  // Handle report action (dismiss or take action). UI verbs map to the
  // ModerationActionType enum the API validates against (#693).
  const REPORT_ACTION_TYPE = {
    DISMISS: "NO_ACTION",
    WARN: "WARNING_ISSUED",
    REMOVE_CONTENT: "CONTENT_REMOVED",
    SUSPEND: "USER_SUSPENDED",
    BAN: "USER_BANNED",
  } as const;
  type ReportActionKey = keyof typeof REPORT_ACTION_TYPE;

  const reportActionMutation = useMutation({
    mutationFn: async ({
      reportId,
      action,
    }: {
      reportId: string;
      action: ReportActionKey;
    }) => {
      const response = await fetch(
        `/api/staff/moderation/reports/${reportId}/action`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actionType: REPORT_ACTION_TYPE[action],
            notes: moderationNote,
            ...(action === "SUSPEND" ? { suspensionDays } : {}),
          }),
        },
      );

      if (!response.ok) {
        // surface the server's actionable message (400 validation, 409 resolved)
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? "Failed to process action");
      }
      // The route has always returned `stream` and `errors`; this type omitted
      // them, so the toast below congratulated the moderator on a ban that
      // never reached chat (#1270).
      return response.json() as Promise<{
        sideEffects?: ModerationSideEffects;
      }>;
    },
    onSuccess: (data, { action }) => {
      const sideEffects = data?.sideEffects;
      const cancelled = sideEffects?.cancellations?.engagementsCancelled;
      const refunded = sideEffects?.cancellations?.refundsIssued;
      const detail =
        cancelled || refunded
          ? ` ${cancelled ?? 0} appointment(s) cancelled, ${refunded ?? 0} refund(s) issued.`
          : "";

      if (enforcementIncomplete(sideEffects)) {
        toast({
          title: "Action recorded — enforcement incomplete",
          description: `The decision was saved and ${describeStreamGap(REPORT_ACTION_TYPE[action])}. It will be retried automatically; the report now shows what landed.`,
          variant: "destructive",
        });
        // Move the queue to where the report just went, so the incomplete
        // enforcement is on screen instead of one filter away.
        setStatusFilter("ACTION_TAKEN");
      } else {
        toast({
          title: "Action Completed",
          description: `Report has been ${action === "DISMISS" ? "dismissed" : "processed"} successfully.${detail}`,
        });
      }

      setSelectedReport(null);
      setModerationNote("");
      setSuspensionDays(7);
      queryClient.invalidateQueries({
        queryKey: ["staff-moderation-reports"],
      });
      queryClient.invalidateQueries({ queryKey: ["staff-moderation-stats"] });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to process action",
        variant: "destructive",
      });
    },
  });

  const handleReportAction = (reportId: string, action: ReportActionKey) =>
    reportActionMutation.mutate({ reportId, action });

  /**
   * #1270 — lifting a ban. USER_BANNED deactivates the target on Stream, which
   * is permanent, so an admin who reversed a ban by hand left an account that
   * could sign in but never chat again.
   */
  const unbanMutation = useMutation({
    mutationFn: async (reportId: string) => {
      const response = await fetch(
        `/api/staff/moderation/reports/${reportId}/unban`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notes: moderationNote }),
        },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? "Failed to lift the ban");
      }
      return response.json() as Promise<{
        sideEffects?: ModerationSideEffects;
      }>;
    },
    onSuccess: (data) => {
      if (enforcementIncomplete(data?.sideEffects)) {
        toast({
          title: "Ban lifted — chat not restored",
          description: `The account can sign in again, but ${describeStreamGap("USER_REINSTATED")}. It will be retried automatically.`,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Ban lifted",
          description: "The account is reinstated and can use chat again.",
        });
      }
      setSelectedReport(null);
      setModerationNote("");
      queryClient.invalidateQueries({
        queryKey: ["staff-moderation-reports"],
      });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to lift the ban",
        variant: "destructive",
      });
    },
  });

  const busy = reportActionMutation.isPending || unbanMutation.isPending;

  interface ReportActionButton {
    key: ReportActionKey;
    label: string;
    icon: LucideIcon;
    variant: "outline" | "destructive";
    className?: string;
    disabled?: boolean;
  }

  /**
   * Which decisions are actually available on this report right now. A resolved
   * report offers none, because the route answers 409; Suspend and Ban are
   * withheld unless the server says this account holds `users.moderate`, rather
   * than being shown to every moderator and answering 403 on click.
   */
  const availableActions = (report: ModerationReport): ReportActionButton[] => {
    if (!OPEN_REPORT_STATUSES.has(report.status)) return [];
    const actions: ReportActionButton[] = [
      {
        key: "DISMISS",
        label: "Dismiss",
        icon: CheckCircle2,
        variant: "outline",
        className: "text-green-600 dark:text-green-400",
      },
      { key: "WARN", label: "Warn", icon: XCircle, variant: "outline" },
    ];
    // CONTENT_REMOVED only removes something when the report points at one:
    // offering it on a report with neither a message nor a review resolves the
    // report and deletes nothing, which is the defect it was added to fix.
    if (report.streamMessageId || report.reviewId) {
      actions.push({
        key: "REMOVE_CONTENT",
        label: "Remove content",
        icon: Trash2,
        variant: "outline",
      });
    }
    if (canModerateUsers) {
      actions.push(
        {
          key: "SUSPEND",
          label: "Suspend",
          icon: XCircle,
          variant: "destructive",
          disabled: !Number.isFinite(suspensionDays),
        },
        { key: "BAN", label: "Ban", icon: XCircle, variant: "destructive" },
      );
    }
    return actions;
  };

  // Handle profile verification
  const profileVerificationMutation = useMutation({
    mutationFn: async ({
      verificationId,
      status,
    }: {
      verificationId: string;
      status: "APPROVED" | "REJECTED" | "NEEDS_INFO";
    }) => {
      const response = await fetch(
        `/api/staff/moderation/profiles/${verificationId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status,
            reviewNotes: moderationNote,
            // For rejection or needs_info, include the note as feedback
            ...(status === "REJECTED" || status === "NEEDS_INFO"
              ? {
                  rejectionReason: moderationNote,
                  feedbackDetails: moderationNote,
                }
              : {}),
          }),
        },
      );

      if (!response.ok) throw new Error("Failed to update verification");
    },
    onSuccess: (_data, { status }) => {
      const statusMessages = {
        APPROVED: "approved",
        REJECTED: "rejected",
        NEEDS_INFO: "marked as needing more information",
      };

      toast({
        title: "Profile Updated",
        description: `Profile has been ${statusMessages[status]}`,
      });

      setSelectedProfile(null);
      setModerationNote("");
      queryClient.invalidateQueries({
        queryKey: ["staff-moderation-profiles"],
      });
      queryClient.invalidateQueries({ queryKey: ["staff-moderation-stats"] });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to update profile verification",
        variant: "destructive",
      });
    },
  });

  const handleProfileVerification = (
    verificationId: string,
    status: "APPROVED" | "REJECTED" | "NEEDS_INFO",
  ) => profileVerificationMutation.mutate({ verificationId, status });

  // Handle review deletion
  const deleteReviewMutation = useMutation({
    mutationFn: async (reviewId: string) => {
      const response = await fetch(
        `/api/staff/moderation/reviews/${reviewId}`,
        {
          method: "DELETE",
        },
      );

      if (!response.ok) throw new Error("Failed to delete review");
    },
    onSuccess: () => {
      toast({
        title: "Review Deleted",
        description: "The review has been removed",
      });

      queryClient.invalidateQueries({
        queryKey: ["staff-moderation-reviews"],
      });
      queryClient.invalidateQueries({ queryKey: ["staff-moderation-stats"] });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to delete review",
        variant: "destructive",
      });
    },
  });

  const handleDeleteReview = (reviewId: string) =>
    deleteReviewMutation.mutate(reviewId);

  // #997 secondary findings — search now happens server-side (debounced
  // above); `reports` is already the filtered set.

  return (
    <div className="space-y-6">
      {/* Header */}
      <DashboardHeader
        title="Content Moderation"
        subtitle="Review and moderate platform content"
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefreshAll}
            disabled={isRefreshing}
          >
            <RefreshCw
              className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`}
            />
          </Button>
        }
      />

      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-muted">
              <Flag className="h-5 w-5 text-foreground" />
            </div>
            <div>
              {loadingStats ? (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              ) : (
                <p className="text-2xl font-bold">
                  {stats?.pendingReports ?? 0}
                </p>
              )}
              <p className="text-sm text-muted-foreground">Pending Reports</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-muted">
              <User className="h-5 w-5 text-foreground" />
            </div>
            <div>
              {loadingStats ? (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              ) : (
                <p className="text-2xl font-bold">
                  {stats?.pendingProfiles ?? 0}
                </p>
              )}
              <p className="text-sm text-muted-foreground">
                Profiles to Verify
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-muted">
              <Star className="h-5 w-5 text-foreground" />
            </div>
            <div>
              {loadingStats ? (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              ) : (
                <p className="text-2xl font-bold">
                  {stats?.pendingReviews ?? 0}
                </p>
              )}
              <p className="text-sm text-muted-foreground">Reviews to Check</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-muted">
              <CheckCircle2 className="h-5 w-5 text-foreground" />
            </div>
            <div>
              {loadingStats ? (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              ) : (
                <p className="text-2xl font-bold">
                  {stats?.resolvedToday ?? 0}
                </p>
              )}
              <p className="text-sm text-muted-foreground">Resolved Today</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="reports" className="gap-2">
            <Flag className="h-4 w-4" />
            Reports
            <Badge variant="secondary" className="ml-1">
              {stats?.pendingReports ?? 0}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="profiles" className="gap-2">
            <User className="h-4 w-4" />
            Profile Verification
            <Badge variant="secondary" className="ml-1">
              {stats?.pendingProfiles ?? 0}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="reviews" className="gap-2">
            <Star className="h-4 w-4" />
            Reviews
            <Badge variant="secondary" className="ml-1">
              {reviews.length}
            </Badge>
          </TabsTrigger>
        </TabsList>

        {/* Reports Tab */}
        <TabsContent value="reports" className="space-y-4">
          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search reports..."
                  className="pl-9"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {REPORT_STATUS_FILTERS.map((filter) => (
                  <Button
                    key={filter.value}
                    type="button"
                    size="sm"
                    variant={
                      statusFilter === filter.value ? "default" : "outline"
                    }
                    onClick={() => setStatusFilter(filter.value)}
                  >
                    {filter.label}
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>

          {reportsError && !reportsData ? (
            <div className="flex flex-col items-center justify-center py-8 gap-3 text-center">
              <div className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                <span>Failed to load moderation reports.</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => refetchReports()}
              >
                <RefreshCw className="h-4 w-4" />
                Retry
              </Button>
            </div>
          ) : loadingReports ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : reports.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">
              No pending reports
            </p>
          ) : (
            <div className="space-y-3">
              {reports.map((report) => (
                <Card
                  key={report.id}
                  className="cursor-pointer hover:shadow-md transition-shadow"
                  onClick={() => setSelectedReport(report)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3">
                        <div className="p-2 rounded-lg bg-muted text-foreground">
                          {getTypeIcon(report.type)}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="font-medium">
                              {report.id.slice(0, 8)}...
                            </p>
                            <Badge variant="outline" className="capitalize">
                              {report.type}
                            </Badge>
                            <Badge
                              className={getStatusColor(report.status)}
                              variant="secondary"
                            >
                              {report.status}
                            </Badge>
                          </div>
                          <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                            {report.contentText ||
                              report.description ||
                              report.reason}
                          </p>
                          <div className="flex flex-wrap items-center gap-4 mt-2 text-xs text-muted-foreground">
                            <span>
                              Reported by:{" "}
                              {report.reportedBy?.name || "Anonymous"}
                            </span>
                            <span>
                              Against:{" "}
                              {report.targetUser.name ||
                                report.targetUser.email}
                            </span>
                            <span>Reason: {report.reason}</span>
                            {report.reportCount > 1 && (
                              <span>{report.reportCount} reports</span>
                            )}
                          </div>
                          {enforcementIncomplete(
                            report.latestAction?.sideEffects,
                          ) && (
                            <p className="mt-2 flex items-center gap-1 text-xs text-destructive">
                              <AlertTriangle className="h-3 w-3" />
                              Enforcement incomplete —{" "}
                              {describeStreamGap(
                                report.latestAction?.actionType ?? "",
                              )}
                            </p>
                          )}
                        </div>
                      </div>
                      <span className="text-xs text-muted-foreground/70">
                        {formatDate(report.createdAt)}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Profiles Tab */}
        <TabsContent value="profiles" className="space-y-4">
          {profilesError && !profilesData ? (
            <div className="flex flex-col items-center justify-center py-8 gap-3 text-center">
              <div className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                <span>Failed to load profile verifications.</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => refetchProfiles()}
              >
                <RefreshCw className="h-4 w-4" />
                Retry
              </Button>
            </div>
          ) : loadingProfiles ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : profiles.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">
              No pending profile verifications
            </p>
          ) : (
            <div className="space-y-3">
              {profiles.map((profile) => (
                <Card
                  key={profile.id}
                  className="cursor-pointer hover:shadow-md transition-shadow"
                  onClick={() => setSelectedProfile(profile)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-4">
                        <Avatar className="h-12 w-12">
                          <AvatarImage src={profile.consultant.image || ""} />
                          <AvatarFallback>
                            {(profile.consultant.name || "?")
                              .split(" ")
                              .map((n: string) => n[0])
                              .join("")}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <p className="font-medium">
                            {profile.consultant.name || "Unnamed"}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {profile.consultant.email}
                          </p>
                          <div className="flex items-center gap-2 mt-1">
                            {profile.consultant.headline && (
                              <span className="text-sm text-muted-foreground">
                                {profile.consultant.headline}
                              </span>
                            )}
                            {profile.consultant.experience && (
                              <span className="text-xs text-muted-foreground">
                                • {profile.consultant.experience} years
                                experience
                              </span>
                            )}
                          </div>
                          {profile.consultant.linkedinUrl && (
                            <a
                              href={profile.consultant.linkedinUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-foreground underline-offset-2 hover:underline flex items-center gap-1 mt-1"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <ExternalLink className="h-3 w-3" />
                              LinkedIn Profile
                            </a>
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">
                          Pending Review
                        </Badge>
                        <p className="text-xs text-muted-foreground/70 mt-1">
                          {formatDate(profile.submittedAt)}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {profile.consultant.domain}
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 flex items-center gap-2">
                      <FileText className="h-4 w-4 text-muted-foreground/70" />
                      <span className="text-sm text-muted-foreground">
                        {profile.documents.length} document
                        {profile.documents.length !== 1 ? "s" : ""} attached
                      </span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Reviews Tab */}
        <TabsContent value="reviews" className="space-y-4">
          {reviewsError && !reviewsData ? (
            <div className="flex flex-col items-center justify-center py-8 gap-3 text-center">
              <div className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                <span>Failed to load reviews.</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => refetchReviews()}
              >
                <RefreshCw className="h-4 w-4" />
                Retry
              </Button>
            </div>
          ) : loadingReviews ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : reviews.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">
              No reviews to check
            </p>
          ) : (
            <div className="space-y-3">
              {reviews.map((review) => {
                const consulteeName = review.consultee?.name || "Anonymous";
                const consulteeImage = review.consultee?.image || "";
                const consultantName =
                  review.consultation?.consultant?.user?.name || "Consultant";

                return (
                  <Card key={review.id}>
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between">
                        <div className="flex items-start gap-3">
                          <Avatar>
                            <AvatarImage src={consulteeImage} />
                            <AvatarFallback>
                              {consulteeName
                                .split(" ")
                                .map((n) => n[0])
                                .join("")}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="font-medium">{consulteeName}</p>
                              <span className="text-muted-foreground/70">
                                →
                              </span>
                              <p className="text-muted-foreground">
                                {consultantName}
                              </p>
                            </div>
                            <div className="flex items-center gap-1 mt-1">
                              {Array.from({ length: 5 }).map((_, i) => (
                                <Star
                                  key={i}
                                  className={`h-4 w-4 ${
                                    i < review.rating
                                      ? "text-yellow-400 fill-yellow-400"
                                      : "text-muted-foreground/30"
                                  }`}
                                />
                              ))}
                            </div>
                            {review.comment && (
                              <p className="text-sm text-muted-foreground mt-2">
                                {review.comment}
                              </p>
                            )}
                          </div>
                        </div>
                        <span className="text-xs text-muted-foreground/70">
                          {formatDate(review.createdAt)}
                        </span>
                      </div>
                      <div className="flex justify-end gap-2 mt-4">
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1"
                          onClick={() => handleDeleteReview(review.id)}
                        >
                          <ThumbsDown className="h-4 w-4" />
                          Remove
                        </Button>
                        <Button size="sm" className="gap-1">
                          <ThumbsUp className="h-4 w-4" />
                          Approve
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Report Detail Dialog */}
      <ResponsiveModal
        open={!!selectedReport}
        onOpenChange={() => setSelectedReport(null)}
      >
        <ResponsiveModalContent className="max-w-2xl">
          {selectedReport && (
            <>
              <ResponsiveModalHeader>
                <ResponsiveModalTitle className="flex items-center gap-2">
                  <Flag className="h-5 w-5 text-red-500" />
                  Report {selectedReport.id.slice(0, 8)}...
                </ResponsiveModalTitle>
                <ResponsiveModalDescription>
                  Review and take action on this report
                </ResponsiveModalDescription>
              </ResponsiveModalHeader>
              <div className="space-y-4">
                {/* #1270 — the excerpt has been captured at report time since
                    the report button shipped and was never rendered, so bans
                    were decided on a reason string alone. */}
                {selectedReport.contentText ? (
                  <div className="p-4 rounded-lg border bg-muted">
                    <Label className="text-sm font-medium">
                      Reported content
                    </Label>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                      {selectedReport.contentText}
                    </p>
                    {selectedReport.streamChannelCid && (
                      <p className="mt-2 text-xs text-muted-foreground/70">
                        Channel {selectedReport.streamChannelCid}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="p-4 rounded-lg border border-dashed">
                    <Label className="text-sm font-medium">
                      Reported content
                    </Label>
                    <p className="mt-1 text-sm text-muted-foreground">
                      The reporter sent no excerpt with this report.
                    </p>
                  </div>
                )}
                {selectedReport.description && (
                  <div>
                    <Label className="text-sm font-medium">
                      Reporter&apos;s description
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      {selectedReport.description}
                    </p>
                  </div>
                )}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Label className="text-sm font-medium">Reported By</Label>
                    <p className="text-sm text-muted-foreground">
                      {selectedReport.reportedBy?.name || "Anonymous"}
                    </p>
                    <p className="text-xs text-muted-foreground/70">
                      {selectedReport.reportedBy?.email}
                    </p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium">Target User</Label>
                    <p className="text-sm text-muted-foreground">
                      {selectedReport.targetUser.name ||
                        selectedReport.targetUser.email}
                    </p>
                    <p className="text-xs text-muted-foreground/70">
                      {selectedReport.targetUser.role}
                      {describeEnforcementState(selectedReport.targetUser)}
                    </p>
                  </div>
                </div>
                <div>
                  <Label className="text-sm font-medium">Reason</Label>
                  <p className="text-sm text-muted-foreground">
                    {selectedReport.reason}
                    {selectedReport.reportCount > 1
                      ? ` (${selectedReport.reportCount} reports)`
                      : ""}
                  </p>
                </div>
                {selectedReport.latestAction && (
                  <EnforcementSummary action={selectedReport.latestAction} />
                )}
                <div>
                  <Label htmlFor="note">Moderation Note</Label>
                  <Textarea
                    id="note"
                    placeholder="Add a note about your decision..."
                    className="mt-1"
                    value={moderationNote}
                    onChange={(e) => setModerationNote(e.target.value)}
                  />
                </div>
                <div className={canModerateUsers ? "" : "hidden"}>
                  <Label className="text-sm font-medium">
                    Suspension duration (applies to Suspend only)
                  </Label>
                  <div className="mt-1 flex items-center gap-2">
                    {[7, 30, 90].map((days) => (
                      <Button
                        key={days}
                        type="button"
                        size="sm"
                        variant={
                          suspensionDays === days ? "default" : "outline"
                        }
                        onClick={() => setSuspensionDays(days)}
                        disabled={reportActionMutation.isPending}
                      >
                        {days} days
                      </Button>
                    ))}
                    <Input
                      type="number"
                      min={1}
                      max={365}
                      className="w-24"
                      value={
                        Number.isFinite(suspensionDays) ? suspensionDays : ""
                      }
                      onChange={(e) => {
                        // NaN sentinel lets the field be cleared while typing;
                        // the Suspend button disables until a valid number is back
                        if (e.target.value === "") {
                          setSuspensionDays(Number.NaN);
                          return;
                        }
                        // Reject decimals (e.g. "7.5") rather than truncating
                        // them; invalid input falls back to the NaN sentinel so
                        // the Suspend button stays disabled until a valid whole
                        // number in range is entered.
                        const v = Number(e.target.value);
                        setSuspensionDays(
                          Number.isInteger(v)
                            ? Math.min(365, Math.max(1, v))
                            : Number.NaN,
                        );
                      }}
                      disabled={reportActionMutation.isPending}
                      aria-label="Custom suspension days"
                    />
                  </div>
                </div>
              </div>
              <ResponsiveModalFooter className="gap-2">
                <Button
                  variant="outline"
                  onClick={() => setSelectedReport(null)}
                  disabled={busy}
                >
                  Close
                </Button>
                {/* One button per available action, from a list, so adding
                    "Remove content" did not mean a sixth copy of the same
                    twelve lines. */}
                {availableActions(selectedReport).map((action) => {
                  const Icon = action.icon;
                  return (
                    <Button
                      key={action.key}
                      variant={action.variant}
                      className={action.className}
                      onClick={() =>
                        handleReportAction(selectedReport.id, action.key)
                      }
                      disabled={busy || action.disabled}
                    >
                      {/* #1270 review — the CLICKED button only. `isPending`
                          is shared by every generated action, so one running
                          action used to spin all of them and read as though the
                          whole panel were busy. */}
                      {reportActionMutation.isPending &&
                      reportActionMutation.variables?.action ===
                        action.key ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Icon className="h-4 w-4 mr-2" />
                      )}
                      {action.label}
                    </Button>
                  );
                })}
                {canModerateUsers && selectedReport.targetUser.banned && (
                  <Button
                    variant="outline"
                    onClick={() => unbanMutation.mutate(selectedReport.id)}
                    disabled={busy}
                  >
                    {unbanMutation.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <ShieldOff className="h-4 w-4 mr-2" />
                    )}
                    Lift ban
                  </Button>
                )}
              </ResponsiveModalFooter>
            </>
          )}
        </ResponsiveModalContent>
      </ResponsiveModal>

      {/* Profile Verification Dialog */}
      <ResponsiveModal
        open={!!selectedProfile}
        onOpenChange={() => setSelectedProfile(null)}
      >
        <ResponsiveModalContent className="max-w-2xl">
          {selectedProfile && (
            <>
              <ResponsiveModalHeader>
                <ResponsiveModalTitle>
                  Profile Verification
                </ResponsiveModalTitle>
                <ResponsiveModalDescription>
                  Review consultant profile and documents
                </ResponsiveModalDescription>
              </ResponsiveModalHeader>
              <div className="space-y-4">
                <div className="flex items-center gap-4 p-4 rounded-lg bg-muted">
                  <Avatar className="h-16 w-16">
                    <AvatarImage src={selectedProfile.consultant.image || ""} />
                    <AvatarFallback className="text-lg">
                      {(selectedProfile.consultant.name || "?")
                        .split(" ")
                        .map((n: string) => n[0])
                        .join("")}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <h3 className="text-lg font-semibold">
                      {selectedProfile.consultant.name || "Unnamed"}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      {selectedProfile.consultant.email}
                    </p>
                    {selectedProfile.consultant.linkedinUrl && (
                      <a
                        href={selectedProfile.consultant.linkedinUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-foreground underline-offset-2 hover:underline flex items-center gap-1 mt-1"
                      >
                        <ExternalLink className="h-3 w-3" />
                        View LinkedIn Profile
                      </a>
                    )}
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Label className="text-sm font-medium">Headline</Label>
                    <p className="text-sm text-muted-foreground">
                      {selectedProfile.consultant.headline || "Not specified"}
                    </p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium">Experience</Label>
                    <p className="text-sm text-muted-foreground">
                      {selectedProfile.consultant.experience
                        ? `${selectedProfile.consultant.experience} years`
                        : "Not specified"}
                    </p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium">Domain</Label>
                    <p className="text-sm text-muted-foreground">
                      {selectedProfile.consultant.domain}
                    </p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium">
                      Current Status
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      {selectedProfile.consultant.verificationStatus}
                    </p>
                  </div>
                </div>
                {selectedProfile.notes && (
                  <div>
                    <Label className="text-sm font-medium">
                      Applicant Notes
                    </Label>
                    <p className="text-sm text-muted-foreground bg-muted p-2 rounded">
                      {selectedProfile.notes}
                    </p>
                  </div>
                )}
                <div>
                  <Label className="text-sm font-medium">
                    Documents ({selectedProfile.documents.length})
                  </Label>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {selectedProfile.documents.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No documents uploaded
                      </p>
                    ) : (
                      selectedProfile.documents.map((doc) => (
                        <Button
                          key={doc.id}
                          variant="outline"
                          size="sm"
                          className="gap-1"
                          asChild
                        >
                          <a
                            href={doc.fileUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <FileText className="h-4 w-4" />
                            {doc.description || doc.originalName}
                            <Eye className="h-3 w-3 ml-1" />
                          </a>
                        </Button>
                      ))
                    )}
                  </div>
                </div>
                <div>
                  <Label htmlFor="verifyNote">
                    Verification Note{" "}
                    <span className="text-xs text-muted-foreground font-normal">
                      (required for Request Info or Reject)
                    </span>
                  </Label>
                  <Textarea
                    id="verifyNote"
                    placeholder="Add notes about the verification... (e.g., what documents or info is needed, reasons for rejection)"
                    className="mt-1"
                    value={moderationNote}
                    onChange={(e) => setModerationNote(e.target.value)}
                  />
                </div>
              </div>
              <ResponsiveModalFooter className="gap-2">
                <Button
                  variant="outline"
                  onClick={() => setSelectedProfile(null)}
                  disabled={profileVerificationMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  variant="outline"
                  className="text-red-600 dark:text-red-400"
                  onClick={() =>
                    handleProfileVerification(selectedProfile.id, "REJECTED")
                  }
                  disabled={profileVerificationMutation.isPending}
                >
                  {profileVerificationMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <XCircle className="h-4 w-4 mr-2" />
                  )}
                  Reject
                </Button>
                <Button
                  variant="outline"
                  className="text-amber-600 border-amber-300 hover:bg-amber-50 dark:text-amber-400 dark:border-amber-800 dark:hover:bg-amber-950"
                  onClick={() =>
                    handleProfileVerification(selectedProfile.id, "NEEDS_INFO")
                  }
                  disabled={
                    profileVerificationMutation.isPending ||
                    !moderationNote.trim()
                  }
                  title={
                    !moderationNote.trim()
                      ? "Add a note explaining what information is needed"
                      : ""
                  }
                >
                  {profileVerificationMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <MessageSquare className="h-4 w-4 mr-2" />
                  )}
                  Request Info
                </Button>
                <Button
                  className="bg-green-600 hover:bg-green-700"
                  onClick={() =>
                    handleProfileVerification(selectedProfile.id, "APPROVED")
                  }
                  disabled={profileVerificationMutation.isPending}
                >
                  {profileVerificationMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                  )}
                  Approve Profile
                </Button>
              </ResponsiveModalFooter>
            </>
          )}
        </ResponsiveModalContent>
      </ResponsiveModal>
    </div>
  );
}
