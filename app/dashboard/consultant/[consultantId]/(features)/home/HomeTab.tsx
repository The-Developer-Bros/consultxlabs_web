"use client";

import { useMemo } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
// #248: do NOT statically import the Stream SDK (useStreamVideoClient) or
// lib/meeting (which imports the SDK) here — that would pull the heavy SDK into
// the dashboard-HOME bundle / critical path. The video client + meeting helper
// are acquired lazily inside the Join handler (only when a user clicks Join).
import { useLazyJoinMeeting } from "@/hooks/scheduling/useLazyJoinMeeting";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { DataCard, EmptyState } from "@/components/dashboard/DataCard";
import {
  Calendar,
  Clock,
  Video,
  ChevronRight,
  FileText,
  Building2,
} from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { resolveSponsoringOrgName as resolveSponsoringOrgNameShared } from "@/lib/labels/session-labels";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  calculateSessionProgress,
  formatAppointmentTime,
  getAppointmentStatus,
  getAppointmentTypeAndPlan,
  getConsumeeImage,
  getConsumeeName,
  getStartTime,
  getNextUpcomingSlotTime,
  groupRecurringAppointments,
  sortAppointmentsByStartTime,
  getTodayAppointments,
  getUpcomingAppointments,
  getCollaboratorRole,
  formatCollaboratorRole,
  getRoleBadgeStyle,
} from "../../utils/appointmentHelpers";

import { ActionRequiredPanel } from "@/components/dashboard/ActionRequiredPanel";
import { deriveConsultantActionItems } from "@/lib/dashboard/action-items";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import {
  eventUnionStatusBadge,
  isConfirmedStatus,
} from "@/lib/appointments/status";
import { getProximityLabel } from "@/lib/appointments/slots";
import { getAppointmentLifecycleStatus } from "@/lib/appointments/map-consultant";
import { TAppointment } from "@/types/appointment";
import { getJoinableSlot } from "../../utils/joinState";
import { getInitials } from "@/utils/formatting";
import { RequestSlotAllocationTabMini } from "@/components/dashboard/shared/requests/RequestSlotAllocationTabMini";
import { PerformanceSnapshot } from "./PerformanceSnapshot";
import { FinancialSummary } from "./FinancialSummary";
import type {
  TPerformanceSnapshot,
  TFinancialSummary,
} from "@/types/consultant-events";

interface HomeTabProps {
  appointments: TAppointment[];
  consultantId: string;
  pendingRequestsCount?: number;
  performanceSnapshot?: TPerformanceSnapshot;
  financialSummary?: TFinancialSummary;
}

const staggerChildren = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.1 },
  },
};

const fadeInUp = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4 } },
};

