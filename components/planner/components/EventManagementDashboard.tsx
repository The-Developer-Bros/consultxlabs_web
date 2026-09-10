"use client";

import * as Sentry from "@sentry/nextjs";
import { useState, useEffect, useCallback, useMemo } from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { EventCarousel } from "./EventCarousel";
// #248 bundle discipline: never statically import the Stream SDK or
// @/lib/meeting (which imports it) — the client singleton is read at
// click time and the meeting helper is lazy-imported on demand.
import {
  describeVideoClientWait,
  waitForGlobalVideoClient,
} from "@/lib/stream/disconnect";
import { reportSentryMessage } from "@/lib/observability/report";
import { reportClientFailure } from "@/lib/errors/classification/client-failure";
import { failureToast } from "@/components/ui/failure-toast";
import { useInFlightGuard } from "@/hooks/scheduling/useInFlightGuard";
import type { MeetingSlot } from "@/lib/meeting";
import {
  CONSULTANT_JOIN_WINDOW_MS,
  getCurrentOrNextSession,
  getJoinableSession,
  getSessionJoinState,
} from "@/lib/appointments/slots";
import {
  PlannerWebinarEvent,
  PlannerClassEvent,
  ConsultationPlanEvent,
  SubscriptionPlanEvent,
} from "@/types/planner-events";
import type { ConsultationPlan, SubscriptionPlan } from "@/schemas/plans";
import { useToast } from "@/hooks/use-toast";
import {
  useWebinarMutations,
  useClassMutations,
  useConsultationPlans,
  useConsultationPlanMutations,
  useSubscriptionPlans,
  useSubscriptionPlanMutations,
  useWebinarPlanMutations,
  useClassPlanMutations,
} from "../hooks/usePlanner";
import {
  LayoutTemplate,
  Radio,
  Plus,
  MessageSquare,
  CalendarRange,
  Video,
  GraduationCap,
} from "lucide-react";

interface PlannerData {
  webinars: PlannerWebinarEvent[];
  classes: PlannerClassEvent[];
  participantCounts: Record<string, number>;
}

interface Props {
  consultantId: string;
  /**
   * Planner payload from the page's ["consultant-planner", …] query — the
   * SINGLE source of truth. Mutations invalidate that key (usePlanner.ts)
   * and fresh data flows back down; this component keeps no local copy.
   * (Previously it seeded useState from this prop while mutations
   * invalidated a key nobody queried, so the UI went stale after every
   * create/edit/delete.)
   */
  data: PlannerData;
}

