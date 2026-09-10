"use client";

import { useState } from "react";
import * as Sentry from "@sentry/nextjs";
import { useParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";

import { useToast } from "@/hooks/use-toast";
import { useSession } from "@/lib/auth-client";
// #248: the shared hook reads the connected client singleton at click time and
// lazy-imports lib/meeting, so the Stream SDK stays off this bundle.
import { useLazyJoinMeeting } from "@/hooks/scheduling/useLazyJoinMeeting";
import type { SlotOfAppointment } from "@prisma/client";
import type {
  AppointmentActionAdapter,
  OverflowItem,
  PrimaryAction,
} from "@/lib/appointments/adapter";
import {
  CONSULTEE_JOIN_WINDOW_MS,
  getJoinableSlot,
  slotsAllowReschedule,
} from "@/lib/appointments/slots";
import {
  consulteeDestructiveAction,
  consulteeMayReschedule,
  openProposalTarget,
  type OpenRescheduleProposal,
} from "@/lib/appointments/consultee-affordances";
import {
  isApprovedStatus,
  isConfirmedStatus,
  isInactiveStatus,
  isPendingPaymentStatus,
} from "@/lib/appointments/status";
import type {
  AppointmentVM,
  SlotLike,
} from "@/lib/appointments/view-model";
import { useEventActions } from "@/components/appointments/consultee/useEventActions";
import { CancelConfirmationDialog } from "@/components/appointments/consultee/CancelConfirmationDialog";
import { SupportThreadSheet } from "@/components/support/SupportThreadSheet";
import { DocumentUpload } from "@/components/appointments/DocumentUpload";

type DialogKind = "cancel" | "leave" | "report" | "documents";

/**
 * Event id for leave / cancel-trial API paths.
 *
 * ## Why two lookups?
 *
 * `map-consultee` sets `raw.source` to the webinar/class/trial row (has `.id`).
 * `map-detail` sets `raw.source` to `{ appointment, siblings }` — no event id.
 * The same adapter mounts on list AND detail, so gating on `source.id` alone
 * hid Leave / Cancel trial on `/appointments/[appointmentId]` after #1005.
 *
 * Prefer `source.id` when present; otherwise read the appointment FKs the
 * detail mapper already loaded. Longer-term a dedicated `eventId` on
 * `AppointmentVM` would force both mappers to supply it — this fallback is
 * the smaller surgical fix that unblocks the detail page.
 */
function sourceId(vm: AppointmentVM): string | null {
  const source = vm.raw.source as { id?: string } | undefined;
  if (source?.id) return source.id;

  const appt = vm.raw.appointment as
    | {
        webinarId?: string | null;
        classId?: string | null;
        consultationId?: string | null;
        subscriptionId?: string | null;
        trialSession?: { id?: string } | null;
      }
    | undefined;
  if (!appt) return null;

  switch (vm.kind) {
    case "WEBINAR":
      return appt.webinarId ?? null;
    case "CLASS":
      return appt.classId ?? null;
    case "TRIAL":
      return appt.trialSession?.id ?? null;
    case "CONSULTATION":
      return appt.consultationId ?? null;
    case "SUBSCRIPTION":
      return appt.subscriptionId ?? null;
    default:
      return null;
  }
}

/**
 * The open reschedule proposal on this row, and which appointment carries it.
 *
 * Scans the anchor AND the group children: a subscription row anchors on its
 * next actionable child while the proposal may sit on another. The cast is the
 * `sourceId` idiom — `TAppointment` predates the `rescheduleRequests` include
 * the consultee reads now carry. #1163
 */
function rowProposalTarget(
  vm: AppointmentVM,
): { appointmentId: string; proposal: OpenRescheduleProposal } | null {
  type WithProposals = {
    id: string;
    rescheduleRequests?: OpenRescheduleProposal[];
  };
  return openProposalTarget([
    vm.raw.appointment as WithProposals | undefined,
    ...((vm.raw.groupAppointments ?? []) as WithProposals[]),
  ]);
}

const KIND_TO_TYPE: Record<
  AppointmentVM["kind"],
  "Consultation" | "Subscription" | "Webinar" | "Class" | "Trial"
> = {
  CONSULTATION: "Consultation",
  SUBSCRIPTION: "Subscription",
  WEBINAR: "Webinar",
  CLASS: "Class",
  TRIAL: "Trial",
};

/**
 * @param options.consulteeId — Override when the URL has no `[consulteeId]`
 *   (org appointment detail). Falls back to the route param, then the session.
 * @param options.rescheduleReturnTo — RELATIVE href the reschedule page
 *   returns to instead of the personal appointments list. #1166 — the org
 *   detail page passes itself so reschedule doesn't eject the member into
 *   the personal dashboard. Validated server-side by the reschedule page.
 */
export function useConsulteeAppointmentsAdapter(options?: {
  consulteeId?: string;
  rescheduleReturnTo?: string;
}): AppointmentActionAdapter {
  const router = useRouter();
  const { toast } = useToast();
  const joinMeeting = useLazyJoinMeeting();
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const params = useParams<{ consulteeId: string }>();
  const consulteeId =
    options?.consulteeId ||
    params?.consulteeId ||
    session?.user?.consulteeProfileId ||
    undefined;

  // ONE set of dialogs, keyed off the row that opened them.
  const [activeVm, setActiveVm] = useState<AppointmentVM | null>(null);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const typeLabel = activeVm ? KIND_TO_TYPE[activeVm.kind] : "Consultation";
  const actions = useEventActions({
    appointmentId: activeVm?.appointmentId ?? undefined,
    rawSlots: (activeVm?.raw.rawSlots ?? []) as SlotOfAppointment[],
    title: activeVm?.title ?? "",
    consultant: activeVm?.counterpart.name ?? "",
    type: typeLabel,
    // The hook falls back to useParams, which the org detail route lacks —
    // thread the id this adapter already resolved. #1163
    consulteeId,
  });

  const closeDialog = () => setDialog(null);
  const openDialog = (vm: AppointmentVM, kind: DialogKind) => {
    setActiveVm(vm);
    setDialog(kind);
  };

  /**
   * Join can't go through useEventActions — its args follow activeVm state,
   * which wouldn't be committed yet on a same-click join from a row.
   *
   * #1270 — this was a private, degraded copy of `useLazyJoinMeeting`. It read
   * the video client SYNCHRONOUSLY, so a click that landed before the deferred
   * connect finished was told "Not signed in" (destructive, and untrue) while
   * every sibling surface awaits the client for up to four seconds and shows a
   * retryable warning. It also cleared `joiningId` only in `catch`, so a
   * successful join left the row spinning until the route changed. The shared
   * hook already has the right contract and returns whether navigation began.
   */
  const joinNow = async (vm: AppointmentVM, slot: SlotLike) => {
    const appointment = vm.raw.appointment;
    if (!appointment) {
      toast({
        title: "Unable to join",
        description: "Meeting information is not available.",
        variant: "destructive",
      });
      return;
    }
    setJoiningId(vm.id);
    // MeetingSlot is Date|string tolerant by design — pass the slot honestly
    // instead of asserting a Prisma type it isn't.
    const navigating = await joinMeeting(appointment, {
      id: slot.id,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt ?? null,
      isTentative: slot.isTentative,
      appointmentId: slot.appointmentId ?? null,
    });
    if (!navigating) setJoiningId(null);
  };

  const isDev = process.env.NEXT_PUBLIC_ENABLE_DEV_TOOLS === "true";

  const primaryAction = (vm: AppointmentVM): PrimaryAction => {
    const joinable = getJoinableSlot(vm.raw.rawSlots ?? [], {
      joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
    });
    if (joinable && isConfirmedStatus(vm.status) && vm.raw.appointment) {
      return {
        kind: "join",
        label: "Join",
        onClick: () => void joinNow(vm, joinable),
        busy: joiningId === vm.id,
      };
    }
    if (
      vm.needsActionReason === "PAY_NOW" &&
      vm.pendingPaymentUrl &&
      /^https?:\/\//.test(vm.pendingPaymentUrl)
    ) {
      return { kind: "pay", label: "Pay now", href: vm.pendingPaymentUrl };
    }
    return { kind: "view", label: "View" };
  };

  const overflowItems = (vm: AppointmentVM): OverflowItem[] => {
    const items: OverflowItem[] = [];
    const inactive = isInactiveStatus(vm.status);
    const slots = vm.raw.rawSlots ?? [];
    // #1163 — a live proposal outranks every other action: until it is
    // answered the row just says "awaiting confirmation". Navigation, not a
    // dialog — the detail page hosts the card with accept/decline/withdraw.
    const proposalTarget = rowProposalTarget(vm);
    if (proposalTarget && consulteeId && !inactive) {
      items.push({
        key: "reschedule-proposal",
        label: "Review reschedule request",
        onClick: () =>
          router.push(
            `/dashboard/consultee/${consulteeId}/appointments/${proposalTarget.appointmentId}`,
          ),
      });
    }
    // #1005 — kind-gate: only offer actions the server will honour.
    if (
      consulteeMayReschedule(vm.kind) &&
      vm.appointmentId &&
      // The reschedule page lives under this route's consultee; off that route
      // there is no id to send them to.
      consulteeId &&
      !inactive &&
      isApprovedStatus(vm.status) &&
      slotsAllowReschedule(slots)
    ) {
      items.push({
        key: "reschedule",
        label: "Reschedule",
        // A page, not a dialog: choosing a time is a full-width task, and a
        // URL means a half-finished choice survives a refresh.
        onClick: () =>
          router.push(
            `/dashboard/consultee/${consulteeId}/appointments/${vm.appointmentId}/reschedule${
              options?.rescheduleReturnTo
                ? `?returnTo=${encodeURIComponent(options.rescheduleReturnTo)}`
                : ""
            }`,
          ),
      });
    }
    const destructive = consulteeDestructiveAction(vm.kind);
    if (!inactive && destructive === "cancel-booking" && vm.appointmentId) {
      items.push({
        key: "cancel",
        label: isPendingPaymentStatus(vm.status)
          ? "Cancel request"
          : "Cancel booking",
        destructive: true,
        onClick: () => openDialog(vm, "cancel"),
      });
    } else if (!inactive && destructive === "cancel-trial" && sourceId(vm)) {
      items.push({
        key: "cancel",
        label: "Cancel trial",
        destructive: true,
        onClick: () => openDialog(vm, "cancel"),
      });
    } else if (!inactive && destructive === "leave-event" && sourceId(vm)) {
      items.push({
        key: "leave",
        label: "Leave event",
        destructive: true,
        onClick: () => openDialog(vm, "leave"),
      });
    }
    if (
      vm.appointmentId &&
      isConfirmedStatus(vm.status) &&
      (vm.kind === "CONSULTATION" ||
        vm.kind === "TRIAL" ||
        vm.kind === "SUBSCRIPTION")
    ) {
      items.push({
        key: "documents",
        label: "Documents",
        onClick: () => openDialog(vm, "documents"),
      });
    }
    if (vm.appointmentId) {
      items.push({
        key: "report",
        label: "Report issue",
        onClick: () => openDialog(vm, "report"),
      });
    }
    // #1270 — additive by construction: a separately-labelled overflow entry
    // that appears only where the real Join does not, never a relaxation of
    // the primary action's gate.
    if (
      isDev &&
      vm.raw.appointment &&
      (vm.raw.rawSlots?.length ?? 0) > 0 &&
      !getJoinableSlot(vm.raw.rawSlots ?? [], {
        joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
      })
    ) {
      items.push({
        key: "dev-join",
        label: "Force join (dev)",
        onClick: () => void joinNow(vm, vm.raw.rawSlots![0]),
      });
    }
    return items;
  };

  const invalidateBookings = () => {
    // The detail hub renders the trial/event just acted on — refresh it even
    // when no consulteeId resolved (org mounts). #1163
    if (activeVm?.appointmentId) {
      void queryClient.invalidateQueries({
        queryKey: ["appointment-detail", activeVm.appointmentId],
      });
    }
    if (!consulteeId) return;
    void queryClient.invalidateQueries({
      queryKey: ["consultee-events", consulteeId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["pending-payments", consulteeId],
    });
  };

  // Extracted so Sonar cognitive-complexity on confirmDestructive stays under
  // the gate; each helper owns its fetch + toast, the dispatcher owns loading.
  const cancelTrial = async (id: string, title: string) => {
    const response = await fetch(`/api/trials/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "CANCELLED" }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        (data as { error?: string }).error || "Failed to cancel trial",
      );
    }
    toast({
      title: "Trial cancelled",
      description: `Your trial "${title}" has been cancelled.`,
    });
  };

  const leaveEvent = async (
    kind: Extract<AppointmentVM["kind"], "WEBINAR" | "CLASS">,
    id: string,
    userId: string,
    title: string,
  ) => {
    let path: string;
    switch (kind) {
      case "WEBINAR":
        path = `/api/participants/webinar/${id}?userId=${encodeURIComponent(userId)}`;
        break;
      case "CLASS":
        path = `/api/participants/class/${id}?userId=${encodeURIComponent(userId)}`;
        break;
      default: {
        const _exhaustive: never = kind;
        throw new Error(`Unsupported leave-event kind: ${_exhaustive}`);
      }
    }
    const response = await fetch(path, { method: "DELETE" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        (data as { error?: string }).error || "Failed to leave the event",
      );
    }
    toast({
      title: "Left event",
      description: `You have left "${title}".`,
    });
  };

  const confirmDestructive = async () => {
    if (!activeVm) return;
    const id = sourceId(activeVm);
    const destructive = consulteeDestructiveAction(activeVm.kind);

    if (destructive === "cancel-booking") {
      await actions.handleCancelConfirm();
      closeDialog();
      return;
    }

    setActionLoading(true);
    try {
      if (destructive === "cancel-trial") {
        if (!id) throw new Error("Trial id is missing");
        await cancelTrial(id, activeVm.title);
      } else if (destructive === "leave-event") {
        if (!id) throw new Error("Event id is missing");
        const userId = session?.user?.id;
        if (!userId) throw new Error("You must be signed in to leave");
        if (activeVm.kind !== "WEBINAR" && activeVm.kind !== "CLASS") {
          throw new Error("Only webinars and classes support leave-event");
        }
        await leaveEvent(activeVm.kind, id, userId, activeVm.title);
      }
      closeDialog();
      invalidateBookings();
    } catch (error) {
      Sentry.captureException(error);
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Something went wrong",
        variant: "destructive",
      });
    } finally {
      setActionLoading(false);
    }
  };

  const renderDialogs = () => {
    if (!activeVm) return null;
    const isPendingPayment = isPendingPaymentStatus(activeVm.status);
    const dialogMode = dialog === "leave" ? "leave" : "cancel";

    return (
      <>
        <CancelConfirmationDialog
          isOpen={dialog === "cancel" || dialog === "leave"}
          onConfirm={() => void confirmDestructive()}
          onCancel={closeDialog}
          title={activeVm.title}
          consultant={activeVm.counterpart.name}
          appointmentType={typeLabel}
          isLoading={actions.isLoading || actionLoading}
          isPendingPayment={isPendingPayment}
          mode={dialogMode}
          // R13 — without this the quote is disabled for every consultee, which
          // is the one side of the booking whose money the quote is about. The
          // consultant adapter has always passed it.
          appointmentId={activeVm.appointmentId}
        />

        {activeVm.appointmentId && dialog === "report" && (
          // #support-hub — "Report issue" now opens the per-appointment
          // flowchart thread (same surface as the detail page) instead of the
          // legacy raw-ticket dialog. One system, one data path: intents are
          // stage-gated server-side, escalations land in the ops queue with
          // session context.
          <SupportThreadSheet
            appointmentId={activeVm.appointmentId}
            open
            onOpenChange={(open) => !open && closeDialog()}
            appointmentHref={
              activeVm.appointmentId && consulteeId
                ? `/dashboard/consultee/${consulteeId}/appointments/${activeVm.appointmentId}`
                : undefined
            }
          />
        )}

        {activeVm.appointmentId && dialog === "documents" && (
          <DocumentUpload
            appointmentId={activeVm.appointmentId}
            appointmentTitle={activeVm.title}
            appointmentType={typeLabel}
            defaultOpen
            onOpenChange={(open) => !open && closeDialog()}
          />
        )}
      </>
    );
  };

  return {
    role: "consultee",
    detailHref: (vm) =>
      vm.appointmentId && consulteeId
        ? `/dashboard/consultee/${consulteeId}/appointments/${vm.appointmentId}`
        : null,
    primaryAction,
    overflowItems,
    renderDialogs,
  };
}
