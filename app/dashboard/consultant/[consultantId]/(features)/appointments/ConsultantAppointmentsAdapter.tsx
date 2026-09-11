"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  AppointmentActionAdapter,
  OverflowItem,
  PrimaryAction,
} from "@/lib/appointments/adapter";
import {
  allowsManageTimings,
  allowsUnschedule,
  CONSULTANT_JOIN_WINDOW_MS,
  getJoinableSlot,
  slotsAllowReschedule,
  upcomingSlots,
} from "@/lib/appointments/slots";
import {
  isApprovedStatus,
  isConfirmedStatus,
  isInactiveStatus,
} from "@/lib/appointments/status";
import type { AppointmentVM } from "@/lib/appointments/view-model";
import type { ConsultantTrialLike } from "@/lib/appointments/map-consultant";
import { useLazyJoinMeeting } from "@/hooks/scheduling/useLazyJoinMeeting";
import {
  getParticipantManagementUrl,
  supportsParticipantManagement,
} from "./utils/participantHelpers";
import { useConsultantEventActions } from "./components/useConsultantEventActions";
import { CancelConfirmationDialog } from "@/components/appointments/consultee/CancelConfirmationDialog";
import { UnscheduleConfirmationDialog } from "@/components/appointments/UnscheduleConfirmationDialog";
import { ConsultantResponseUpload } from "../documents/ConsultantResponseUpload";

type DialogKind = "cancel" | "unschedule" | "documents";

const TYPE_LABEL: Record<AppointmentVM["kind"], string> = {
  CONSULTATION: "Consultation",
  SUBSCRIPTION: "Subscription",
  WEBINAR: "Webinar",
  CLASS: "Class",
  TRIAL: "Trial",
};

/** Webinar/class lifecycle actions are plan-owner only (API rejects collaborators). */
function canManageBookingLifecycle(vm: AppointmentVM): boolean {
  if (vm.kind === "WEBINAR" || vm.kind === "CLASS") {
    return !vm.collaboratorRole || vm.collaboratorRole === "HOST";
  }
  return true;
}

function actionableRawSlots(vm: AppointmentVM) {
  if (vm.raw.rawSlots?.length) return vm.raw.rawSlots;
  const sources =
    vm.raw.groupAppointments && vm.raw.groupAppointments.length > 0
      ? vm.raw.groupAppointments
      : vm.raw.appointment
        ? [vm.raw.appointment]
        : [];
  // Shared with the timings page's own gate, so the menu cannot offer a route
  // that then 404s on a different reading of the same slots (#1082).
  return upcomingSlots(sources.flatMap((a) => a.slotsOfAppointment ?? []));
}

