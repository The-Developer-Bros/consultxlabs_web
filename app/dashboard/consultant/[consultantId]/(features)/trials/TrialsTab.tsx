"use client";

import { useState, useEffect, useCallback } from "react";
import Image from "next/image";
import { useParams } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { trialStatusBadge } from "@/lib/labels/session-labels";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import {
  Gift,
  Calendar,
  Clock,
  User,
  XCircle,
  Loader2,
  RefreshCw,
  Video,
  Search,
  X,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import Link from "next/link";
import { cn } from "@/utils/tailwind";
// #248: no static Stream SDK / lib/meeting import — the shared hook
// lazy-loads both at click time. Type-only imports are erased.
import type { MeetingSlot } from "@/lib/meeting";
import { useLazyJoinMeeting } from "@/hooks/scheduling/useLazyJoinMeeting";
import {
  CONSULTANT_JOIN_WINDOW_MS,
  getJoinableSession,
} from "@/lib/appointments/slots";
import {
  TrialScheduleCalendar,
  SelectedSlot,
} from "./components/TrialScheduleCalendar";

interface TrialSession {
  id: string;
  status: string;
  notes: string | null;
  requestedAt: string;
  completedAt: string | null;
  consulteeProfile: {
    id: string;
    user: {
      id: string;
      name: string;
      email: string;
      image: string | null;
    };
  };
  subscriptionPlan: {
    id: string;
    title: string;
    trialDurationMinutes: number;
  };
  appointment: {
    id: string;
    slotsOfAppointment: Array<{
      id: string;
      startsAt: string;
      endsAt: string;
    }>;
  } | null;
  convertedToSubscription?: {
    id: string;
    subscriptionPlan?: { title: string };
  } | null;
}

interface SubscriptionPlan {
  id: string;
  title: string;
  trialEnabled: boolean;
}

function formatStatus(status: string): string {
  if (status === "REJECTED") return "Declined";
  return status.charAt(0) + status.slice(1).toLowerCase();
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return email;
  const visible = local.slice(0, 2);
  return `${visible}***@${domain}`;
}

// Badge colours come from lib/labels/session-labels (single source of
// truth); the label stays formatStatus() so REJECTED reads "Declined" on
// the consultant side (they did the declining — "Rejected" reads wrong).
const statusBgColors: Record<string, string> = {
  PENDING: "bg-yellow-50 hover:bg-yellow-100 border-yellow-200",
  // Same amber family as PENDING — both are "waiting", and the label says who
  // we're waiting on.
  AWAITING_PAYMENT: "bg-amber-50 hover:bg-amber-100 border-amber-200",
  SCHEDULED: "bg-purple-50 hover:bg-purple-100 border-purple-200",
  COMPLETED: "bg-green-50 hover:bg-green-100 border-green-200",
  CONVERTED: "bg-emerald-50 hover:bg-emerald-100 border-emerald-200",
  CANCELLED: "bg-zinc-50 hover:bg-zinc-100 border-zinc-200",
  REJECTED: "bg-red-50 hover:bg-red-100 border-red-200",
};

const statusTextColors: Record<string, string> = {
  PENDING: "text-yellow-700",
  AWAITING_PAYMENT: "text-amber-700",
  SCHEDULED: "text-purple-700",
  COMPLETED: "text-green-700",
  CONVERTED: "text-emerald-700",
  CANCELLED: "text-zinc-700",
  REJECTED: "text-red-700",
};

export function TrialsTab() {
  const params = useParams();
  const consultantId = params.consultantId as string;
  const { toast } = useToast();
  const joinMeeting = useLazyJoinMeeting();

  const [trials, setTrials] = useState<TrialSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTrial, setSelectedTrial] = useState<TrialSession | null>(null);
  const [showScheduleDialog, setShowScheduleDialog] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isJoining, setIsJoining] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Search, filter, sort state
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [planFilter, setPlanFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<string>("requestedAt");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  // Pagination state
  const [page, setPage] = useState(1);
  const [limit] = useState(10);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  // Summary stats
  const [stats, setStats] = useState<Record<string, number>>({});

  // Subscription plans for filter dropdown
  const [subscriptionPlans, setSubscriptionPlans] = useState<
    SubscriptionPlan[]
  >([]);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const fetchTrials = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams({
        consultantProfileId: consultantId,
        page: page.toString(),
        limit: limit.toString(),
        sortBy,
        sortOrder,
      });

      if (statusFilter !== "all") {
        params.append("status", statusFilter);
      }
      if (planFilter !== "all") {
        params.append("subscriptionPlanId", planFilter);
      }
      if (debouncedSearch) {
        params.append("search", debouncedSearch);
      }

      const response = await fetch(`/api/trials?${params}`);
      if (!response.ok) {
        throw new Error("Failed to fetch trials");
      }

      const { data, meta } = await response.json();
      setTrials(data);
      setTotalPages(meta.totalPages);
      setTotal(meta.total);
    } catch (error) {
      console.error("Error fetching trials:", error);
      toast({
        title: "Error",
        description: "Failed to load trial requests",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [
    consultantId,
    statusFilter,
    planFilter,
    debouncedSearch,
    page,
    limit,
    sortBy,
    sortOrder,
    toast,
  ]);

  const fetchStats = useCallback(async () => {
    try {
      const params = new URLSearchParams({ consultantProfileId: consultantId });
      const response = await fetch(`/api/trials/stats?${params}`);
      if (!response.ok) {
        throw new Error("Failed to fetch stats");
      }
      const { data } = await response.json();
      setStats(data);
    } catch (error) {
      console.error("Error fetching trial stats:", error);
    }
  }, [consultantId]);

  const fetchPlans = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/plans/subscriptions?consultantId=${consultantId}`,
      );
      if (!response.ok) {
        throw new Error("Failed to fetch plans");
      }
      const { data } = await response.json();
      setSubscriptionPlans(
        data.filter((p: SubscriptionPlan) => p.trialEnabled),
      );
    } catch (error) {
      console.error("Error fetching subscription plans:", error);
    }
  }, [consultantId]);

  useEffect(() => {
    fetchTrials();
  }, [fetchTrials]);

  useEffect(() => {
    fetchStats();
    fetchPlans();
  }, [fetchStats, fetchPlans]);

  const handleApprove = async (trial: TrialSession) => {
    setSelectedTrial(trial);
    setShowScheduleDialog(true);
  };

  const handleSlotSelected = async (slot: SelectedSlot) => {
    if (!selectedTrial) return;
    setIsProcessing(true);

    try {
      // Single API call: PENDING → SCHEDULED with slot data
      const response = await fetch(`/api/trials/${selectedTrial.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "SCHEDULED",
          slotData: {
            startsAt: slot.startsAt.toISOString(),
            endsAt: slot.endsAt.toISOString(),
            slotOfAvailabilityId: slot.slotOfAvailabilityId,
            slotType: slot.slotType,
          },
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to schedule trial");
      }

      // A paid trial is NOT scheduled by accepting — it moves to
      // AWAITING_PAYMENT and the learner gets a pay-link. Saying "scheduled"
      // would tell the consultant to expect someone who may never pay.
      const result = await response.json().catch(() => null);
      const awaitingPayment =
        result?.data?.status === "AWAITING_PAYMENT";

      toast({
        title: "Success",
        description: awaitingPayment
          ? "Trial approved. The slot is held while the learner pays — it confirms once payment lands, and is released if they don't pay in time."
          : "Trial session approved and scheduled",
      });

      setShowScheduleDialog(false);
      setSelectedTrial(null);
      fetchTrials();
      fetchStats();
    } catch (error) {
      console.error("Error scheduling trial:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to schedule trial",
        variant: "destructive",
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleReject = async (trialId: string) => {
    try {
      setIsProcessing(true);
      // Use PATCH to set status to REJECTED (consultant declining)
      const response = await fetch(`/api/trials/${trialId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "REJECTED" }),
      });

      if (!response.ok) {
        throw new Error("Failed to decline trial");
      }

      toast({
        title: "Success",
        description: "Trial request declined",
      });

      fetchTrials();
      fetchStats();
    } catch (error) {
      console.error("Error declining trial:", error);
      toast({
        title: "Error",
        description: "Failed to decline trial request",
        variant: "destructive",
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCancel = async (trialId: string) => {
    try {
      setIsProcessing(true);
      // Use DELETE for cancellation of scheduled trials
      const response = await fetch(`/api/trials/${trialId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error("Failed to cancel trial");
      }

      toast({
        title: "Success",
        description: "Trial session cancelled",
      });

      fetchTrials();
      fetchStats();
    } catch (error) {
      console.error("Error cancelling trial:", error);
      toast({
        title: "Error",
        description: "Failed to cancel trial",
        variant: "destructive",
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const formatTime = (dateString: string) => {
    return new Date(dateString).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  };

  /**
   * #1270 — was a hand-rolled 10-minute comparison against
   * `slotsOfAppointment[0]`. Two things were wrong with it: the host window is
   * 15 minutes everywhere else, and reading one row treats a 30-minute slot as
   * the whole session, so a longer trial stopped being joinable half an hour
   * in (#1061). The shared session helper answers both.
   */
  const isTrialJoinable = (trial: TrialSession): boolean => {
    if (trial.status !== "SCHEDULED") return false;
    const appointment = trial.appointment;
    if (!appointment) return false;
    return (
      getJoinableSession(
        // `groupSlotsIntoRuns` buckets rows by appointment and the trials
        // payload omits the FK, so without stamping it every 30-minute row
        // would be its own session (#1061).
        appointment.slotsOfAppointment.map((slot) => ({
          ...slot,
          appointmentId: appointment.id,
        })),
        { joinWindowMs: CONSULTANT_JOIN_WINDOW_MS },
      ) !== null
    );
  };

  const handleJoinMeeting = async (trial: TrialSession) => {
    if (!trial.appointment?.slotsOfAppointment?.[0]) {
      toast({
        title: "Unable to join",
        description: "Meeting information is not available.",
        variant: "destructive",
      });
      return;
    }

    setIsJoining(trial.id);
    const slot = trial.appointment.slotsOfAppointment[0];
    // Minimal appointment shape for the meeting helper; the shared hook
    // lazy-loads the Stream SDK at click time (#248).
    const navigating = await joinMeeting(
      {
        id: trial.appointment.id,
        appointmentType: "TRIAL",
        slotsOfAppointment: trial.appointment.slotsOfAppointment,
      },
      slot as MeetingSlot,
    );
    if (!navigating) setIsJoining(null);
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await Promise.all([fetchTrials(), fetchStats()]);
    setIsRefreshing(false);
  };

  const handleStatusFilterChange = (value: string) => {
    setStatusFilter(value);
    setPage(1);
  };

  const handlePlanFilterChange = (value: string) => {
    setPlanFilter(value);
    setPage(1);
  };

  const handleSortChange = (value: string) => {
    const [by, order] = value.split("-");
    setSortBy(by);
    setSortOrder(order as "asc" | "desc");
    setPage(1);
  };

  const statusOrder = [
    "PENDING",
    // Sits between PENDING and SCHEDULED — it's the step in between.
    "AWAITING_PAYMENT",
    "SCHEDULED",
    "COMPLETED",
    "CONVERTED",
    "CANCELLED",
    "REJECTED",
  ];

  return (
    <TooltipProvider>
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">
            Trial Requests
          </h1>
          <p className="text-zinc-600 mt-1">
            Manage trial session requests from potential subscribers
          </p>
        </div>
        <Button
          variant="outline"
          onClick={handleRefresh}
          disabled={isRefreshing}
          className="w-full sm:w-auto"
        >
          <RefreshCw
            className={`h-4 w-4 mr-2 ${isRefreshing ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      {/* Summary Stats */}
      {Object.keys(stats).length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {statusOrder.map((status) => {
            const count = stats[status] || 0;
            return (
              <button
                key={status}
                onClick={() =>
                  handleStatusFilterChange(
                    statusFilter === status ? "all" : status,
                  )
                }
                className={cn(
                  "p-3 rounded-lg text-center transition-all border",
                  statusBgColors[status],
                  statusFilter === status &&
                    "ring-2 ring-offset-1 ring-blue-500",
                )}
              >
                <div
                  className={cn("text-2xl font-bold", statusTextColors[status])}
                >
                  {count}
                </div>
                <div
                  className={cn(
                    "text-xs font-medium",
                    statusTextColors[status],
                  )}
                >
                  {status === "REJECTED"
                    ? "Declined"
                    : status.charAt(0) + status.slice(1).toLowerCase()}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Search & Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        {/* Search */}
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
          <Input
            placeholder="Search by name or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 pr-9 bg-white"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Status Filter */}
        <Select value={statusFilter} onValueChange={handleStatusFilterChange}>
          <SelectTrigger className="w-full sm:w-40 bg-white">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="PENDING">Pending</SelectItem>
            <SelectItem value="AWAITING_PAYMENT">Awaiting payment</SelectItem>
            <SelectItem value="SCHEDULED">Scheduled</SelectItem>
            <SelectItem value="COMPLETED">Completed</SelectItem>
            <SelectItem value="CONVERTED">Converted</SelectItem>
            <SelectItem value="CANCELLED">Cancelled</SelectItem>
            <SelectItem value="REJECTED">Declined</SelectItem>
          </SelectContent>
        </Select>

        {/* Plan Filter */}
        {subscriptionPlans.length > 0 && (
          <Select value={planFilter} onValueChange={handlePlanFilterChange}>
            <SelectTrigger className="w-full sm:w-48 bg-white">
              <SelectValue placeholder="All Plans" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Plans</SelectItem>
              {subscriptionPlans.map((plan) => (
                <SelectItem key={plan.id} value={plan.id}>
                  {plan.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Sort */}
        <Select
          value={`${sortBy}-${sortOrder}`}
          onValueChange={handleSortChange}
        >
          <SelectTrigger className="w-full sm:w-44 bg-white">
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="requestedAt-desc">Newest First</SelectItem>
            <SelectItem value="requestedAt-asc">Oldest First</SelectItem>
            <SelectItem value="name-asc">Name A-Z</SelectItem>
            <SelectItem value="name-desc">Name Z-A</SelectItem>
            <SelectItem value="status-asc">Status A-Z</SelectItem>
            <SelectItem value="plan-asc">Plan A-Z</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Results count */}
      {total > 0 && (
        <p className="text-sm text-zinc-600">
          Showing {(page - 1) * limit + 1}-{Math.min(page * limit, total)} of{" "}
          {total} trials
        </p>
      )}

      {/* Trial Requests List */}
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : trials.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Gift className="h-12 w-12 mx-auto text-zinc-400 mb-4" />
            <h3 className="text-lg font-medium text-zinc-900 mb-2">
              No trial requests
            </h3>
            <p className="text-zinc-600">
              {statusFilter !== "all" || planFilter !== "all" || debouncedSearch
                ? "No trial requests match your filters"
                : "You don't have any trial requests yet. Enable trials on your subscription plans to start receiving requests."}
            </p>
            {(statusFilter !== "all" ||
              planFilter !== "all" ||
              debouncedSearch) && (
              <Button
                variant="outline"
                className="mt-4"
                onClick={() => {
                  setSearch("");
                  setStatusFilter("all");
                  setPlanFilter("all");
                  setPage(1);
                }}
              >
                Clear Filters
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {trials.map((trial) => (
            <Card key={trial.id} className="overflow-hidden">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    {trial.consulteeProfile.user.image ? (
                      <Image
                        src={trial.consulteeProfile.user.image}
                        alt={trial.consulteeProfile.user.name}
                        width={40}
                        height={40}
                        className="h-10 w-10 rounded-full"
                      />
                    ) : (
                      <div className="h-10 w-10 bg-blue-100 rounded-full flex items-center justify-center">
                        <User className="h-5 w-5 text-muted-foreground" />
                      </div>
                    )}
                    <div>
                      <CardTitle className="text-base">
                        {trial.consulteeProfile.user.name}
                      </CardTitle>
                      <CardDescription>
                        {maskEmail(trial.consulteeProfile.user.email)}
                      </CardDescription>
                    </div>
                  </div>
                  <StatusBadge
                    {...trialStatusBadge(trial.status)}
                    label={formatStatus(trial.status)}
                  />
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                  <div className="flex items-center gap-2 text-sm text-zinc-600">
                    <Gift className="h-4 w-4" />
                    <span>{trial.subscriptionPlan.title}</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-zinc-600">
                    <Clock className="h-4 w-4" />
                    <span>
                      {trial.subscriptionPlan.trialDurationMinutes} min
                      trial
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-zinc-600">
                    <Calendar className="h-4 w-4" />
                    <span>Requested {formatDate(trial.requestedAt)}</span>
                  </div>
                </div>

                {trial.notes && (
                  <div className="bg-zinc-50 rounded-lg p-3 mb-4">
                    <p className="text-sm text-zinc-700">
                      <span className="font-medium">Notes: </span>
                      {trial.notes}
                    </p>
                  </div>
                )}

                {trial.appointment?.slotsOfAppointment?.[0] && (
                  <div className="bg-blue-50 rounded-lg p-3 mb-4">
                    <p className="text-sm text-blue-700">
                      <span className="font-medium">Scheduled: </span>
                      {formatDate(
                        trial.appointment.slotsOfAppointment[0].startsAt,
                      )}{" "}
                      at{" "}
                      {formatTime(
                        trial.appointment.slotsOfAppointment[0].startsAt,
                      )}
                    </p>
                  </div>
                )}

                {/* Action Buttons */}
                <div className="flex items-center gap-2 justify-end">
                  {trial.status === "PENDING" && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleReject(trial.id)}
                        disabled={isProcessing}
                      >
                        <XCircle className="h-4 w-4 mr-1" />
                        Decline
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => handleApprove(trial)}
                        disabled={isProcessing}
                      >
                        <Calendar className="h-4 w-4 mr-1" />
                        Schedule
                      </Button>
                    </>
                  )}
                  {trial.status === "SCHEDULED" && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleCancel(trial.id)}
                        disabled={isProcessing || isJoining === trial.id}
                      >
                        Cancel
                      </Button>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span tabIndex={0}>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleJoinMeeting(trial)}
                              disabled={
                                isProcessing ||
                                isJoining === trial.id ||
                                !isTrialJoinable(trial)
                              }
                              className={
                                isTrialJoinable(trial)
                                  ? "bg-blue-50 text-blue-700 hover:bg-blue-100 border-blue-200"
                                  : ""
                              }
                            >
                              {isJoining === trial.id ? (
                                <>
                                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                                  Joining...
                                </>
                              ) : (
                                <>
                                  <Video className="h-4 w-4 mr-1" />
                                  Join Meeting
                                </>
                              )}
                            </Button>
                          </span>
                        </TooltipTrigger>
                        {!isTrialJoinable(trial) && (
                          <TooltipContent>
                            <p>
                              Available{" "}
                              {CONSULTANT_JOIN_WINDOW_MS / 60_000} minutes
                              before the scheduled time
                            </p>
                          </TooltipContent>
                        )}
                      </Tooltip>
                    </>
                  )}
                  {trial.status === "CONVERTED" && trial.convertedToSubscription && (
                    <Link
                      href={`/dashboard/consultant/${consultantId}/appointments`}
                      className="text-sm text-emerald-700 hover:underline flex items-center gap-1"
                    >
                      <Gift className="h-4 w-4" />
                      View Subscription
                    </Link>
                  )}
                  {trial.status === "COMPLETED" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const planUrl = `${window.location.origin}/explore/experts/${consultantId}`;
                        navigator.clipboard.writeText(planUrl);
                        toast({
                          title: "Link copied",
                          description: "Share this link with the client to invite them to subscribe.",
                        });
                      }}
                    >
                      <Gift className="h-4 w-4 mr-1" />
                      Copy Plan Link
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-6 pt-4 border-t">
              <p className="text-sm text-zinc-600">
                Page {page} of {totalPages}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm min-w-[80px] text-center">
                  {page} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Schedule Dialog with Calendar */}
      <Dialog open={showScheduleDialog} onOpenChange={setShowScheduleDialog}>
        <DialogContent className="max-w-4xl max-h-[90dvh] overflow-hidden flex flex-col">
          <VisuallyHidden>
            <DialogTitle>Schedule Trial Session</DialogTitle>
          </VisuallyHidden>
          {selectedTrial && (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <TrialScheduleCalendar
                consultantId={consultantId}
                trialDurationMinutes={
                  selectedTrial.subscriptionPlan.trialDurationMinutes
                }
                onSlotSelect={handleSlotSelected}
                onCancel={() => {
                  setShowScheduleDialog(false);
                  setSelectedTrial(null);
                }}
                isProcessing={isProcessing}
                consulteeUserName={selectedTrial.consulteeProfile.user.name}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
    </TooltipProvider>
  );
}