export function HomeTab({
  appointments,
  consultantId,
  pendingRequestsCount = 0,
  performanceSnapshot,
  financialSummary,
}: Readonly<HomeTabProps>) {
  const router = useRouter();
  const joinMeeting = useLazyJoinMeeting();
  const { data: session } = useSession();
  // Sponsoring-org lookup for the indigo "Sponsored · <Org>" badge —
  // shows on org-funded appointments only, mirroring the consultee
  // dashboard convention. Resolution lives in session-labels so every
  // surface renders the same name.
  const orgMemberships = session?.user?.organizationMemberships ?? [];
  const resolveSponsoringOrgName = (orgId: string | null | undefined) =>
    resolveSponsoringOrgNameShared(orgId, orgMemberships);

  // #248: the shared hook reads the connected client singleton at click
  // time and lazy-imports lib/meeting, keeping the Stream SDK off the home
  // bundle. This used to be a private copy of that pattern.
  const handleJoinMeeting = (
    appointment: TAppointment,
    joinableSlot?: TAppointment["slotsOfAppointment"][number],
  ) => void joinMeeting(appointment, joinableSlot);

  const expandedAppointments = useMemo(() => appointments || [], [appointments]);

  const APPOINTMENT_DISPLAY_LIMIT = 8;

  const allTodayAppointments = useMemo(
    () =>
      getTodayAppointments(expandedAppointments).filter(
        (appointment) => getAppointmentStatus(appointment) !== "Completed",
      ),
    [expandedAppointments],
  );

  const todayAppointments = useMemo(
    () => allTodayAppointments.slice(0, APPOINTMENT_DISPLAY_LIMIT),
    [allTodayAppointments],
  );

  const allUpcomingAppointments = useMemo(
    () =>
      sortAppointmentsByStartTime(
        getUpcomingAppointments(expandedAppointments),
      ),
    [expandedAppointments],
  );

  const upcomingGroups = useMemo(() => {
    const groupedAll = groupRecurringAppointments(allUpcomingAppointments);
    return Object.entries(groupedAll)
      .sort(([keyA, aptsA], [keyB, aptsB]) => {
        const isRecurringA =
          keyA.startsWith("subscription-") || keyA.startsWith("class-");
        const isRecurringB =
          keyB.startsWith("subscription-") || keyB.startsWith("class-");
        const timeA = isRecurringA
          ? getNextUpcomingSlotTime(aptsA[0])
          : getStartTime(aptsA[0]);
        const timeB = isRecurringB
          ? getNextUpcomingSlotTime(aptsB[0])
          : getStartTime(aptsB[0]);
        if (!timeA && !timeB) return 0;
        if (!timeA) return 1;
        if (!timeB) return -1;
        return timeA.getTime() - timeB.getTime();
      })
      .slice(0, 5);
  }, [allUpcomingAppointments]);


  // "Needs you now" — derived from data already on the page, so no extra
  // fetch. The rows go over whole, ids and ends included: these are raw
  // 30-minute slot rows, and without them a two-hour booking reported its
  // second half as a separate session starting in 30 minutes (#1061).
  const actionItems = useMemo(
    () =>
      deriveConsultantActionItems({
        pendingApprovals: pendingRequestsCount,
        upcomingSessions: allUpcomingAppointments.flatMap((a) =>
          (a.slotsOfAppointment ?? []).map((slot) => ({
            id: slot.id,
            appointmentId: a.id,
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
            title: getAppointmentTypeAndPlan(a),
          })),
        ),
        basePath: `/dashboard/consultant/${consultantId}`,
      }),
    [allUpcomingAppointments, pendingRequestsCount, consultantId],
  );

  return (
    <>
      {/* The header is rendered by the server page, outside the Suspense
          boundary, so it can paint as real text while this tab is still
          waiting on data. Keeping a copy here would double it up. */}
      <DashboardContent>
        <motion.div
          variants={staggerChildren}
          initial="hidden"
          animate="visible"
          className="space-y-6"
        >
          {/* What's actually blocked on this consultant, above everything
              else. Renders nothing when the queue is clear. */}
          <ActionRequiredPanel items={actionItems} className="space-y-2" />

          {/* Performance Snapshot */}
          {performanceSnapshot && (
            <motion.div variants={fadeInUp}>
              <PerformanceSnapshot {...performanceSnapshot} />
            </motion.div>
          )}

          {/* Main Content Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
            {/* Left Column - Today's Appointments + Upcoming Sessions */}
            <motion.div variants={fadeInUp} className="lg:col-span-3 space-y-6">
              {/* Today's Appointments */}
              <DataCard
                title="Today's Appointments"
                icon={Calendar}
                viewAllLink={`/dashboard/consultant/${consultantId}/appointments`}
              >
                {todayAppointments.length > 0 ? (
                  <div className="divide-y divide-zinc-100">
                    {todayAppointments.map((appointment) => {
                      const userName = getConsumeeName(appointment);
                      const startTime = getStartTime(appointment);
                      const joinableSlot = getJoinableSlot(
                        appointment.slotsOfAppointment ?? [],
                      );
                      // #1270 — this row had NO status check at all: any
                      // appointment with a slot inside the window lit up Join,
                      // including one still awaiting payment or already
                      // completed. The same guard the appointments adapter and
                      // the consultee side use.
                      const isJoinable =
                        joinableSlot !== null &&
                        isConfirmedStatus(
                          getAppointmentLifecycleStatus(appointment),
                        );
                      // Explicit opt-in, not "any non-production build" — see
                      // the note on the appointments adapter's own flag.
                      const isDev =
                        process.env.NEXT_PUBLIC_ENABLE_DEV_TOOLS === "true";

                      return (
                        <div
                          key={appointment.id}
                          className="flex items-center gap-4 py-3 first:pt-0 last:pb-0 hover:bg-zinc-50/50 -mx-5 px-5 transition-colors"
                        >
                          <Avatar className="h-10 w-10 flex-shrink-0 ring-2 ring-white shadow-sm">
                            <AvatarImage
                              alt={userName}
                              src={getConsumeeImage(appointment)}
                            />
                            <AvatarFallback className="bg-zinc-100 text-zinc-600 font-medium text-sm">
                              {getInitials(userName)}
                            </AvatarFallback>
                          </Avatar>

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3 className="font-medium text-zinc-900 truncate text-sm">
                                {userName}
                              </h3>
                              {(() => {
                                const sponsoringOrgName =
                                  resolveSponsoringOrgName(
                                    appointment.organizationId,
                                  );
                                return sponsoringOrgName ? (
                                  <Badge
                                    className="text-[10px] font-semibold px-2 py-0.5 bg-indigo-50 text-indigo-700 border-0 rounded-md inline-flex items-center gap-1 max-w-[200px]"
                                    title={`Sponsored by ${sponsoringOrgName}`}
                                  >
                                    <Building2 className="h-3 w-3 shrink-0" />
                                    <span className="truncate">
                                      Sponsored · {sponsoringOrgName}
                                    </span>
                                  </Badge>
                                ) : null;
                              })()}
                              {(() => {
                                const role = getCollaboratorRole(
                                  appointment,
                                  consultantId,
                                );
                                return role ? (
                                  <Badge
                                    className={`text-[10px] px-1.5 py-0 h-5 flex-shrink-0 ${getRoleBadgeStyle(role)}`}
                                  >
                                    {formatCollaboratorRole(role)}
                                  </Badge>
                                ) : null;
                              })()}
                            </div>
                            <p className="text-xs text-zinc-500 truncate">
                              {getAppointmentTypeAndPlan(appointment)}
                            </p>
                          </div>

                          <div className="flex items-center gap-2 text-sm text-zinc-500 flex-shrink-0">
                            <Clock className="h-3.5 w-3.5" />
                            <span>
                              {startTime
                                ? formatAppointmentTime(startTime.toISOString())
                                : "TBD"}
                            </span>
                          </div>

                          <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
                            <StatusBadge
                              {...eventUnionStatusBadge(
                                getAppointmentLifecycleStatus(appointment),
                              )}
                              withDot
                              size="sm"
                            />
                            {(() => {
                              const proximity = getProximityLabel(
                                getNextUpcomingSlotTime(appointment),
                              );
                              return proximity ? (
                                <span className="text-[10px] text-zinc-400">
                                  {proximity}
                                </span>
                              ) : null;
                            })()}
                          </div>

                          {isJoinable && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    onClick={() =>
                                      handleJoinMeeting(
                                        appointment,
                                        joinableSlot ?? undefined,
                                      )
                                    }
                                    className="flex-shrink-0 bg-zinc-900 hover:bg-zinc-800 text-white gap-1.5"
                                    size="sm"
                                  >
                                    <Video className="h-3.5 w-3.5" />
                                    Join
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>Join the meeting room</p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                          {/* #1270 — additive, never a gate replacement. The
                              dev arm used to BE the gate here (`isDev ||
                              isJoinable`, `disabled={isDev ? false :
                              !isJoinable}`), which also mislabelled every
                              genuine Join as "Join (Dev)" on a dev build. It
                              is now a distinct button that shows only where
                              the real one does not. */}
                          {isDev && !isJoinable && (
                            <Button
                              onClick={() =>
                                handleJoinMeeting(
                                  appointment,
                                  joinableSlot ?? undefined,
                                )
                              }
                              variant="outline"
                              className="flex-shrink-0 gap-1.5"
                              size="sm"
                            >
                              <Video className="h-3.5 w-3.5" />
                              Join (Dev)
                            </Button>
                          )}
                        </div>
                      );
                    })}
                    {allTodayAppointments.length > APPOINTMENT_DISPLAY_LIMIT && (
                      <div className="pt-3 text-center">
                        <Link
                          href={`/dashboard/consultant/${consultantId}/appointments`}
                          className="text-sm text-zinc-500 hover:text-zinc-700 transition-colors"
                        >
                          View all {allTodayAppointments.length} appointments
                        </Link>
                      </div>
                    )}
                  </div>
                ) : (
                  <EmptyState
                    icon={Calendar}
                    title="No appointments today"
                    description="Enjoy your free time or check upcoming sessions"
                    action={
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" asChild>
                          <Link href={`/dashboard/consultant/${consultantId}/planner`}>
                            Set up availability
                          </Link>
                        </Button>
                        <Button variant="outline" size="sm" asChild>
                          <Link href={`/dashboard/consultant/${consultantId}/appointments`}>
                            View all appointments
                          </Link>
                        </Button>
                      </div>
                    }
                  />
                )}
              </DataCard>

              {/* Upcoming Sessions */}
              <DataCard
                title="Upcoming Sessions"
                icon={Clock}
                viewAllLink={`/dashboard/consultant/${consultantId}/appointments`}
                viewAllText="View all appointments"
              >
                {upcomingGroups.length > 0 ? (
                  <div className="space-y-3">
                    {upcomingGroups.map(([groupKey, groupAppointments]) => {
                      const isRecurring =
                        groupKey.startsWith("subscription-") ||
                        groupKey.startsWith("class-");
                      const firstAppointment = groupAppointments[0];
                      const userName = getConsumeeName(firstAppointment);
                      const startTime = isRecurring
                        ? getNextUpcomingSlotTime(firstAppointment)
                        : getStartTime(firstAppointment);

                      const {
                        completedSessions,
                        totalSessions,
                        progressPercentage,
                      } = calculateSessionProgress(groupAppointments);

                      return (
                        <motion.div
                          key={groupKey}
                          whileHover={{ x: 4 }}
                          className="group flex items-center gap-4 p-3 rounded-xl hover:bg-zinc-50 cursor-pointer transition-all"
                          onClick={() =>
                            router.push(
                              `/dashboard/consultant/${consultantId}/appointments?highlight=${encodeURIComponent(groupKey)}`,
                            )
                          }
                        >
                          <Avatar className="h-10 w-10">
                            <AvatarImage
                              alt={userName}
                              src={getConsumeeImage(firstAppointment)}
                            />
                            <AvatarFallback className="bg-zinc-100 text-zinc-600 text-sm">
                              {getInitials(userName)}
                            </AvatarFallback>
                          </Avatar>

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <h4 className="font-medium text-zinc-900 truncate">
                                {userName}
                              </h4>
                              {(() => {
                                const sponsoringOrgName =
                                  resolveSponsoringOrgName(
                                    firstAppointment.organizationId,
                                  );
                                return sponsoringOrgName ? (
                                  <Badge
                                    className="text-[10px] font-semibold px-2 py-0.5 bg-indigo-50 text-indigo-700 border-0 rounded-md inline-flex items-center gap-1 max-w-[200px]"
                                    title={`Sponsored by ${sponsoringOrgName}`}
                                  >
                                    <Building2 className="h-3 w-3 shrink-0" />
                                    <span className="truncate">
                                      Sponsored · {sponsoringOrgName}
                                    </span>
                                  </Badge>
                                ) : null;
                              })()}
                              {(() => {
                                const role = getCollaboratorRole(
                                  firstAppointment,
                                  consultantId,
                                );
                                return role ? (
                                  <Badge
                                    className={`text-[10px] px-1.5 py-0 h-5 flex-shrink-0 ${getRoleBadgeStyle(role)}`}
                                  >
                                    {formatCollaboratorRole(role)}
                                  </Badge>
                                ) : null;
                              })()}
                              {isRecurring && (
                                <span className="text-xs text-zinc-400">
                                  {completedSessions}/{totalSessions} sessions
                                </span>
                              )}
                            </div>
                            <p className="text-sm text-zinc-500">
                              {startTime
                                ? formatAppointmentTime(startTime.toISOString())
                                : "TBD"}
                            </p>
                            {isRecurring && (
                              <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-zinc-100">
                                <div
                                  className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-blue-500 transition-all"
                                  style={{ width: `${progressPercentage}%` }}
                                />
                              </div>
                            )}
                          </div>

                          <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
                            <StatusBadge
                              {...eventUnionStatusBadge(
                                getAppointmentLifecycleStatus(firstAppointment),
                              )}
                              withDot
                              size="sm"
                            />
                            {(() => {
                              const proximity = getProximityLabel(
                                startTime ?? null,
                              );
                              return proximity ? (
                                <span className="text-[10px] text-zinc-400">
                                  {proximity}
                                </span>
                              ) : null;
                            })()}
                          </div>

                          <ChevronRight className="h-5 w-5 text-zinc-300 group-hover:text-zinc-500 transition-colors" />
                        </motion.div>
                      );
                    })}
                  </div>
                ) : (
                  <EmptyState
                    icon={Clock}
                    title="No upcoming appointments"
                    description="Your schedule is clear for now"
                    action={
                      <Button variant="outline" size="sm" asChild>
                        <Link href={`/dashboard/consultant/${consultantId}/planner`}>
                          Set up availability
                        </Link>
                      </Button>
                    }
                  />
                )}
              </DataCard>
            </motion.div>

            {/* Right Column - Pending Requests + Financial Summary */}
            <motion.div variants={fadeInUp} className="lg:col-span-2 space-y-6">
              {/* Pending Requests */}
              <DataCard
                title="Pending Requests"
                icon={FileText}
                headerAction={
                  pendingRequestsCount > 0 ? (
                    <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">
                      {pendingRequestsCount}
                    </Badge>
                  ) : undefined
                }
                viewAllLink={`/dashboard/consultant/${consultantId}/requests`}
                viewAllText="View all requests"
              >
                <div className="max-h-[300px] overflow-y-auto -mx-5 px-5">
                  <RequestSlotAllocationTabMini />
                </div>
              </DataCard>

              {/* Financial Summary */}
              {financialSummary && (
                <FinancialSummary {...financialSummary} />
              )}
            </motion.div>
          </div>
        </motion.div>
      </DashboardContent>
    </>
  );
}