export function useConsultantAppointmentsAdapter(
  consultantId: string,
): AppointmentActionAdapter {
  const router = useRouter();
  const joinMeeting = useLazyJoinMeeting();
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [activeVm, setActiveVm] = useState<AppointmentVM | null>(null);
  const [dialog, setDialog] = useState<DialogKind | null>(null);

  // #1270 — one flag, not three. This surface keyed off NODE_ENV while its
  // consultee sibling keyed off NEXT_PUBLIC_ENABLE_DEV_TOOLS, so the same
  // backdoor was open in different places on the same build. The explicit
  // opt-in wins: NODE_ENV is true for every local run whether or not the
  // developer asked for the escape hatch.
  const isDev = process.env.NEXT_PUBLIC_ENABLE_DEV_TOOLS === "true";

  const typeLabel = activeVm
    ? TYPE_LABEL[activeVm.kind]
    : ("Consultation" as const);

  const rawSlots = useMemo(
    () => (activeVm ? actionableRawSlots(activeVm) : []),
    [activeVm],
  );

  const actions = useConsultantEventActions({
    consultantId,
    appointmentId: activeVm?.appointmentId ?? undefined,
    rawSlots,
    title: activeVm?.title ?? "",
    type: typeLabel as
      | "Consultation"
      | "Subscription"
      | "Webinar"
      | "Class"
      | "Trial",
  });

  const openDialog = (vm: AppointmentVM, kind: DialogKind) => {
    setActiveVm(vm);
    setDialog(kind);
  };
  const closeDialog = () => setDialog(null);

  const joinableSlotOf = (vm: AppointmentVM) =>
    getJoinableSlot(vm.raw.appointment?.slotsOfAppointment ?? [], {
      joinWindowMs: CONSULTANT_JOIN_WINDOW_MS,
    });

  const joinVm = async (vm: AppointmentVM, force = false) => {
    setJoiningId(vm.id);
    let navigating = false;
    if (vm.kind === "TRIAL") {
      const trial = vm.raw.source as ConsultantTrialLike;
      const slot = trial.appointment?.slotsOfAppointment?.[0];
      if (trial.appointment && slot) {
        navigating = await joinMeeting(
          {
            id: trial.appointment.id,
            appointmentType: "TRIAL",
            slotsOfAppointment: [
              {
                id: slot.id,
                startsAt: slot.startsAt,
                endsAt: slot.endsAt,
                appointmentId: trial.appointment.id,
              },
            ],
          },
          undefined,
        );
      }
    } else if (vm.raw.appointment) {
      const slot = force
        ? vm.raw.appointment.slotsOfAppointment?.[0]
        : (joinableSlotOf(vm) ?? undefined);
      navigating = await joinMeeting(vm.raw.appointment, slot);
    }
    if (!navigating) setJoiningId(null);
  };

  /**
   * `vm.id` already carries the `unscheduled-class-`/`unscheduled-webinar-`
   * prefix for an offering with no `Appointment` row yet; a scheduled one
   * routes on the real appointment id. The timings page resolves either
   * shape itself (lib/data/manage-timings-target.ts).
   */
  const openTimings = (vm: AppointmentVM) => {
    const targetId =
      vm.id.startsWith("unscheduled-class-") ||
      vm.id.startsWith("unscheduled-webinar-")
        ? vm.id
        : vm.appointmentId;
    if (!targetId) return;
    router.push(
      `/dashboard/consultant/${consultantId}/appointments/${targetId}/timings`,
    );
  };

  const trialJoinable = (vm: AppointmentVM) => {
    if (vm.kind !== "TRIAL") return false;
    const trial = vm.raw.source as ConsultantTrialLike;
    const slots = trial.appointment?.slotsOfAppointment ?? [];
    return (
      getJoinableSlot(
        slots.map((s) => ({ ...s, isTentative: false })),
        { joinWindowMs: CONSULTANT_JOIN_WINDOW_MS },
      ) !== null
    );
  };

  /**
   * The whole join gate: a confirmed booking whose session is inside its
   * window.
   *
   * #1270 — the status half was missing. The non-trial branch gated on
   * `bucket !== "cancelled"` alone, which is only the terminal-NEGATIVE
   * statuses, so a consultant could open the room for a booking still at
   * APPROVED_PENDING_PAYMENT (nobody has paid) or already COMPLETED (the
   * session is over and its recording is sealed). The trial branch checked no
   * status at all. `isConfirmedStatus` is what the consultee adapter has
   * always required, and it subsumes the cancelled-bucket check.
   */
  const canJoinNow = (vm: AppointmentVM): boolean => {
    if (!isConfirmedStatus(vm.status)) return false;
    return vm.kind === "TRIAL"
      ? trialJoinable(vm)
      : joinableSlotOf(vm) !== null;
  };

  /** Slot rows exist to key a room to, joinable or not — the dev arm's target. */
  const hasSlotRows = (vm: AppointmentVM): boolean => {
    if (vm.kind === "TRIAL") {
      const trial = vm.raw.source as ConsultantTrialLike | undefined;
      return (trial?.appointment?.slotsOfAppointment?.length ?? 0) > 0;
    }
    return (vm.raw.appointment?.slotsOfAppointment?.length ?? 0) > 0;
  };

  const primaryAction = (vm: AppointmentVM): PrimaryAction => {
    if (vm.needsActionReason === "UNSCHEDULED") {
      return {
        kind: "schedule",
        label: "Set schedule",
        onClick: () => openTimings(vm),
      };
    }
    if (canJoinNow(vm)) {
      return {
        kind: "join",
        label: "Join",
        onClick: () => void joinVm(vm),
        busy: joiningId === vm.id,
      };
    }
    return { kind: "view", label: "View" };
  };

  const overflowItems = (vm: AppointmentVM): OverflowItem[] => {
    const items: OverflowItem[] = [];
    const appointment = vm.raw.appointment;
    const inactive = isInactiveStatus(vm.status);
    const rawSlots = actionableRawSlots(vm);
    const lifecycleOk = canManageBookingLifecycle(vm);
    const isTrial = vm.kind === "TRIAL";

    // Manage Timings moves sessions with no notice and no acceptance, so it is
    // only offered where nobody else has committed to the time. A 1:1 whose
    // consultee already holds a confirmed slot gets Reschedule below instead —
    // the two are alternatives, never both (#1082).
    const timingsOk = allowsManageTimings(vm.kind, rawSlots);

    if (
      appointment &&
      vm.bucket !== "cancelled" &&
      vm.bucket !== "past" &&
      timingsOk
    ) {
      items.push({
        key: "timings",
        label: "Timings",
        onClick: () => openTimings(vm),
      });
    }
    if (appointment && supportsParticipantManagement(appointment)) {
      items.push({
        key: "participants",
        label: "Participants",
        onClick: () =>
          router.push(getParticipantManagementUrl(appointment, consultantId)),
      });
    }

    if (
      vm.appointmentId &&
      !isTrial &&
      lifecycleOk &&
      !inactive &&
      isApprovedStatus(vm.status) &&
      // Reschedule is the negotiated path, so it belongs exactly where Manage
      // Timings does not: a booking a counterparty holds a confirmed time on.
      !timingsOk &&
      slotsAllowReschedule(rawSlots)
    ) {
      items.push({
        key: "reschedule",
        label: "Reschedule",
        // The consultant's OWN reschedule route. This surface used to mount
        // the consultee's dialog, which has no equivalent page a consultant
        // may open: that route's consultee ownership check would 403 them.
        onClick: () =>
          router.push(
            `/dashboard/consultant/${consultantId}/appointments/${vm.appointmentId}/reschedule`,
          ),
      });
    }

    // Unschedule is not a third branch of the pair above: a confirmed webinar
    // offers Timings AND this. It withdraws the date only — the booking stays
    // sold, attendees stay enrolled, no money moves — which is the whole of
    // what separates it from Cancel below (#1082).
    if (
      vm.appointmentId &&
      lifecycleOk &&
      !inactive &&
      // The route's own from-state for a group release is SCHEDULED/IN_PROGRESS.
      isConfirmedStatus(vm.status) &&
      allowsUnschedule(vm.kind, rawSlots)
    ) {
      items.push({
        key: "unschedule",
        label: "Unschedule",
        onClick: () => openDialog(vm, "unschedule"),
      });
    }

    if (vm.appointmentId && !isTrial && lifecycleOk && !inactive) {
      items.push({
        key: "cancel",
        label: "Cancel booking",
        destructive: true,
        onClick: () => openDialog(vm, "cancel"),
      });
    }

    if (
      vm.appointmentId &&
      isConfirmedStatus(vm.status) &&
      (vm.kind === "CONSULTATION" ||
        vm.kind === "SUBSCRIPTION" ||
        vm.kind === "TRIAL")
    ) {
      items.push({
        key: "documents",
        label: "Upload document",
        onClick: () => openDialog(vm, "documents"),
      });
    }

    // #1270 — the dev backdoor is ADDITIVE: a separately-labelled overflow
    // entry that appears exactly where the real Join does not. It must never
    // relax the primary action's gate, which is what the trial branch used to
    // do (`trialJoinable(vm) || isDev` re-labelled the real Join instead of
    // adding a second affordance, so on any dev build every trial offered a
    // "Join (Dev)" button whether or not it was genuinely joinable).
    if (isDev && hasSlotRows(vm) && !canJoinNow(vm)) {
      items.push({
        key: "dev-join",
        label: "Join (Dev)",
        onClick: () => void joinVm(vm, true),
      });
    }
    return items;
  };

  const renderDialogs = () => (
    <>
      {activeVm && (
        <>
          <CancelConfirmationDialog
            isOpen={dialog === "cancel"}
            onConfirm={async () => {
              await actions.handleCancelConfirm();
              closeDialog();
            }}
            onCancel={closeDialog}
            title={activeVm.title}
            consultant={activeVm.counterpart.name}
            appointmentType={typeLabel}
            isLoading={actions.isLoading}
            appointmentId={activeVm.appointmentId}
          />

          <UnscheduleConfirmationDialog
            isOpen={dialog === "unschedule"}
            onConfirm={async () => {
              await actions.handleUnschedule();
              closeDialog();
            }}
            onCancel={closeDialog}
            title={activeVm.title}
            appointmentType={typeLabel}
            isLoading={actions.isLoading}
          />

          {activeVm.appointmentId && dialog === "documents" && (
            <ConsultantResponseUpload
              appointmentId={activeVm.appointmentId}
              isOpen
              onClose={closeDialog}
              onSuccess={closeDialog}
            />
          )}
        </>
      )}
    </>
  );

  return {
    role: "consultant",
    detailHref: (vm) =>
      vm.appointmentId
        ? `/dashboard/consultant/${consultantId}/appointments/${vm.appointmentId}`
        : null,
    primaryAction,
    overflowItems,
    renderDialogs,
  };
}