export function EventManagementDashboard({
  consultantId,
  data,
}: Readonly<Props>) {
  const webinars = data.webinars;
  const classes = data.classes;
  const { toast } = useToast();

  // React Query hooks for consultation and subscription plans
  const { data: consultationPlans, isLoading: consultationPlansLoading } =
    useConsultationPlans(consultantId);
  const { data: subscriptionPlans, isLoading: subscriptionPlansLoading } =
    useSubscriptionPlans(consultantId);

  // React Query mutations
  const { deleteWebinar } = useWebinarMutations(consultantId);
  const { deleteClass } = useClassMutations(consultantId);
  const { archiveWebinarPlan } = useWebinarPlanMutations(consultantId);
  const { archiveClassPlan } = useClassPlanMutations(consultantId);
  // Create/update moved to the offering editor, which owns its own save; the
  // planner only deletes now.
  const { deleteConsultationPlan, archiveConsultationPlan } =
    useConsultationPlanMutations(consultantId);
  const { deleteSubscriptionPlan, archiveSubscriptionPlan } =
    useSubscriptionPlanMutations(consultantId);
  const router = useRouter();
  const [joiningEventId, setJoiningEventId] = useState<string | null>(null);
  // #1280 2.7 — `joiningEventId` is state, and it is set AFTER the first await
  // (`waitForGlobalVideoClient`, which can take a second on a cold provider),
  // so a second click reads a stale `null` and runs the whole chain again.
  // A ref is written synchronously and is what actually closes the window;
  // the state stays because it is what renders the spinner.
  const guardJoin = useInFlightGuard();

  // The join window closes with the clock, not with a re-render. Without a
  // tick the memo below keeps whatever answer it computed when the planner
  // mounted, so Join stays lit after a session ends (#1061). Thirty seconds is
  // fine for a window measured in minutes.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // Compute which webinar/class events are currently joinable (inside the
  // shared host window before start, through to end). #1270 — the planner
  // used to declare its own 10-minute constant, so the SAME host got in five
  // minutes later here than from the appointments list. #1061 — measured over the run of slot rows the
  // session is stored as; the old `slotsOfAppointment[0]` read closed the
  // window 30 minutes into anything longer than half an hour.
  const joinableEventIds = useMemo(() => {
    const ids = new Set<string>();

    for (const webinar of webinars) {
      const run = getJoinableSession(
        webinar.appointment?.slotsOfAppointment ?? [],
        { joinWindowMs: CONSULTANT_JOIN_WINDOW_MS, now },
      );
      if (run && webinar.id) ids.add(webinar.id);
    }

    for (const cls of classes) {
      // For classes, check the nearest upcoming appointment
      for (const appt of cls.appointments ?? []) {
        const run = getJoinableSession(appt.slotsOfAppointment ?? [], {
          joinWindowMs: CONSULTANT_JOIN_WINDOW_MS,
          now,
        });
        if (run && cls.id) ids.add(cls.id);
      }
    }

    return ids;
  }, [webinars, classes, now]);

  // Handle joining a meeting from the planner. Reads the connected video
  // client singleton at click time (HomeTab idiom, #248) so the Stream SDK
  // stays off the planner bundle.
  const handleJoinWebinarMeeting = (webinar: PlannerWebinarEvent) =>
    guardJoin(`webinar:${webinar.id}`, () => joinWebinarMeeting(webinar));

  const joinWebinarMeeting = async (webinar: PlannerWebinarEvent) => {
    const waitStartedAt = Date.now();
    const streamClient = await waitForGlobalVideoClient();
    if (!streamClient) {
      // Kept distinct from a chunk failure in Sentry as well as in the toast;
      // the extras are what tell a cold start from a provider that never
      // connected at all.
      reportSentryMessage("Video client not ready at Join", {
        subsystem: "client",
        op: "join-webinar",
        expected: true,
        extra: describeVideoClientWait(Date.now() - waitStartedAt),
      });
      toast({
        title: "Connecting…",
        description: "Setting up your meeting client. Please try Join again.",
        variant: "warning",
      });
      return;
    }

    // #1061 — the session's anchor row, not whichever row happens to be first
    // in the payload, so a late Join lands in the room already in progress.
    // Both fallbacks are run-derived: `slotsOfAppointment` arrives unsorted,
    // so `[0]` could hand an arbitrary row's startsAt to the Stream call.
    const slots = webinar.appointment?.slotsOfAppointment ?? [];
    const run =
      getJoinableSession(slots, { joinWindowMs: CONSULTANT_JOIN_WINDOW_MS }) ??
      getCurrentOrNextSession(slots);
    const slot = run?.anchor;
    if (!run || !slot || !webinar.appointment) {
      toast({
        title: "Error",
        description: "Meeting slot information is not available.",
        variant: "destructive",
      });
      return;
    }

    // `getJoinableSession` returns null for three different reasons —
    // countdown, disabled and ended — and the fallback fires for all of them.
    // Only `ended` must actually refuse: opening a room for a session the host
    // has already closed, or whose time has passed, walks straight through the
    // guard this change exists to build. Countdown still gets in, because
    // hosts have always been able to open the room a little early.
    if (
      getSessionJoinState(run, { joinWindowMs: CONSULTANT_JOIN_WINDOW_MS }) ===
      "ended"
    ) {
      toast({
        title: "Session has ended",
        description: "This session is over, so its meeting room is closed.",
        variant: "destructive",
      });
      return;
    }

    setJoiningEventId(webinar.id ?? null);
    try {
      const meetingSlot: MeetingSlot = {
        id: slot.id,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        appointmentId: webinar.appointment.id,
      };
      const { getOrCreateAppointmentMeeting } = await import("@/lib/meeting");
      const meetingId = await getOrCreateAppointmentMeeting(meetingSlot);
      toast({
        title: "Joining meeting",
        description: "Redirecting to the meeting room.",
      });
      router.push(`/meetings/${meetingId}`);
    } catch (error) {
      console.error("Error joining webinar meeting:", error);
      toast(
        failureToast(
          reportClientFailure(error, {
            subsystem: "client",
            op: "join-webinar",
            title: "Error joining meeting",
            extra: { appointmentId: webinar.appointment.id, slotId: slot.id },
          }),
        ),
      );
      setJoiningEventId(null);
    }
  };

  const handleJoinClassMeeting = (classEvent: PlannerClassEvent) =>
    guardJoin(`class:${classEvent.id}`, () => joinClassMeeting(classEvent));

  const joinClassMeeting = async (classEvent: PlannerClassEvent) => {
    const waitStartedAt = Date.now();
    const streamClient = await waitForGlobalVideoClient();
    if (!streamClient) {
      // Kept distinct from a chunk failure in Sentry as well as in the toast;
      // the extras are what tell a cold start from a provider that never
      // connected at all.
      reportSentryMessage("Video client not ready at Join", {
        subsystem: "client",
        op: "join-class",
        expected: true,
        extra: describeVideoClientWait(Date.now() - waitStartedAt),
      });
      toast({
        title: "Connecting…",
        description: "Setting up your meeting client. Please try Join again.",
        variant: "warning",
      });
      return;
    }

    // Find the nearest joinable session for this class. #1061 — evaluated over
    // the whole run of slot rows, so a two-hour class stays joinable (and in
    // the same room) past its first half hour instead of reporting "No
    // joinable session found".
    const now = new Date();
    let targetAppt = null;
    let targetSlot = null;

    for (const appt of classEvent.appointments ?? []) {
      const run = getJoinableSession(appt.slotsOfAppointment ?? [], {
        joinWindowMs: CONSULTANT_JOIN_WINDOW_MS,
        now,
      });
      if (run) {
        targetAppt = appt;
        targetSlot = run.anchor;
        break;
      }
    }

    if (!targetAppt || !targetSlot) {
      toast({
        title: "Error",
        description: "No joinable session found for this class.",
        variant: "destructive",
      });
      return;
    }

    setJoiningEventId(classEvent.id ?? null);
    try {
      const meetingSlot: MeetingSlot = {
        id: targetSlot.id,
        startsAt: targetSlot.startsAt,
        endsAt: targetSlot.endsAt,
        appointmentId: targetAppt.id,
      };
      const { getOrCreateAppointmentMeeting } = await import("@/lib/meeting");
      const meetingId = await getOrCreateAppointmentMeeting(meetingSlot);
      toast({
        title: "Joining meeting",
        description: "Redirecting to the meeting room.",
      });
      router.push(`/meetings/${meetingId}`);
    } catch (error) {
      console.error("Error joining class meeting:", error);
      toast(
        failureToast(
          reportClientFailure(error, {
            subsystem: "client",
            op: "join-class",
            title: "Error joining meeting",
            extra: { appointmentId: targetAppt.id, slotId: targetSlot.id },
          }),
        ),
      );
      setJoiningEventId(null);
    }
  };

  // Trial management state - just counts for badge display
  const [pendingTrialCounts, setPendingTrialCounts] = useState<
    Record<string, number>
  >({});

  // Fetch pending trial counts for subscription plans
  const fetchTrialCounts = useCallback(async () => {
    if (!consultantId) return;

    try {
      const response = await fetch(
        `/api/trials?consultantProfileId=${consultantId}&status=PENDING`,
      );
      if (!response.ok) return;

      const { data } = await response.json();
      // Group by subscriptionPlanId
      const counts = data.reduce(
        (
          acc: Record<string, number>,
          trial: { subscriptionPlanId: string },
        ) => {
          acc[trial.subscriptionPlanId] =
            (acc[trial.subscriptionPlanId] || 0) + 1;
          return acc;
        },
        {},
      );
      setPendingTrialCounts(counts);
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "client" } },
      );
      console.error("Error fetching trial counts:", error);
    }
  }, [consultantId]);

  // Fetch trial counts on mount and when subscription plans change
  useEffect(() => {
    fetchTrialCounts();
  }, [fetchTrialCounts, subscriptionPlans]);

  // Trials live on Appointments now (ADR 19 — a trial IS an appointment), so
  // this deep-links to the tab rather than the retired standalone route.
  const handleTrialsClick = () => {
    router.push(
      `/dashboard/consultant/${consultantId}/appointments?tab=trials`,
    );
  };

  // Handle webinar saved event

  // Handle class saved event

  // Editing routes to the offering editor rather than reopening a dialog, so
  // an offering has one authoring surface and a URL you can return to.
  //
  // A row with no id has no editor to open, and both previous spellings built a
  // URL that could only land on the error boundary: `id ?? ""` collapsed to a
  // double slash, while a bare `id` stringified undefined into the path. The
  // card's Edit control is disabled for such a row; this is the backstop.
  const goToEdit = (type: string, id: string | undefined) => {
    if (!id) {
      reportSentryMessage("Edit requested for an offering with no id", {
        subsystem: "offerings",
        op: "edit-navigate",
        extra: { type, consultantId },
      });
      return;
    }
    router.push(
      `/dashboard/consultant/${consultantId}/offerings/${type}/${id}/edit`,
    );
  };

  const handleEditWebinar = (webinar: PlannerWebinarEvent) => {
    goToEdit("webinar", webinar.id);
  };

  const handleEditClass = (classEvent: PlannerClassEvent) => {
    goToEdit("class", classEvent.id);
  };

  // Handle webinar delete event using React Query
  const handleWebinarDelete = async (webinarId: string) => {
    console.log(`EventManagementDashboard - Deleting webinar: ${webinarId}`);
    deleteWebinar.mutate(webinarId);
  };

  // Handle class delete event using React Query
  const handleClassDelete = async (classId: string) => {
    console.log(`EventManagementDashboard - Deleting class: ${classId}`);
    deleteClass.mutate(classId);
  };

  // Handle consultation plan saved event

  // Handle subscription plan saved event

  const handleEditConsultationPlan = (
    consultationPlan: ConsultationPlanEvent,
  ) => {
    goToEdit("consultation", consultationPlan.id);
  };

  const handleEditSubscriptionPlan = (
    subscriptionPlan: SubscriptionPlanEvent,
  ) => {
    goToEdit("subscription", subscriptionPlan.id);
  };

  // Handle consultation plan delete event using React Query
  const handleConsultationPlanDelete = async (planId: string) => {
    console.log(
      `EventManagementDashboard - Deleting consultation plan: ${planId}`,
    );
    deleteConsultationPlan.mutate(planId);
  };

  // Handle subscription plan delete event using React Query
  const handleSubscriptionPlanDelete = async (planId: string) => {
    console.log(
      `EventManagementDashboard - Deleting subscription plan: ${planId}`,
    );
    deleteSubscriptionPlan.mutate(planId);
  };

  // Archive/restore toggles (#1494) — one handler per plan family, each
  // wired to the matching PATCH mutation.
  const handleConsultationPlanArchiveToggle = (
    planId: string,
    archived: boolean,
  ) => archiveConsultationPlan.mutate({ id: planId, archived });

  const handleSubscriptionPlanArchiveToggle = (
    planId: string,
    archived: boolean,
  ) => archiveSubscriptionPlan.mutate({ id: planId, archived });

  const handleWebinarPlanArchiveToggle = (planId: string, archived: boolean) =>
    archiveWebinarPlan.mutate({ id: planId, archived });

  const handleClassPlanArchiveToggle = (planId: string, archived: boolean) =>
    archiveClassPlan.mutate({ id: planId, archived });

  // Calculate stats
  const totalPlans =
    (consultationPlans?.length ?? 0) + (subscriptionPlans?.length ?? 0);
  const totalSessions = webinars.length + classes.length;

  return (
    <div>
      <div className="w-full">
        {/* Quick Stats — the page title lives in the page-level
            DashboardHeader; only the live counters render here. */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="mb-8 flex flex-wrap items-center gap-2 sm:mb-10 sm:gap-3"
        >
          <div className="flex items-center gap-2 rounded-xl border border-zinc-200/80 bg-white px-3.5 py-2 shadow-sm">
            <LayoutTemplate className="h-4 w-4 text-zinc-500" />
            <span className="text-sm font-medium text-zinc-800">
              {totalPlans}{" "}
              <span className="font-normal text-zinc-500">Plans</span>
            </span>
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-zinc-200/80 bg-white px-3.5 py-2 shadow-sm">
            <Radio className="h-4 w-4 text-zinc-500" />
            <span className="text-sm font-medium text-zinc-800">
              {totalSessions}{" "}
              <span className="font-normal text-zinc-500">
                Upcoming Sessions
              </span>
            </span>
          </div>
        </motion.div>

        {/* Plan Templates Section */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
          className="mb-12 sm:mb-16"
        >
          <div className="mb-6 sm:mb-8">
            <h2 className="text-lg font-semibold tracking-tight text-zinc-900 sm:text-xl">
              Plan Templates
            </h2>
            <p className="mt-0.5 text-sm text-zinc-500">
              Create reusable service templates
            </p>
          </div>

          {/* Consultation Plans */}
          <div className="mb-8 sm:mb-10">
            <div className="mb-4 flex flex-col gap-3 sm:mb-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sky-50 ring-1 ring-sky-100">
                  <MessageSquare className="h-4 w-4 text-sky-700" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-zinc-900 sm:text-base">
                    Consultation Plans
                  </h3>
                  <p className="text-xs text-zinc-500 sm:text-sm">
                    One-on-one session templates
                  </p>
                </div>
              </div>
              <Button
                onClick={() =>
                  router.push(
                    `/dashboard/consultant/${consultantId}/offerings/consultation/new`,
                  )
                }
                variant="outline"
                className="w-full gap-2 border-zinc-200 bg-white font-medium text-zinc-900 hover:bg-zinc-50 sm:w-auto"
              >
                <Plus className="h-4 w-4" />
                New Plan
              </Button>
            </div>
            {consultationPlansLoading ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 xl:grid-cols-3">
                {[...Array(3)].map((_, i) => (
                  <div
                    key={i}
                    className="h-52 animate-pulse rounded-2xl bg-zinc-100"
                  />
                ))}
              </div>
            ) : (
              <EventCarousel
                events={
                  consultationPlans?.map(
                    (plan: ConsultationPlan & { id: string }) => ({
                      type: "consultation" as const,
                      id: plan.id,
                      consultationPlan: plan,
                    }),
                  ) || []
                }
                onEdit={handleEditConsultationPlan}
                onDelete={handleConsultationPlanDelete}
                eventType="consultation"
                participantCounts={{}}
                onArchiveToggle={handleConsultationPlanArchiveToggle}
                archivingPlanId={
                  archiveConsultationPlan.isPending
                    ? (archiveConsultationPlan.variables?.id ?? null)
                    : null
                }
              />
            )}
          </div>

          {/* Subscription Plans */}
          <div>
            <div className="mb-4 flex flex-col gap-3 sm:mb-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-teal-50 ring-1 ring-teal-100">
                  <CalendarRange className="h-4 w-4 text-teal-700" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-zinc-900 sm:text-base">
                    Subscription Plans
                  </h3>
                  <p className="text-xs text-zinc-500 sm:text-sm">
                    Recurring mentorship offerings
                  </p>
                </div>
              </div>
              <Button
                onClick={() =>
                  router.push(
                    `/dashboard/consultant/${consultantId}/offerings/subscription/new`,
                  )
                }
                variant="outline"
                className="w-full gap-2 border-zinc-200 bg-white font-medium text-zinc-900 hover:bg-zinc-50 sm:w-auto"
              >
                <Plus className="h-4 w-4" />
                New Plan
              </Button>
            </div>
            {subscriptionPlansLoading ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 xl:grid-cols-3">
                {[...Array(3)].map((_, i) => (
                  <div
                    key={i}
                    className="h-52 animate-pulse rounded-2xl bg-zinc-100"
                  />
                ))}
              </div>
            ) : (
              <EventCarousel
                events={
                  subscriptionPlans?.map(
                    (plan: SubscriptionPlan & { id: string }) => ({
                      type: "subscription" as const,
                      id: plan.id,
                      subscriptionPlan: plan,
                    }),
                  ) || []
                }
                onEdit={handleEditSubscriptionPlan}
                onDelete={handleSubscriptionPlanDelete}
                eventType="subscription"
                participantCounts={{}}
                pendingTrialCounts={pendingTrialCounts}
                onTrialsClick={handleTrialsClick}
                onArchiveToggle={handleSubscriptionPlanArchiveToggle}
                archivingPlanId={
                  archiveSubscriptionPlan.isPending
                    ? (archiveSubscriptionPlan.variables?.id ?? null)
                    : null
                }
              />
            )}
          </div>
        </motion.section>

        {/* Live Sessions Section */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.2 }}
          className="mb-12 sm:mb-16"
        >
          <div className="mb-6 sm:mb-8">
            <h2 className="text-lg font-semibold tracking-tight text-zinc-900 sm:text-xl">
              Live Sessions
            </h2>
            <p className="mt-0.5 text-sm text-zinc-500">
              Schedule and manage your live events
            </p>
          </div>

          {/* Webinar Events */}
          <div className="mb-8 sm:mb-10">
            <div className="mb-4 flex flex-col gap-3 sm:mb-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-50 ring-1 ring-emerald-100">
                  <Video className="h-4 w-4 text-emerald-700" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-zinc-900 sm:text-base">
                    Webinar Events
                  </h3>
                  <p className="text-xs text-zinc-500 sm:text-sm">
                    Live sessions with multiple participants
                  </p>
                </div>
              </div>
              <Button
                onClick={() =>
                  router.push(
                    `/dashboard/consultant/${consultantId}/offerings/webinar/new`,
                  )
                }
                variant="outline"
                className="w-full gap-2 border-zinc-200 bg-white font-medium text-zinc-900 hover:bg-zinc-50 sm:w-auto"
              >
                <Plus className="h-4 w-4" />
                New Webinar
              </Button>
            </div>
            <EventCarousel
              events={webinars}
              onEdit={handleEditWebinar}
              onDelete={handleWebinarDelete}
              eventType="webinar"
              participantCounts={data.participantCounts ?? {}}
              onJoinMeeting={handleJoinWebinarMeeting}
              joinableEventIds={joinableEventIds}
              joiningEventId={joiningEventId}
              onArchiveToggle={handleWebinarPlanArchiveToggle}
              archivingPlanId={
                archiveWebinarPlan.isPending
                  ? (archiveWebinarPlan.variables?.id ?? null)
                  : null
              }
            />
          </div>

          {/* Class Events */}
          <div>
            <div className="mb-4 flex flex-col gap-3 sm:mb-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-50 ring-1 ring-amber-100">
                  <GraduationCap className="h-4 w-4 text-amber-700" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-zinc-900 sm:text-base">
                    Class Events
                  </h3>
                  <p className="text-xs text-zinc-500 sm:text-sm">
                    Multi-session structured learning
                  </p>
                </div>
              </div>
              <Button
                onClick={() =>
                  router.push(
                    `/dashboard/consultant/${consultantId}/offerings/class/new`,
                  )
                }
                variant="outline"
                className="w-full gap-2 border-zinc-200 bg-white font-medium text-zinc-900 hover:bg-zinc-50 sm:w-auto"
              >
                <Plus className="h-4 w-4" />
                New Class
              </Button>
            </div>
            <EventCarousel
              events={classes}
              onEdit={handleEditClass}
              onDelete={handleClassDelete}
              eventType="class"
              participantCounts={data.participantCounts ?? {}}
              onJoinMeeting={handleJoinClassMeeting}
              joinableEventIds={joinableEventIds}
              joiningEventId={joiningEventId}
              onArchiveToggle={handleClassPlanArchiveToggle}
              archivingPlanId={
                archiveClassPlan.isPending
                  ? (archiveClassPlan.variables?.id ?? null)
                  : null
              }
            />
          </div>
        </motion.section>
      </div>
    </div>
  );
}
