/**
 * Slot Allocation Service
 *
 * Unified allocation algorithms for all event types.
 * Handles auto, manual, and requested slot allocation.
 */

import * as Sentry from "@sentry/nextjs";
import { reportSentryError } from "@/lib/observability/report";
import { recordParticipants } from "@/lib/booking/participants";
import prisma, {
  type Tx,
  type PrismaLike,
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
} from "@/lib/prisma";
import {
  Appointment,
  AppointmentsType,
  type DayOfWeek,
  Prisma,
  AppointmentStatus,
  ScheduleType,
  SlotCompletionStatus,
  SlotOfAppointment,
} from "@prisma/client";
import { addMonths } from "date-fns";
import {
  AllocationErrorCode,
  AllocationRequest,
  AllocationResult,
  EventType,
  ConsultantAllocationData,
  EventConfig,
  isRecurringEventType,
} from "./types";
import { SlotCalculationService } from "./SlotCalculationService";
import {
  countHalfHourAtoms,
  halfHourAtomStarts,
} from "@/lib/appointments/contiguous-slot-run";
import {
  matchesPreferredDays,
  maxPreferenceScore,
  scoreCandidateStart,
  type AllocationPreference,
} from "./preferenceScoring";
import {
  SlotValidationService,
  isOccupiedByLiveAppointment,
} from "./SlotValidationService";
import {
  buildConsultantOccupancyWhere,
  buildOccupiedAppointmentFilter,
} from "./occupancyPolicy";
import {
  MAX_CLASS_SESSIONS_PER_DAY,
  MAX_SUBSCRIPTION_SESSIONS_PER_DAY,
} from "./sessionCaps";
import {
  lockAutoAllocate,
  unlockAutoAllocate,
  lockConsulteeBooking,
  unlockConsulteeBooking,
  type ApprovalLock,
} from "@/utils/appointmentlock";
import { isExclusionViolation, isUniqueViolation } from "@/lib/db/pg-errors";
import {
  ALLOCATION_APPROVABLE_FROM,
  EVENT_ALLOWED_FROM,
  CLASS_EVENT_ALLOWED_FROM,
  RESCHEDULE_OPEN_STATUSES,
  transitionConsultationRequest,
  transitionRescheduleRequest,
  transitionSubscriptionRequest,
} from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import {
  isMinuteWithinWeeklySlot,
  TWENTY_FOUR_HOURS_IN_MS,
} from "./slotTimeUtils";
import {
  utcStartDayIndex,
  weeklyRowDurationMinutes,
} from "@/utils/schedule/weekly-projection";
import {
  AllocationValidationError,
  AllocationNotFoundError,
  AllocationConflictError,
  SlotShortageError,
} from "./errors";
import {
  recordBookingUtilization,
  reverseBookingUtilization,
  ProgramAssignmentLimitError,
} from "@/lib/api/organizations/program-helpers";
import {
  assertCollaboratorsAvailableForWindows,
  CollaboratorUnavailableError,
} from "@/lib/collaborators/availability";
import { resolveCancellationPolicySnapshot } from "@/lib/payments/operations/cancellation-policy";
import {
  notifyAppointmentBooked,
  notifyAppointmentPartiallyScheduled,
} from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";

type AppointmentWithSlots = Appointment & {
  slotsOfAppointment: SlotOfAppointment[];
};

const SLOT_DURATION_MS = 30 * 60 * 1000;

/**
 * Ceiling on the 30-minute starts walked from one availability row.
 *
 * The walk stops at the first candidate outside availability, but adjacent rows
 * make `isWithinAvailability` keep answering true past this row's own end, so a
 * consultant with contiguous cover would otherwise walk the whole week. 48 steps
 * is a day of cover, which bounds the scan without truncating any real row.
 */
const MAX_CANDIDATE_STARTS_PER_ROW = 48;

/**
 * #1194 — who is being scheduled, carried down the row walk so a truncated
 * availability row names a consultant and an event instead of appearing as an
 * anonymous "no slots available".
 */
interface AllocationWalkContext {
  eventType: EventType;
  eventId?: string;
  consultantProfileId?: string;
  /**
   * Rows already reported as truncated on THIS allocation. The walk re-visits
   * a row once per day, and again after every placement, so without this one
   * long row emits hundreds of identical warnings and evicts every other
   * breadcrumb on the Sentry scope — losing the context the report exists for.
   */
  reportedTruncations?: Set<string>;
}

/**
 * Main service for slot allocation operations
 */
export class SlotAllocationService {
  /**
   * Main entry point for slot allocation
   * Routes to appropriate allocation method based on mode
   */
  static async allocate(request: AllocationRequest): Promise<AllocationResult> {
    try {
      const result = await this.dispatch(request);
      // PR 2c — the allocation-time notification (audit G1 / B9's promised
      // completion): APPOINTMENT_BOOKED was deliberately skipped at payment
      // when no slots existed; THIS is where the times finally exist, so both
      // parties hear about them from every caller path (routes, auto-confirm,
      // accept-proposal). Fire-and-forget: a Novu outage must never fail an
      // allocation.
      // #1206 — the suppressor. A top-up that placed nothing is a successful
      // no-op, and the sweep runs hourly against every incomplete event, so
      // notifying here would page the consultee once an hour until their
      // consultant happens to publish more availability.
      if (result.success && result.noChange !== true) {
        void this.notifyAllocationPlaced(request.eventType, request.eventId, {
          // #1206 — tell the consultee HOW MANY sessions are scheduled and
          // that the rest follow, rather than a bare "you're booked".
          partial: result.partial === true,
          placedSessions: result.placedSessions,
          requiredSessions: result.requiredSessions,
          unplacedSessions: result.unplacedSessions,
        }).catch(() => {});
      }
      return result;
    } catch (error) {
      const { errorCode, httpStatus } = this.classifyError(error);
      // Full-coverage policy: every error reaching here is reported, modelled
      // outcome or not, so volume/pattern of ordinary answers (slot taken,
      // limit reached, lost CAS race) is visible in Sentry too — but at
      // info + expected:true so a dashboard scan can't mistake "no slots
      // available" for a database failure. Real faults keep the default
      // error level with no expected tag.
      const modeled = this.isModeledOutcome(error);
      reportSentryError(error, {
        subsystem: "scheduling",
        op: "slot-allocation",
        expected: modeled,
        extra: {
          mode: request.mode,
          eventType: request.eventType,
          eventId: request.eventId,
          errorCode,
        },
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Allocation failed",
        errorCode,
        httpStatus,
        // #1206 — a shortage refusal carries the count the client needs to
        // offer "allocate N now, the rest when availability opens".
        ...(error instanceof SlotShortageError
          ? {
              placeableSessions: error.placeableSessions,
              requiredSessions: error.requiredSessions,
            }
          : {}),
      };
    }
  }

  /**
   * Mode router extracted so allocate() can post-process success uniformly
   * (PR 2c notification) without each mode knowing about it.
   */
  private static async dispatch(
    request: AllocationRequest,
  ): Promise<AllocationResult> {
    switch (request.mode) {
      case "auto":
        return await this.autoAllocate(
          request.eventType,
          request.eventId,
          request.idempotencyKey,
          request.initialAllocation,
          request.expectedTentativeSlotCount,
          request.allowPartial,
          request.topUp,
        );

      case "manual":
        if (!request.slots || request.slots.length === 0) {
          return {
            success: false,
            error: "Slots are required for manual allocation",
            errorCode: "VALIDATION_ERROR",
            httpStatus: 400,
          };
        }
        return await this.manualAllocate(
          request.eventType,
          request.eventId,
          request.slots,
          request.idempotencyKey,
          request.initialAllocation,
          request.wideLock,
          request.expectedTentativeSlotCount,
        );

      case "requested":
        return await this.useRequestedSlots(
          request.eventType,
          request.eventId,
          request.initialAllocation,
          request.idempotencyKey,
          request.override,
          request.expectedTentativeSlotCount,
        );

      default:
        return {
          success: false,
          error: `Invalid allocation mode: ${request.mode}`,
          errorCode: "INVALID_MODE",
          httpStatus: 400,
        };
    }
  }

  /**
   * PR 2c — fire-and-forget APPOINTMENT_BOOKED to both parties once real
   * times exist. Completes the B9 story: payment skipped this notification
   * for slot-less bookings on purpose.
   */
  private static async notifyAllocationPlaced(
    eventType: EventType,
    eventId: string,
    /**
     * #1206 — when only some of the plan's sessions were placed, the consultee
     * must be told how many are scheduled and what happens to the rest.
     */
    partial?: {
      partial: boolean;
      placedSessions?: number;
      requiredSessions?: number;
      unplacedSessions?: number;
    },
  ): Promise<void> {
    let context: {
      userIds: string[];
      // #1206 — the partial notice goes to these only; the consultant was
      // already shown the shortfall and confirmed it.
      consulteeUserIds: string[];
      consultantName: string;
      consulteeName: string;
      planTitle: string;
      firstStart: Date | null;
      organizationId: string | null;
      appointmentId?: string;
    } | null = null;

    if (eventType === "consultation") {
      const row = await prisma.consultation.findUnique({
        where: { id: eventId },
        select: {
          consultationPlan: {
            select: {
              title: true,
              consultantProfile: {
                select: { user: { select: { id: true, name: true } } },
              },
            },
          },
          requestedBy: {
            select: { user: { select: { id: true, name: true } } },
          },
          appointment: {
            select: {
              id: true,
              organizationId: true,
              slotsOfAppointment: {
                where: { isTentative: false, deletedAt: null },
                orderBy: { startsAt: "asc" },
                take: 1,
                select: { startsAt: true },
              },
            },
          },
        },
      });
      if (!row?.appointment) return;
      context = {
        userIds: [
          row.consultationPlan.consultantProfile.user.id,
          row.requestedBy.user.id,
        ].filter(Boolean),
        consulteeUserIds: [row.requestedBy.user.id].filter(Boolean),
        consultantName:
          row.consultationPlan.consultantProfile.user.name || "Consultant",
        consulteeName: row.requestedBy.user.name || "Consultee",
        planTitle: row.consultationPlan.title,
        firstStart: row.appointment.slotsOfAppointment[0]?.startsAt ?? null,
        organizationId: row.appointment.organizationId,
        appointmentId: row.appointment.id,
      };
    } else if (eventType === "subscription") {
      const row = await prisma.subscription.findUnique({
        where: { id: eventId },
        select: {
          subscriptionPlan: {
            select: {
              title: true,
              consultantProfile: {
                select: { user: { select: { id: true, name: true } } },
              },
            },
          },
          requestedBy: {
            select: { user: { select: { id: true, name: true } } },
          },
          appointments: {
            select: {
              id: true,
              organizationId: true,
              slotsOfAppointment: {
                where: { isTentative: false, deletedAt: null },
                orderBy: { startsAt: "asc" },
                take: 1,
                select: { startsAt: true },
              },
            },
          },
        },
      });
      if (!row || row.appointments.length === 0) return;
      context = {
        userIds: [
          row.subscriptionPlan.consultantProfile.user.id,
          row.requestedBy.user.id,
        ].filter(Boolean),
        consulteeUserIds: [row.requestedBy.user.id].filter(Boolean),
        consultantName:
          row.subscriptionPlan.consultantProfile.user.name || "Consultant",
        consulteeName: row.requestedBy.user.name || "Consultee",
        planTitle: row.subscriptionPlan.title,
        firstStart: row.appointments[0].slotsOfAppointment[0]?.startsAt ?? null,
        organizationId: row.appointments[0].organizationId,
        appointmentId: row.appointments[0].id,
      };
    } else if (eventType === "webinar") {
      const row = await prisma.webinar.findUnique({
        where: { id: eventId },
        select: {
          webinarPlan: {
            select: {
              title: true,
              consultantProfile: {
                select: { user: { select: { id: true, name: true } } },
              },
            },
          },
          appointment: {
            select: {
              id: true,
              organizationId: true,
              slotsOfAppointment: {
                where: { isTentative: false, deletedAt: null },
                select: {
                  startsAt: true,
                  user: { select: { id: true, name: true } },
                },
              },
            },
          },
        },
      });
      if (!row?.appointment) return;
      const plan = row.webinarPlan;
      const hostUser = plan.consultantProfile?.user;
      if (!hostUser) return;
      const userMap = new Map<string, string>();
      let firstStart: Date | null = null;
      for (const slot of row.appointment.slotsOfAppointment) {
        if (!firstStart || slot.startsAt < firstStart)
          firstStart = slot.startsAt;
        for (const u of slot.user ?? [])
          userMap.set(u.id, u.name ?? "Attendee");
      }
      userMap.delete(hostUser.id);
      context = {
        userIds: [hostUser.id, ...userMap.keys()],
        consulteeUserIds: [...userMap.keys()],
        consultantName: hostUser.name || "Consultant",
        consulteeName:
          userMap.size === 1
            ? [...userMap.values()][0]
            : `${userMap.size} attendees`,
        planTitle: plan.title,
        firstStart,
        organizationId: row.appointment.organizationId,
        appointmentId: row.appointment.id,
      };
    } else {
      const row = await prisma.class.findUnique({
        where: { id: eventId },
        select: {
          classPlan: {
            select: {
              title: true,
              consultantProfile: {
                select: { user: { select: { id: true, name: true } } },
              },
            },
          },
          appointments: {
            select: {
              id: true,
              organizationId: true,
              slotsOfAppointment: {
                where: { isTentative: false, deletedAt: null },
                select: {
                  startsAt: true,
                  user: { select: { id: true, name: true } },
                },
              },
            },
          },
        },
      });
      if (!row) return;
      const appts = row.appointments.filter(Boolean);
      if (appts.length === 0) return;
      const plan = row.classPlan;
      const hostUser = plan.consultantProfile?.user;
      if (!hostUser) return;
      const host = hostUser;
      const userMap = new Map<string, string>();
      let firstStart: Date | null = null;
      for (const a of appts) {
        for (const slot of a.slotsOfAppointment) {
          if (!firstStart || slot.startsAt < firstStart)
            firstStart = slot.startsAt;
          for (const u of slot.user ?? [])
            userMap.set(u.id, u.name ?? "Attendee");
        }
      }
      userMap.delete(host.id);
      context = {
        userIds: [host.id, ...userMap.keys()],
        consulteeUserIds: [...userMap.keys()],
        consultantName: host.name || "Consultant",
        consulteeName:
          userMap.size === 1
            ? [...userMap.values()][0]
            : `${userMap.size} attendees`,
        planTitle: plan.title,
        firstStart,
        organizationId: appts[0]!.organizationId,
        appointmentId: appts[0]!.id,
      };
    }

    if (!context || context.userIds.length === 0) return;

    const payload = {
      ...notificationScope(context.organizationId),
      appointmentId: context.appointmentId,
      dateTime: context.firstStart?.toISOString(),
      appointmentType: eventType,
      consultantName: context.consultantName,
      consulteeName: context.consulteeName,
      planTitle: context.planTitle,
      dashboardUrl: notificationHref(context.organizationId, "appointments"),
    };

    void notifyAppointmentBooked(context.userIds, payload);

    // #1206 — a second, separate notice rather than a flag on the booking one:
    // the times that WERE placed are a real booking and read as one, and the
    // thing the consultee has to be told is what happened to the rest.
    if (partial?.partial && context.consulteeUserIds.length > 0) {
      void notifyAppointmentPartiallyScheduled(context.consulteeUserIds, {
        ...payload,
        placedSessions: partial.placedSessions ?? 0,
        requiredSessions: partial.requiredSessions ?? 0,
        unplacedSessions: partial.unplacedSessions ?? 0,
      });
    }
  }

  /**
   * Whether `error` is one of the modelled business outcomes this engine
   * throws for ordinary reasons (validation, not-found, lock/CAS contention,
   * an org cap reached) rather than an actual fault. Both branches are
   * reported to Sentry (full-coverage policy); this only decides the
   * level/tag so a modelled answer never reads as a fault on the dashboard.
   * Deliberately narrower than classifyError()'s message-sniffing fallback,
   * which exists only to pick an HTTP status for legacy untyped throws and
   * would otherwise also mark real bugs "expected" if the message happens to
   * contain "not found".
   */
  private static isModeledOutcome(error: unknown): boolean {
    return (
      error instanceof AllocationValidationError ||
      error instanceof AllocationNotFoundError ||
      error instanceof AllocationConflictError ||
      error instanceof IllegalTransitionError ||
      error instanceof ProgramAssignmentLimitError ||
      isUniqueViolation(error) ||
      isExclusionViolation(error) ||
      // AE-2 (#784) — a co-host already committed elsewhere is a scheduling
      // answer, not a fault.
      error instanceof CollaboratorUnavailableError
    );
  }

  /**
   * AE-2 (#784) — refuse to commit these times when an ACCEPTED co-host on a
   * webinar/class plan is already busy. Co-hosts are not slot participants, so
   * neither `slot_no_confirmed_overlap` nor the owner-scoped validators see
   * them; only this guard does. No-op for consultations/subscriptions (no
   * collaborators) and for plans with no accepted co-hosts.
   *
   * Contiguous 30-minute atoms are merged back into session windows by the
   * helper, so one query covers a whole class allocation.
   */
  private static async assertCollaboratorsFree(
    tx: Tx,
    eventType: EventType,
    planId: string | null | undefined,
    slotStarts: Date[],
    excludeAppointmentIds: string[],
  ): Promise<void> {
    if (eventType !== "webinar" && eventType !== "class") return;
    if (!planId || slotStarts.length === 0) return;

    await assertCollaboratorsAvailableForWindows(tx, {
      planType: eventType === "webinar" ? "WEBINAR" : "CLASS",
      planId,
      windows: slotStarts.map((startsAt) => ({
        startsAt,
        endsAt: new Date(startsAt.getTime() + SLOT_DURATION_MS),
      })),
      excludeAppointmentIds,
    });
  }

  /**
   * Classifies an unknown error into a structured error code and HTTP status.
   * Called from the allocate() catch block to avoid string-prefix checks in routes.
   */
  private static classifyError(error: unknown): {
    errorCode: AllocationErrorCode;
    httpStatus: number;
  } {
    // Typed error classes — primary classification mechanism
    if (error instanceof AllocationValidationError) {
      return { errorCode: error.errorCode, httpStatus: error.httpStatus };
    }
    if (error instanceof AllocationNotFoundError) {
      return { errorCode: error.errorCode, httpStatus: error.httpStatus };
    }
    if (error instanceof AllocationConflictError) {
      return { errorCode: error.errorCode, httpStatus: error.httpStatus };
    }
    // #836 — consultee cancelled (or request expired) while the consultant
    // was allocating; the whole allocation tx rolled back.
    if (error instanceof IllegalTransitionError) {
      return { errorCode: "ILLEGAL_TRANSITION", httpStatus: error.httpStatus };
    }

    // The org's per-cycle overage ceiling refusing an assignment is a decision,
    // not a fault. It was already reported to Sentry as an expected outcome
    // while falling through to UNKNOWN_ERROR/500 here — so the dashboard called
    // it routine and the caller got a server error. 402 matches what
    // recordOverageAtCheckout returns for the very same ceiling.
    if (error instanceof ProgramAssignmentLimitError) {
      return { errorCode: "PROGRAM_CAP_EXHAUSTED", httpStatus: 402 };
    }

    // AE-2 (#784) — a co-host's clash is a conflict, and the crud-with-plan
    // routes already answer 409 for the identical rejection.
    if (error instanceof CollaboratorUnavailableError) {
      return { errorCode: "COLLABORATOR_UNAVAILABLE", httpStatus: 409 };
    }

    // Structured DB-conflict detection (no message sniffing): unique (P2002 /
    // 23505) and the #440 exclusion constraint (23P01). createAppointments
    // already rethrows these as a typed AllocationConflictError at the source;
    // this is the safety net for the conflict paths that don't (e.g. the
    // requested-slots isTentative flip).
    if (isUniqueViolation(error) || isExclusionViolation(error)) {
      return { errorCode: "LOCK_CONTENTION", httpStatus: 409 };
    }

    // Last-resort fallback for untyped throws from legacy code paths. Matching on
    // message text is fragile; migrating these callers to typed errors is #837.
    const msg = error instanceof Error ? error.message : "";
    if (
      msg.includes("lock") ||
      msg.includes("Lock") ||
      msg.includes("in progress")
    ) {
      return { errorCode: "LOCK_CONTENTION", httpStatus: 409 };
    }
    if (msg.includes("not found") || msg.includes("no consultant")) {
      return { errorCode: "NOT_FOUND", httpStatus: 400 };
    }
    return { errorCode: "UNKNOWN_ERROR", httpStatus: 500 };
  }

  /**
   * Lightweight pre-fetch to get consultantProfileId for lock acquisition.
   * Runs OUTSIDE the transaction, before the distributed lock is acquired.
   *
   * FIX Issue #1 from Architecture Review (#446):
   * autoAllocate() needs a consultant-level lock to prevent concurrent
   * auto-allocations from double-booking the same slots.
   */
  private static async getConsultantProfileId(
    eventType: EventType,
    eventId: string,
  ): Promise<string | null> {
    switch (eventType) {
      case "consultation": {
        const event = await prisma.consultation.findUnique({
          where: { id: eventId },
          select: {
            consultationPlan: { select: { consultantProfileId: true } },
          },
        });
        return event?.consultationPlan?.consultantProfileId ?? null;
      }
      case "subscription": {
        const event = await prisma.subscription.findUnique({
          where: { id: eventId },
          select: {
            subscriptionPlan: { select: { consultantProfileId: true } },
          },
        });
        return event?.subscriptionPlan?.consultantProfileId ?? null;
      }
      case "webinar": {
        const event = await prisma.webinar.findUnique({
          where: { id: eventId },
          select: {
            webinarPlan: { select: { consultantProfileId: true } },
          },
        });
        return event?.webinarPlan?.consultantProfileId ?? null;
      }
      case "class": {
        const event = await prisma.class.findUnique({
          where: { id: eventId },
          select: { classPlan: { select: { consultantProfileId: true } } },
        });
        return event?.classPlan?.consultantProfileId ?? null;
      }
      default:
        return null;
    }
  }

  /**
   * #898 follow-up — resolve the single consultee's user id for the
   * consultee-booking lock key. Only CONSULTATION/SUBSCRIPTION have one booker;
   * WEBINAR/CLASS are group events (many attendees) with no single consultee to
   * serialize on, so they return null and skip the lock.
   */
  private static async getConsulteeUserId(
    eventType: EventType,
    eventId: string,
  ): Promise<string | null> {
    switch (eventType) {
      case "consultation": {
        const event = await prisma.consultation.findUnique({
          where: { id: eventId },
          select: {
            requestedBy: { select: { user: { select: { id: true } } } },
          },
        });
        return event?.requestedBy?.user?.id ?? null;
      }
      case "subscription": {
        const event = await prisma.subscription.findUnique({
          where: { id: eventId },
          select: {
            requestedBy: { select: { user: { select: { id: true } } } },
          },
        });
        return event?.requestedBy?.user?.id ?? null;
      }
      default:
        return null;
    }
  }

  /**
   * Multi-tab guard for `initialAllocation` requests. Auto locks the whole
   * consultant while manual shards by day (#860) — different Redis keys — and
   * group events have no consultee lock, so a cross-mode race from two tabs
   * can slip past the locks; without this the manual path would silently
   * delete-and-replace the winner's allocation. Any confirmed (non-tentative)
   * slot means the event was already allocated elsewhere → typed 409.
   * Called out-of-txn under the locks AND re-checked inside the write txn.
   */
  /**
   * In-transaction variant of the guard. Under Read Committed, two
   * concurrent transactions could BOTH count zero confirmed slots before
   * either commits (group events don't share a Redis lock across modes), so
   * the count alone is not atomic. The advisory xact lock serializes the
   * guarded transactions per event: the loser blocks until the winner
   * commits. After the lock, a same-key double submit must REPLAY the
   * winner's committed batch (the base-client read sees it post-commit)
   * rather than trip the guard with a 409; only a different-key submit gets
   * the conflict. Raw SQL is unavoidable — Prisma has no advisory-lock API.
   */
  private static async guardInitialAllocationInTx(
    tx: Tx,
    eventType: EventType,
    eventId: string,
    idempotencyKey?: string,
  ): Promise<AllocationResult | null> {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`initial-allocation:${eventType}:${eventId}`}, 42))`;
    const lockedReplay = await this.findIdempotentAllocation(
      eventType,
      eventId,
      idempotencyKey,
    );
    if (lockedReplay) return lockedReplay;
    await this.assertNoConfirmedSlots(tx, eventType, eventId);
    return null;
  }

  private static async assertNoConfirmedSlots(
    db: PrismaLike,
    eventType: EventType,
    eventId: string,
  ): Promise<void> {
    const relationField = this.getEventRelationField(eventType);
    const confirmed = await db.slotOfAppointment.count({
      where: {
        isTentative: false,
        deletedAt: null,
        appointment: {
          [`${relationField}Id`]: eventId,
          deletedAt: null,
        } as Prisma.AppointmentWhereInput,
      },
    });
    if (confirmed > 0) {
      throw new AllocationConflictError(
        `This ${eventType} was already allocated in another session ` +
          `(${confirmed} confirmed slot(s) exist).`,
      );
    }
  }

  /**
   * #1012 — stale-tab reschedule precondition. The page that opened the
   * allocate dialog captured the tentative count; if another tab already
   * finished (or mutated) the reschedule, that count no longer matches and
   * we 409 instead of delete+recreating confirmed slots.
   */
  private static assertExpectedTentativeSlotCount(
    actual: number,
    expected: number | undefined,
  ): void {
    if (expected === undefined) return;
    if (actual !== expected) {
      throw new AllocationConflictError(
        `Reschedule state changed in another session ` +
          `(expected ${expected} tentative slot(s), found ${actual}). ` +
          `Reload and try again.`,
      );
    }
  }

  /**
   * #1012 — in-txn re-assert of expectedTentativeSlotCount.
   *
   * The pre-txn read only catches sequential stale submissions. Under the
   * Redis lock another writer can still commit between that read and our
   * write txn (e.g. a second tab that raced the lock, or useRequestedSlots).
   * `guardInitialAllocationInTx` only covers fresh allocations, not
   * reschedules. Re-read with `tx` before delete/recreate, matching the
   * requested-slots path.
   */
  private static async assertExpectedTentativeSlotCountInTx(
    tx: Tx,
    eventType: EventType,
    eventId: string,
    expected: number | undefined,
  ): Promise<void> {
    if (expected === undefined) return;
    const relationField = this.getEventRelationField(eventType);
    const existingAppointments: AppointmentWithSlots[] =
      await tx.appointment.findMany({
        where: {
          [`${relationField}Id`]: eventId,
        } as Prisma.AppointmentWhereInput,
        include: { slotsOfAppointment: true },
      });
    const tentativeSlotCount = existingAppointments.reduce(
      (count, appointment) =>
        count +
        appointment.slotsOfAppointment.filter((slot) => slot.isTentative)
          .length,
      0,
    );
    this.assertExpectedTentativeSlotCount(tentativeSlotCount, expected);
  }

  /**
   * AUTO ALLOCATION: Find and allocate first available consecutive slots
   *
   * FIX Issue #1 from Architecture Review (#446):
   * Wrapped in a consultant-level distributed lock to prevent concurrent
   * auto-allocations from reading the same slots as "available" and
   * double-booking. The lock is acquired BEFORE the Prisma transaction
   * and released in a finally block to guarantee cleanup.
   */
  /**
   * #837 — idempotent-replay guard for double-submitted allocations. If this
   * batch's key already stamped an appointment, return that batch instead of
   * allocating again. The @unique on Appointment.allocationIdempotencyKey plus
   * the P2002 catch in createAppointments backstop the concurrent (not-yet-
   * committed) race, where two submits both pass this pre-check.
   */
  private static async findIdempotentAllocation(
    eventType: EventType,
    eventId: string,
    idempotencyKey?: string,
  ): Promise<AllocationResult | null> {
    if (!idempotencyKey) return null;

    const stamped = await prisma.appointment.findUnique({
      where: { allocationIdempotencyKey: idempotencyKey },
      select: {
        consultationId: true,
        subscriptionId: true,
        webinarId: true,
        classId: true,
      },
    });
    if (!stamped) return null;

    const relationField = this.getEventRelationField(eventType);
    const stampedEventId = (stamped as Record<string, string | null>)[
      `${relationField}Id`
    ];
    // Key is globally unique; a mismatch means the client reused it across
    // bookings — refuse rather than hand back another event's appointments.
    if (stampedEventId !== eventId) {
      throw new AllocationConflictError(
        "This idempotency key was already used for a different allocation.",
      );
    }

    // The key only stamps the FIRST appointment; return the whole batch.
    const appointments = await prisma.appointment.findMany({
      where: {
        [`${relationField}Id`]: eventId,
      } as Prisma.AppointmentWhereInput,
      include: { slotsOfAppointment: true },
    });
    return {
      success: true,
      appointments,
      ...(await this.replayPartialCounts(eventType, eventId, appointments)),
    };
  }

  /**
   * #1206 — a replay must not tell the consultee the plan is complete.
   *
   * `allocate()` derives the notification and the consultant's toast from
   * `partial`, so returning the stored batch bare made every double-submit of a
   * partial run read as "all sessions have been automatically scheduled". The
   * counts are re-derived from what is stored — one Appointment per session,
   * against the plan's `totalSessions` — so nothing about the shortfall is
   * persisted here either. Only recurring events can be partial; anything else
   * (and any event whose plan is unreadable) omits the fields and keeps the
   * pre-existing "complete" reading, which is correct for a single session.
   */
  private static async replayPartialCounts(
    eventType: EventType,
    eventId: string,
    appointments: { deletedAt?: Date | null }[],
  ): Promise<Partial<AllocationResult>> {
    if (!isRecurringEventType(eventType)) return {};

    const requiredSessions =
      eventType === "subscription"
        ? (
            await prisma.subscription.findUnique({
              where: { id: eventId },
              select: { subscriptionPlan: { select: { totalSessions: true } } },
            })
          )?.subscriptionPlan?.totalSessions
        : (
            await prisma.class.findUnique({
              where: { id: eventId },
              select: { classPlan: { select: { totalSessions: true } } },
            })
          )?.classPlan?.totalSessions;

    if (!requiredSessions || requiredSessions <= 0) return {};

    // Tombstoned rows are not placed sessions; the returned batch is left as
    // it was so the replay still hands back exactly what the first call did.
    const placedSessions = appointments.filter((a) => !a.deletedAt).length;
    return {
      partial: placedSessions < requiredSessions,
      placedSessions,
      requiredSessions,
      unplacedSessions: Math.max(0, requiredSessions - placedSessions),
    };
  }

  /**
   * The slots this allocation is replacing — the ones a reschedule released.
   *
   * These are the identity of the reschedule, and the only safe key for finding
   * what the initiator asked for. `RescheduleRequest.appointmentId` is NOT: the
   * consultee's reschedule URL resolves to the booking's next actionable
   * session (map-consultee's nextActionableChild) while the picker deliberately
   * offers every session of the program, so on a multi-session booking the row
   * is written against one appointment and the released slots land on another.
   * Keying on the appointment made the preference apply only when the released
   * session happened to be the next one — silent, and right often enough to
   * look flaky rather than broken.
   *
   * RESCHEDULED rather than merely tentative: every pending request carries
   * tentative slots (request-for-approval and unpaid checkout both create them
   * that way), and those were never released by anybody.
   */
  private static releasedSlotIdsOf(
    appointments: AppointmentWithSlots[],
  ): string[] {
    return appointments.flatMap((appointment) =>
      appointment.slotsOfAppointment
        .filter(
          (slot) =>
            slot.isTentative &&
            slot.completionStatus === SlotCompletionStatus.RESCHEDULED,
        )
        .map((slot) => slot.id),
    );
  }

  /** Open, preference-bearing reschedules that released any of these slots. */
  private static openPreferenceRequestWhere(
    releasedSlotIds: string[],
  ): Prisma.RescheduleRequestWhereInput {
    return {
      releasedSlotIds: { hasSome: releasedSlotIds },
      status: { in: RESCHEDULE_OPEN_STATUSES },
      OR: [
        { preferredTimeOfDay: { not: null } },
        { preferredDays: { not: null } },
      ],
    };
  }

  /**
   * The preference attached to the reschedule that released these slots, if the
   * initiator stated one (#1065).
   *
   * Read here rather than passed in because the allocator is reached from the
   * consultant's allocate surface, the auto-confirm path and the API route
   * alike — none of which know what the consultee asked for. Empty for every
   * non-reschedule allocation, which is exactly when it must not apply.
   *
   * Matching on the released slots also scopes it in TIME without needing a
   * timestamp: a consumed reschedule's slot rows are deleted and replaced with
   * fresh ids, so a stale row from an earlier reschedule of the same session
   * cannot overlap this one and cannot leak its preference into it.
   */
  private static async findAllocationPreference(
    releasedSlotIds: string[],
  ): Promise<AllocationPreference | undefined> {
    if (releasedSlotIds.length === 0) return undefined;

    const stated = await prisma.rescheduleRequest.findFirst({
      where: this.openPreferenceRequestWhere(releasedSlotIds),
      // Newest wins; an older ask must not outrank the current one.
      orderBy: { createdAt: "desc" },
      select: { preferredTimeOfDay: true, preferredDays: true },
    });

    return stated ?? undefined;
  }

  /**
   * Close the preference-only reschedule this allocation just answered.
   *
   * Placing replacement times IS the answer to "move these, ideally mornings",
   * so leaving the row PENDING_REVIEW would both mislabel it in the audit trail
   * — it was fulfilled, not lapsed unanswered — and keep its
   * openForAppointmentId reservation held until the hourly expiry sweep, which
   * would block the consultee from rescheduling the same booking again for up
   * to 72 hours.
   *
   * Deliberately scoped to rows carrying NO proposed times. A request that
   * named times and got different ones back has not been accepted, and how that
   * case resolves is existing behaviour (it lapses to EXPIRED) that this change
   * has no business rewriting.
   *
   * resolvedById is left null: the allocator is reached from routes, crons and
   * the auto-confirm path, and inventing an actor here would be worse than
   * recording none.
   */
  private static async resolveConsumedPreferenceRequests(
    tx: Tx,
    releasedSlotIds: string[],
  ): Promise<void> {
    if (releasedSlotIds.length === 0) return;

    const consumed = await tx.rescheduleRequest.findMany({
      where: {
        ...this.openPreferenceRequestWhere(releasedSlotIds),
        proposedSlots: { none: {} },
      },
      select: { id: true },
    });

    for (const request of consumed) {
      try {
        // The shared transition helper rather than a bare update: reaching a
        // terminal state is what releases openForAppointmentId and stamps
        // resolvedAt, and callers must not have to remember that.
        await transitionRescheduleRequest(tx, {
          where: { id: request.id },
          to: "ACCEPTED",
        });
      } catch (err) {
        // Losing the CAS means the initiator withdrew (or the sweep expired the
        // row) between the read above and here. That is a perfectly good ending
        // for the request and no reason to roll back an allocation that has
        // already placed real times — closing the row is bookkeeping, the
        // booking is the outcome.
        if (!(err instanceof IllegalTransitionError)) throw err;
      }
    }

    // E2E-audit P1 fix — times-bearing proposals must not dangle when the
    // consultant answers a concrete-times proposal by placing DIFFERENT times
    // directly on the calendar grid. The proposal used to stay PENDING_REVIEW
    // for up to its 72h lifetime with openForAppointmentId reserved — and a
    // stale Accept still passed every guard, re-ran the allocator at the
    // originally proposed times, and silently deleted the just-placed
    // confirmed slots. The manual placement IS the answer: close these as
    // DECLINED so the reschedule machine releases the reservation.
    const superseded = await tx.rescheduleRequest.findMany({
      where: {
        releasedSlotIds: { hasSome: releasedSlotIds },
        status: { in: [...RESCHEDULE_OPEN_STATUSES] },
      },
      select: { id: true },
    });
    for (const request of superseded) {
      try {
        await transitionRescheduleRequest(tx, {
          where: { id: request.id },
          to: "DECLINED",
        });
      } catch (err) {
        if (!(err instanceof IllegalTransitionError)) throw err;
      }
    }
  }

  private static async autoAllocate(
    eventType: EventType,
    eventId: string,
    idempotencyKey?: string,
    initialAllocation?: boolean,
    expectedTentativeSlotCount?: number,
    /**
     * #1206 — place every session that fits and leave the rest for the hourly
     * retry sweep. Only recurring events can be partial; a consultation or
     * webinar is one session, so `findAvailableSlots` reports 0 placeable and
     * the flag changes nothing.
     */
    allowPartial = false,
    /**
     * #1206 — top up an event a partial allocation left short: place only the
     * missing sessions and treat every confirmed appointment as fixed. See
     * `AllocationRequest.topUp` for why this is not the default.
     */
    topUp = false,
  ): Promise<AllocationResult> {
    // #837 — return the prior batch on a double-submit before doing any work.
    const replay = await this.findIdempotentAllocation(
      eventType,
      eventId,
      idempotencyKey,
    );
    if (replay) return replay;

    // Pre-fetch consultantProfileId for lock key (lightweight, outside transaction)
    const consultantProfileId = await this.getConsultantProfileId(
      eventType,
      eventId,
    );
    if (!consultantProfileId) {
      return {
        success: false,
        error: `${eventType} not found or has no consultant`,
        errorCode: "NOT_FOUND",
        httpStatus: 400,
      };
    }

    // Acquire consultant-level distributed lock before the transaction
    const lock = await lockAutoAllocate(consultantProfileId);
    // #898 follow-up — also serialize on the consultee so one person can't be
    // booked across two consultants concurrently (the GiST overlap guard is
    // consultant-keyed). Lock order: consultant → consultee.
    let consulteeLock: ApprovalLock | null = null;
    try {
      const consulteeLockUserId = await this.getConsulteeUserId(
        eventType,
        eventId,
      );
      if (consulteeLockUserId) {
        consulteeLock = await lockConsulteeBooking(consulteeLockUserId);
      }

      // #837 TOCTOU — the pre-lock replay check can miss a concurrent first
      // submit that stamped its key while we waited on the lock. Re-check now
      // that we hold the locks so the loser replays the winner's batch instead
      // of racing into the unique-constraint 409.
      const lockedReplay = await this.findIdempotentAllocation(
        eventType,
        eventId,
        idempotencyKey,
      );
      if (lockedReplay) return lockedReplay;

      // Multi-tab guard: a fresh dialog allocation must 409 if another
      // session already allocated this event (re-checked in-txn below).
      if (initialAllocation) {
        await this.assertNoConfirmedSlots(prisma, eventType, eventId);
      }

      // #908 — read/search/validate run OUTSIDE the write transaction, but still
      // UNDER the locks acquired above. An interactive txn pins its pooled
      // connection for its whole duration (incl. the JS between queries); doing
      // the heavy O(window) availability work here instead frees the pool so the
      // short write txn below can actually start (the old single-txn shape 500'd
      // on "Unable to start a transaction in the given time").
      const eventData = await this.fetchEventData(prisma, eventType, eventId);
      if (!eventData) {
        throw new AllocationNotFoundError(`${eventType} not found`);
      }

      const { consultant, config, consulteeUserId, organizationId, planId } =
        eventData;

      // CRITICAL FIX: Check for existing appointments to detect reschedule scenario
      // If tentative slots exist, this is a reschedule and we should preserve the original slot count
      const relationField = this.getEventRelationField(eventType);
      const existingAppointments: AppointmentWithSlots[] =
        await prisma.appointment.findMany({
          where: {
            [`${relationField}Id`]: eventId,
          } as Prisma.AppointmentWhereInput,
          include: { slotsOfAppointment: true },
        });

      // Count existing slots by tentative status
      const existingNonTentativeSlotCount = existingAppointments.reduce(
        (count, appointment) =>
          count +
          appointment.slotsOfAppointment.filter((slot) => !slot.isTentative)
            .length,
        0,
      );
      const tentativeSlotCount = existingAppointments.reduce(
        (count, appointment) =>
          count +
          appointment.slotsOfAppointment.filter((slot) => slot.isTentative)
            .length,
        0,
      );
      // #1012 — before any delete+recreate, confirm the page's view of the
      // tentative set still matches the database.
      this.assertExpectedTentativeSlotCount(
        tentativeSlotCount,
        expectedTentativeSlotCount,
      );
      const isReschedule = tentativeSlotCount > 0;

      // ADR B10, derived rather than trusted. The client set initialAllocation
      // only when tentativeSlotCount === 0, but EVERY pending request already
      // carries tentative slots (request-for-approval and unpaid checkout both
      // create them that way), so the flag was never true for a consultation
      // and the multi-tab guard never ran. Having no CONFIRMED slot is the real
      // "not allocated yet" condition. This matters most across modes: auto
      // takes a consultant-wide lock and a cap-less manual one a day-sharded
      // key (#860, narrowed by #1319), so two tabs are only serialized by the
      // in-txn advisory lock this gates.
      const isFreshAllocation =
        initialAllocation === true || existingNonTentativeSlotCount === 0;

      // Detect in-progress reallocation: past confirmed slots exist for recurring events
      const now = new Date();
      const pastConfirmedSlotCount = isReschedule
        ? 0
        : existingAppointments.reduce(
            (count, appt) =>
              count +
              appt.slotsOfAppointment.filter(
                (slot) => !slot.isTentative && new Date(slot.endsAt) <= now,
              ).length,
            0,
          );
      const isInProgressReallocation =
        !isReschedule &&
        pastConfirmedSlotCount > 0 &&
        isRecurringEventType(eventType);

      const slotsPerCall = SlotCalculationService.getSlotsPerCall(
        config.sessionDurationInHours || config.durationInHours || 1,
      );

      // #1206 — a top-up preserves what is confirmed and places only the
      // shortfall. It is the one auto path that never deletes, so it is gated
      // narrowly: a reschedule's tentative rows ARE the sessions being moved,
      // a single-session event has nothing to top up, and an event with no
      // confirmed sessions is an ordinary fresh allocation already.
      // A top-up that cannot apply is refused, never downgraded: the caller
      // asked to preserve, and the ordinary path deletes and re-plans.
      if (topUp === true) {
        if (!isRecurringEventType(eventType)) {
          throw new AllocationValidationError(
            "topUp applies to subscriptions and classes only; a single-session event has nothing to top up.",
          );
        }
        if (isReschedule) {
          throw new AllocationValidationError(
            "topUp cannot run while the event has tentative sessions; finish or clear the pending reallocation first.",
          );
        }
        if (existingNonTentativeSlotCount === 0) {
          throw new AllocationValidationError(
            "topUp needs at least one confirmed session to preserve; run an ordinary allocation instead.",
          );
        }
      }
      const isTopUp = topUp === true;

      // 1 Appointment = 1 session, the same identity the reschedule branch
      // below counts on. Counted by appointment rather than by dividing the
      // slot count, so a plan whose session duration changed mid-flight cannot
      // turn the shortfall into a fraction.
      const existingConfirmedSessionCount = existingAppointments.filter((a) =>
        a.slotsOfAppointment.some((s) => !s.isTentative),
      ).length;
      const topUpPlanSessions = isTopUp
        ? Math.ceil(
            SlotCalculationService.calculateRequiredSlots(eventType, config) /
              slotsPerCall,
          )
        : 0;
      /**
       * The answer a top-up gives when it writes nothing — the plan is already
       * whole, or the consultant's availability still has no room for the rest.
       * `placedSessions` is this run's placements, hence 0; the notification
       * suppressor fires on `noChange` before any template can read it.
       */
      const topUpNoChange = (): AllocationResult => {
        const unplacedSessions = Math.max(
          topUpPlanSessions - existingConfirmedSessionCount,
          0,
        );
        return {
          success: true,
          appointments: [],
          // Derived from the shortfall, so a whole plan never reads as partial.
          partial: unplacedSessions > 0,
          noChange: true,
          placedSessions: 0,
          requiredSessions: topUpPlanSessions,
          unplacedSessions,
        };
      };

      // Guard: reject re-allocation when event is already fully scheduled.
      // Applies to all event types (webinar, class, subscription) to prevent
      // concurrent auto-allocate calls from creating duplicate session sets.
      // For in-progress reallocation (recurring only), only count FUTURE confirmed slots.
      if (!isReschedule && existingNonTentativeSlotCount > 0) {
        if (isTopUp) {
          // A top-up neither deletes nor re-plans, so a complete event is an
          // answer rather than a conflict: the hourly sweep must be able to
          // pass over one without raising an error.
          if (existingConfirmedSessionCount >= topUpPlanSessions) {
            return topUpNoChange();
          }
        } else {
          const requiredForGuard =
            SlotCalculationService.calculateRequiredSlots(eventType, config);
          const futureNonTentativeSlotCount =
            existingNonTentativeSlotCount - pastConfirmedSlotCount;
          if (
            !isInProgressReallocation &&
            existingNonTentativeSlotCount >= requiredForGuard
          ) {
            throw new AllocationConflictError(
              `Event is already fully allocated with ${existingNonTentativeSlotCount} confirmed slot(s).`,
            );
          }
          // For in-progress: only block if future slots alone meet the future requirement
          if (
            isInProgressReallocation &&
            futureNonTentativeSlotCount >=
              requiredForGuard - pastConfirmedSlotCount
          ) {
            throw new AllocationConflictError(
              `Event's future slots are already fully allocated (${futureNonTentativeSlotCount} future slot(s), ${pastConfirmedSlotCount} past).`,
            );
          }
        }
      }

      // Collect appointment IDs to exclude from conflict detection and weekly limits.
      // For reschedule: exclude tentative appointments (they'll be deleted)
      // For initial/in-progress allocation: exclude ALL existing appointments (they'll be deleted or preserved)
      // #1206 top-up: exclude NOTHING. Every confirmed session survives this
      // run, so its interval must keep blocking candidates and its week and day
      // must keep counting toward the caps the validator re-checks.
      const appointmentIdsToExclude = isReschedule
        ? existingAppointments
            .filter((a) => a.slotsOfAppointment.some((s) => s.isTentative))
            .map((a) => a.id)
        : isTopUp
          ? []
          : existingAppointments.map((a) => a.id);

      // Calculate required slots
      let requiredSlots: number;
      if (isReschedule) {
        // Expected count = (tentative appointments) × slotsPerCall = the number
        // of SESSIONS being rescheduled (1 Appointment = 1 session). Equals
        // calculateRequiredSlots for a FULL reschedule — preserving the class
        // crud-with-plan case (commit 2b6be4c1, 1 full-duration tentative row per
        // session) — but correctly smaller for a PARTIAL reschedule (e.g. 2 of 10),
        // which calculateRequiredSlots (the full total) would over-allocate.
        const rescheduleSessions = existingAppointments.filter((a) =>
          a.slotsOfAppointment.some((s) => s.isTentative),
        ).length;
        requiredSlots = rescheduleSessions * slotsPerCall;
      } else {
        const fullRequired = SlotCalculationService.calculateRequiredSlots(
          eventType,
          config,
        );
        // #1206 — a top-up owes the plan's total minus every session already
        // confirmed, past ones included: a delivered session is not owed twice,
        // and a future one is preserved rather than replanned.
        if (isTopUp) {
          requiredSlots =
            (topUpPlanSessions - existingConfirmedSessionCount) * slotsPerCall;
        } else {
          // For in-progress reallocation, only allocate future slots
          requiredSlots = isInProgressReallocation
            ? fullRequired - pastConfirmedSlotCount
            : fullRequired;
        }
      }

      // #939 review — the in-progress guard above already rejects the
      // fully-confirmed case, but assert locally so requiredSlots can never
      // reach findAvailableSlots as <= 0 (which would leave selectedSlots[0]
      // undefined in updateEventStatus).
      if (requiredSlots <= 0) {
        throw new AllocationValidationError(
          "No new slots need to be allocated; all required sessions are already confirmed.",
        );
      }

      // #1065 — captured BEFORE the write txn deletes these rows. Empty for a
      // fresh allocation, which is exactly when a preference must not apply.
      const releasedSlotIds = this.releasedSlotIdsOf(existingAppointments);
      const preference = await this.findAllocationPreference(releasedSlotIds);

      // Find available slots (read-only; runs out-of-txn under the locks)
      // Pass appointmentIdsToExclude so their slots are excluded from bookedSlots
      // Pass existingAppointments so sessionsPerWeek is scoped to this event only
      let selectedSlots: Date[];
      try {
        selectedSlots = await this.findAvailableSlots(
          prisma,
          consultant,
          requiredSlots,
          slotsPerCall,
          eventType,
          config,
          appointmentIdsToExclude,
          existingAppointments,
          consulteeUserId, // #898 — pick slots free for the consultee too
          consultantProfileId,
          preference,
          eventId, // #1194 — names the event in the row-truncation warning
          // #1206 — never on a reschedule: its tentative rows ARE the sessions
          // being moved, and placing fewer would delete the remainder outright
          // instead of leaving it pending.
          allowPartial && isRecurringEventType(eventType) && !isReschedule,
        );
      } catch (error) {
        // #1206 — with `allowPartial` on, a shortage is only raised when the
        // search could place NOTHING. For the hourly top-up sweep that is the
        // ordinary answer ("still no room"), not a refusal worth reporting; a
        // top-up WITHOUT allowPartial keeps the typed SLOT_SHORTAGE so the
        // consultant's dialog can still offer to place what fits.
        if (isTopUp && allowPartial && error instanceof SlotShortageError) {
          return topUpNoChange();
        }
        throw error;
      }

      // Validate (read-only; runs out-of-txn under the locks)
      // Pass appointmentIdsToExclude so their slots don't trigger false conflicts
      const validation = await new SlotValidationService(prisma).validate(
        eventType,
        eventId,
        selectedSlots,
        consultant,
        config,
        appointmentIdsToExclude,
        { consulteeUserId }, // #676 AE-1 — also check the consultee's calendar
      );

      if (!validation.isValid) {
        throw new AllocationValidationError(
          `Validation failed: ${validation.errors.join("; ")}`,
        );
      }

      // #1206 — whole sessions, the unit the consultant and the consultee both
      // read. `findAvailableSlots` only ever emits complete sessions, so both
      // divisions are exact. A partial run leaves the request APPROVED with
      // fewer sessions than the plan; the shortfall is derived here and at
      // read time, never stored.
      //
      // A top-up reports against the PLAN rather than against this run,
      // because that is what the consultee's notice has to say: the sessions
      // already on their calendar count as scheduled, and the shortfall is
      // what is left after this run adds to them.
      const alreadyScheduledSessions = isTopUp
        ? existingConfirmedSessionCount
        : 0;
      const placedSessions =
        alreadyScheduledSessions +
        Math.floor(selectedSlots.length / slotsPerCall);
      const requestedSessions = isTopUp
        ? topUpPlanSessions
        : Math.ceil(requiredSlots / slotsPerCall);
      const partialPlacement = placedSessions < requestedSessions;

      // SHORT write-only transaction. The heavy reads above no longer hold a
      // connection, so this can start promptly; an explicit maxWait still
      // absorbs transient pool spikes (concurrency is bounded by the locks +
      // the route's eventMutationLimiter).
      return await prisma.$transaction(
        async (tx) => {
          // Defense-in-depth: re-check conflicts INSIDE the txn (envelope-scoped,
          // indexed, cheap). The reads ran out-of-txn under the locks, so for
          // allocate() flows no slot can shift; this catches a concurrent
          // non-allocate insert (e.g. checkout) and turns the common race into a
          // clean typed conflict before the #440 GiST constraint would raise.
          const recheck = await new SlotValidationService(
            tx,
          ).revalidateConflicts(
            selectedSlots,
            consultant.userId,
            appointmentIdsToExclude,
            consulteeUserId,
          );
          if (!recheck.isValid) {
            throw new AllocationConflictError(
              `Slot taken during allocation: ${recheck.errors.join("; ")}`,
            );
          }

          // AE-2 (#784) — a webinar/class co-host is not a slot participant, so
          // nothing else here can see their clash. Checked in-txn, next to the
          // conflict recheck, so the read matches the write that follows.
          await SlotAllocationService.assertCollaboratorsFree(
            tx,
            eventType,
            planId,
            selectedSlots,
            appointmentIdsToExclude,
          );

          // In-txn re-check of the multi-tab guard, serialized per event via
          // an advisory xact lock; a same-key double submit replays instead
          // of 409ing (see guardInitialAllocationInTx).
          if (isFreshAllocation) {
            const lockedReplay =
              await SlotAllocationService.guardInitialAllocationInTx(
                tx,
                eventType,
                eventId,
                idempotencyKey,
              );
            if (lockedReplay) return lockedReplay;
          }

          // #1012 — reschedule path is outside guardInitialAllocationInTx;
          // re-assert tentative count under the write txn before delete.
          await SlotAllocationService.assertExpectedTentativeSlotCountInTx(
            tx,
            eventType,
            eventId,
            expectedTentativeSlotCount,
          );

          // CRITICAL FIX: Delete existing appointments before creating new ones
          // For reschedules: only delete appointments with tentative slots (preserve confirmed ones)
          // For in-progress: only delete future slots (preserve past confirmed ones)
          // For initial allocation: delete all (shouldn't be any, but safety measure)
          // #1206 top-up: nothing is deleted at all, which is the whole point —
          // the confirmed sessions and the Payment rows hanging off them are
          // exactly what the delete-and-replan path was destroying.
          let enrolledUserIds: string[] = [];
          let deletedAppointmentIds: string[] = [];
          let reusableAppointmentId: string | undefined;
          if (isTopUp) {
            // A group event's learners live ONLY on the slot↔user M2M, and the
            // ids normally come out of the rows the delete freed. With nothing
            // freed, read them off the surviving sessions instead, or the new
            // ones would have no attendees. A subscription's consultee is
            // connected by createAppointments, so it needs no such read.
            if (eventType === "class") {
              enrolledUserIds =
                await SlotAllocationService.collectEventParticipantIds(
                  tx,
                  eventType,
                  eventId,
                );
            }
          } else {
            ({ enrolledUserIds, deletedAppointmentIds, reusableAppointmentId } =
              await this.deleteExistingAppointments(
                tx,
                eventType,
                eventId,
                isReschedule,
                isInProgressReallocation,
              ));
          }

          // Create appointments
          const appointments = await this.createAppointments(
            tx,
            eventType,
            eventId,
            selectedSlots,
            consultant.userId,
            consulteeUserId,
            config,
            organizationId,
            reusableAppointmentId, // #898 — REUSE preserved 1:1 appointment
            idempotencyKey, // #837
          );

          // Reconnect enrolled users to new slots (for group events like classes)
          if (enrolledUserIds.length > 0) {
            await this.reconnectEnrolledUsers(
              tx,
              appointments,
              enrolledUserIds,
              consultant.userId,
              organizationId,
            );
          }

          // Update event status
          await this.updateEventStatus(
            tx,
            eventType,
            eventId,
            selectedSlots[0],
            config,
          );

          // #1065 — these times ARE the answer to the preference, so close it
          // here rather than leaving it open for the expiry sweep to mislabel.
          await this.resolveConsumedPreferenceRequests(tx, releasedSlotIds);

          return {
            success: true,
            appointments,
            warnings: validation.warnings,
            deletedAppointmentIds, // AE-4
            // #1206 — the counts the toast, the consultee notice and the
            // hourly retry sweep all read.
            ...(partialPlacement
              ? {
                  partial: true,
                  placedSessions,
                  requiredSessions: requestedSessions,
                  unplacedSessions: requestedSessions - placedSessions,
                }
              : {}),
          };
        },
        {
          maxWait: ALLOCATION_TX_MAX_WAIT_MS,
          timeout: ALLOCATION_TX_TIMEOUT_MS,
        },
      );
    } finally {
      if (consulteeLock) await unlockConsulteeBooking(consulteeLock);
      await unlockAutoAllocate(lock);
    }
  }

  /**
   * MANUAL ALLOCATION: Validate and allocate user-selected slots
   *
   * IMPORTANT: This method allows consultants to manually select specific slots
   * for appointments, bypassing the auto-allocation algorithm.
   *
   * VALIDATION REQUIREMENTS:
   * 1. Slot count must be exact multiple of session duration
   *    - Example: 2.5-hour session needs 5 slots (5 × 30min)
   *    - Providing 7 slots creates incomplete appointment → rejected
   *
   * 2. All slots must pass universal validation:
   *    - In the future (not past dates)
   *    - Match consultant's availability schedule
   *    - No conflicts with existing appointments
   *
   * 3. Event-specific rules apply:
   *    - Consultations: All slots same day, consecutive
   *    - Subscriptions: Weekly limits enforced
   *    - Webinars: Consecutive slots required
   *    - Classes: Session grouping validated
   */
  private static async manualAllocate(
    eventType: EventType,
    eventId: string,
    slotStrings: string[],
    idempotencyKey?: string,
    initialAllocation?: boolean,
    wideLock?: boolean,
    expectedTentativeSlotCount?: number,
  ): Promise<AllocationResult> {
    // #837 — return the prior batch on a double-submit before doing any work.
    const replay = await this.findIdempotentAllocation(
      eventType,
      eventId,
      idempotencyKey,
    );
    if (replay) return replay;

    // Pre-fetch consultantProfileId for lock key (lightweight, outside transaction)
    const consultantProfileId = await this.getConsultantProfileId(
      eventType,
      eventId,
    );
    if (!consultantProfileId) {
      return {
        success: false,
        error: `${eventType} not found or has no consultant`,
        errorCode: "NOT_FOUND",
        httpStatus: 400,
      };
    }

    // Acquire consultant-level distributed lock before the transaction.
    // Without this, concurrent manual allocations for the same subscription/class
    // can both pass validateNoConflicts() and create duplicate appointments.
    // #860 — shard the lock by the earliest target day so allocations for
    // different days don't serialize; same-day (the actual duplicate risk)
    // still shares the key.
    //
    // #440's `slot_no_confirmed_overlap` GiST constraint backstops only what it
    // is keyed on: two confirmed slots of one consultant covering the same
    // instant. It cannot see a COUNT, so it is no backstop for a weekly cap —
    // and the sessions that race that cap sit on different days, so they never
    // overlap and the constraint stays silent.
    //
    // #1319 — the shard is therefore only safe for a cap-less placement. The
    // recurring types are exactly the ones whose validator enforces
    // sessionsPerWeek (subscription via SubscriptionValidationService, class via
    // the [WEEKLY_LIMIT] check), and a week spans days: two manual allocations
    // on different days of one week would take different keys and each clear the
    // cap on a count the other has not committed yet. They take the
    // consultant-wide key whatever wideLock says; wideLock stays the explicit
    // opt-out for callers placing times nobody picked per-day.
    const hasWeeklyCap = isRecurringEventType(eventType);
    const lockScope =
      wideLock || hasWeeklyCap
        ? undefined
        : slotStrings
            .map((s) => new Date(s))
            .filter((d) => !Number.isNaN(d.getTime()))
            .sort((a, b) => a.getTime() - b.getTime())[0]
            ?.toISOString()
            .slice(0, 10);
    const lock = await lockAutoAllocate(consultantProfileId, lockScope);
    // #898 follow-up — serialize on the consultee too (consultant → consultee
    // lock order) so one person can't be booked with two consultants at once.
    let consulteeLock: ApprovalLock | null = null;
    try {
      const consulteeLockUserId = await this.getConsulteeUserId(
        eventType,
        eventId,
      );
      if (consulteeLockUserId) {
        consulteeLock = await lockConsulteeBooking(consulteeLockUserId);
      }

      // #837 TOCTOU — the pre-lock replay check can miss a concurrent first
      // submit that stamped its key while we waited on the lock. Re-check now
      // that we hold the locks so the loser replays the winner's batch instead
      // of racing into the unique-constraint 409.
      const lockedReplay = await this.findIdempotentAllocation(
        eventType,
        eventId,
        idempotencyKey,
      );
      if (lockedReplay) return lockedReplay;

      // Multi-tab guard: a fresh dialog allocation must 409 if another
      // session already allocated this event (re-checked in-txn below).
      if (initialAllocation) {
        await this.assertNoConfirmedSlots(prisma, eventType, eventId);
      }

      // #908 — slot parsing, count checks and validation run OUTSIDE the write
      // transaction (but under the locks above), so the heavy conflict read no
      // longer pins a pooled connection while the txn waits to start.
      const eventData = await this.fetchEventData(prisma, eventType, eventId);
      if (!eventData) {
        throw new AllocationNotFoundError(`${eventType} not found`);
      }

      const { consultant, config, consulteeUserId, organizationId, planId } =
        eventData;

      // Convert to Date objects with validation
      const slots = slotStrings.map((s, i) => {
        const date = new Date(s);
        if (isNaN(date.getTime())) {
          throw new AllocationValidationError(
            `Invalid date string at position ${i + 1}: "${s}". ` +
              `Expected ISO 8601 format (e.g., "2026-03-01T09:00:00.000Z").`,
          );
        }
        return date;
      });

      // FIX: Detect and reject duplicate slots
      // Duplicates can cause validation errors, inflated counts, and DB anomalies
      const uniqueSlots = Array.from(
        new Map(slots.map((s) => [s.toISOString(), s])).values(),
      );

      if (uniqueSlots.length !== slots.length) {
        throw new AllocationValidationError(
          `Duplicate slots detected: ${slots.length} slots provided but only ` +
            `${uniqueSlots.length} are unique. Each slot can only be selected once.`,
        );
      }

      // Sort slots chronologically to ensure correct grouping into appointments
      // and correct schedulingPeriodStartsAt derivation from slots[0]
      slots.sort((a, b) => a.getTime() - b.getTime());

      // CRITICAL FIX: Validate slot count matches session duration requirements
      // This prevents incomplete appointments from being created
      const slotsPerCall = SlotCalculationService.getSlotsPerCall(
        config.sessionDurationInHours || config.durationInHours || 1,
      );

      if (slots.length % slotsPerCall !== 0) {
        const sessionDuration =
          config.sessionDurationInHours || config.durationInHours || 1;
        throw new AllocationValidationError(
          `Invalid slot count: ${slots.length} slots provided, but ${sessionDuration}-hour ` +
            `sessions require multiples of ${slotsPerCall} slots (30 minutes each). ` +
            `Valid counts: ${slotsPerCall}, ${slotsPerCall * 2}, ${slotsPerCall * 3}, etc.`,
        );
      }

      // Detect reschedule scenario: check for existing tentative slots
      const relationField = this.getEventRelationField(eventType);
      const existingAppointments: AppointmentWithSlots[] =
        await prisma.appointment.findMany({
          where: {
            [`${relationField}Id`]: eventId,
          } as Prisma.AppointmentWhereInput,
          include: { slotsOfAppointment: true },
        });

      const tentativeSlotCount = existingAppointments.reduce(
        (count, appointment) =>
          count +
          appointment.slotsOfAppointment.filter((slot) => slot.isTentative)
            .length,
        0,
      );
      // #1012 — before any delete+recreate, confirm the page's view of the
      // tentative set still matches the database.
      this.assertExpectedTentativeSlotCount(
        tentativeSlotCount,
        expectedTentativeSlotCount,
      );
      const isReschedule = tentativeSlotCount > 0;

      const existingNonTentativeSlotCount = existingAppointments.reduce(
        (count, appointment) =>
          count +
          appointment.slotsOfAppointment.filter((slot) => !slot.isTentative)
            .length,
        0,
      );

      // ADR B10, derived rather than trusted. The client set initialAllocation
      // only when tentativeSlotCount === 0, but EVERY pending request already
      // carries tentative slots (request-for-approval and unpaid checkout both
      // create them that way), so the flag was never true for a consultation
      // and the multi-tab guard never ran. Having no CONFIRMED slot is the real
      // "not allocated yet" condition. This matters most across modes: auto
      // takes a consultant-wide lock and a cap-less manual one a day-sharded
      // key (#860, narrowed by #1319), so two tabs are only serialized by the
      // in-txn advisory lock this gates.
      const isFreshAllocation =
        initialAllocation === true || existingNonTentativeSlotCount === 0;

      // Detect in-progress reallocation: past confirmed slots exist for recurring events
      const now = new Date();
      const pastConfirmedSlotCount = isReschedule
        ? 0
        : existingAppointments.reduce(
            (count, appt) =>
              count +
              appt.slotsOfAppointment.filter(
                (slot) => !slot.isTentative && new Date(slot.endsAt) <= now,
              ).length,
            0,
          );
      const isInProgressReallocation =
        !isReschedule &&
        pastConfirmedSlotCount > 0 &&
        isRecurringEventType(eventType);

      // Collect appointment IDs to exclude from conflict detection and weekly limits.
      // For reschedule: exclude tentative appointments (they'll be deleted)
      // For initial/in-progress allocation: exclude ALL existing appointments
      const appointmentIdsToExclude = isReschedule
        ? existingAppointments
            .filter((a) => a.slotsOfAppointment.some((s) => s.isTentative))
            .map((a) => a.id)
        : existingAppointments.map((a) => a.id);

      // #1065 — a hand-placed allocation answers a stated preference just as an
      // auto one does (it does not READ the preference — the consultant chose
      // the times — but it consumes the request all the same). Captured before
      // the write txn deletes these rows.
      const releasedSlotIds = this.releasedSlotIdsOf(existingAppointments);

      // Validate total slot count for recurring event types
      if (isRecurringEventType(eventType)) {
        if (isReschedule) {
          // Expected count = (tentative appointments) × slotsPerCall, i.e. the
          // number of SESSIONS actually being rescheduled (1 Appointment = 1
          // session). This equals calculateRequiredSlots for a FULL reschedule
          // (all sessions tentative) — preserving the class crud-with-plan case
          // (commit 2b6be4c1, where each session has 1 full-duration tentative
          // row) — but is correctly smaller for a PARTIAL reschedule (e.g. 2 of
          // 10). calculateRequiredSlots (the full total) wrongly rejected partials.
          const rescheduleSessions = existingAppointments.filter((a) =>
            a.slotsOfAppointment.some((s) => s.isTentative),
          ).length;
          const rescheduleRequired = rescheduleSessions * slotsPerCall;
          if (slots.length !== rescheduleRequired) {
            throw new AllocationValidationError(
              `This reschedule requires exactly ${rescheduleRequired} slots ` +
                `(replacing ${rescheduleSessions} session(s)), ` +
                `but ${slots.length} were provided.`,
            );
          }
        } else if (isInProgressReallocation) {
          // In-progress: only future slots expected, past ones are preserved
          const fullRequired = SlotCalculationService.calculateRequiredSlots(
            eventType,
            config,
          );
          const expectedFutureSlots = fullRequired - pastConfirmedSlotCount;
          if (slots.length !== expectedFutureSlots) {
            throw new AllocationValidationError(
              `In-progress ${eventType}: ${pastConfirmedSlotCount} past slot(s) preserved. ` +
                `Expected ${expectedFutureSlots} future slots, but ${slots.length} were provided.`,
            );
          }
        } else if (
          config.schedulingPeriodStartsAt &&
          config.schedulingPeriodEndsAt
        ) {
          const requiredSlots = SlotCalculationService.calculateRequiredSlots(
            eventType,
            config,
          );
          if (slots.length !== requiredSlots) {
            throw new AllocationValidationError(
              `This ${eventType} requires exactly ${requiredSlots} slots ` +
                `(based on the scheduling period and session configuration), ` +
                `but ${slots.length} were provided.`,
            );
          }
        }
      }

      // Validate (read-only; runs out-of-txn under the locks)
      // Pass appointmentIdsToExclude so their slots don't trigger false conflicts
      const validation = await new SlotValidationService(prisma).validate(
        eventType,
        eventId,
        slots,
        consultant,
        config,
        appointmentIdsToExclude,
        { consulteeUserId }, // #676 AE-1 — also check the consultee's calendar
      );

      if (!validation.isValid) {
        throw new AllocationValidationError(
          `Validation failed: ${validation.errors.join("; ")}`,
        );
      }

      // SHORT write-only transaction (see autoAllocate for the rationale).
      return await prisma.$transaction(
        async (tx) => {
          // Defense-in-depth conflict re-check inside the txn (see autoAllocate).
          const recheck = await new SlotValidationService(
            tx,
          ).revalidateConflicts(
            slots,
            consultant.userId,
            appointmentIdsToExclude,
            consulteeUserId,
          );
          if (!recheck.isValid) {
            throw new AllocationConflictError(
              `Slot taken during allocation: ${recheck.errors.join("; ")}`,
            );
          }

          // AE-2 (#784) — a webinar/class co-host is not a slot participant, so
          // nothing else here can see their clash. Checked in-txn, next to the
          // conflict recheck, so the read matches the write that follows.
          await SlotAllocationService.assertCollaboratorsFree(
            tx,
            eventType,
            planId,
            slots,
            appointmentIdsToExclude,
          );

          // In-txn re-check of the multi-tab guard, serialized per event via
          // an advisory xact lock; a same-key double submit replays instead
          // of 409ing (see guardInitialAllocationInTx).
          if (isFreshAllocation) {
            const lockedReplay =
              await SlotAllocationService.guardInitialAllocationInTx(
                tx,
                eventType,
                eventId,
                idempotencyKey,
              );
            if (lockedReplay) return lockedReplay;
          }

          // #1012 — reschedule path is outside guardInitialAllocationInTx;
          // re-assert tentative count under the write txn before delete.
          await SlotAllocationService.assertExpectedTentativeSlotCountInTx(
            tx,
            eventType,
            eventId,
            expectedTentativeSlotCount,
          );

          // Delete existing appointments
          // For reschedules: only delete tentative slots (preserve confirmed ones)
          // For in-progress: only delete future slots (preserve past confirmed ones)
          // For initial allocation: delete all
          const {
            enrolledUserIds,
            deletedAppointmentIds,
            reusableAppointmentId,
          } = await this.deleteExistingAppointments(
            tx,
            eventType,
            eventId,
            isReschedule,
            isInProgressReallocation,
          );

          // Create appointments
          const appointments = await this.createAppointments(
            tx,
            eventType,
            eventId,
            slots,
            consultant.userId,
            consulteeUserId,
            config,
            organizationId,
            reusableAppointmentId, // #898 — REUSE preserved 1:1 appointment
            idempotencyKey, // #837
          );

          // Reconnect enrolled users to new slots (for group events like classes)
          if (enrolledUserIds.length > 0) {
            await this.reconnectEnrolledUsers(
              tx,
              appointments,
              enrolledUserIds,
              consultant.userId,
              organizationId,
            );
          }

          // Update event status
          await this.updateEventStatus(
            tx,
            eventType,
            eventId,
            slots[0],
            config,
          );

          // #1065 — see autoAllocate: placing the replacement answers the ask.
          await this.resolveConsumedPreferenceRequests(tx, releasedSlotIds);

          return {
            success: true,
            appointments,
            warnings: validation.warnings,
            deletedAppointmentIds, // AE-4
          };
        },
        {
          maxWait: ALLOCATION_TX_MAX_WAIT_MS,
          timeout: ALLOCATION_TX_TIMEOUT_MS,
        },
      );
    } finally {
      if (consulteeLock) await unlockConsulteeBooking(consulteeLock);
      await unlockAutoAllocate(lock);
    }
  }

  /**
   * REQUESTED SLOTS: Use pre-selected slots from consultee
   *
   * WORKFLOW:
   * 1. Consultee submits consultation/subscription request with preferred time slots
   * 2. System creates tentative appointments with those slots
   * 3. Consultant reviews and clicks "Use Requested Slots"
   * 4. This method validates and approves those pre-created appointments
   *
   * CRITICAL VERIFICATION:
   * We must verify appointments were actually created by the consultee.
   * Without this check, a consultant could approve a request that has
   * no appointments, resulting in an APPROVED status with no bookings.
   *
   * POSSIBLE FAILURE SCENARIOS:
   * - Consultee abandoned request before creating appointments
   * - Appointments were deleted by another process
   * - Database transaction failed partially
   * - Frontend didn't submit appointments correctly
   */
  private static async useRequestedSlots(
    eventType: EventType,
    eventId: string,
    // The caller's initialAllocation hint is ignored: the guard is always armed
    // here, because approving stored times is only valid for an unallocated event.
    _initialAllocation: boolean | undefined,
    idempotencyKey?: string,
    /** Consultant accepting times outside their own published availability. */
    overrideAvailabilityWindow?: boolean,
    expectedTentativeSlotCount?: number,
  ): Promise<AllocationResult> {
    // #837 — a retry whose first response was lost must replay the approved
    // batch, not trip the initial-allocation guard with a 409.
    const replay = await this.findIdempotentAllocation(
      eventType,
      eventId,
      idempotencyKey,
    );
    if (replay) return replay;

    // This path used to enter the transaction with no Redis lock at all, so an
    // approval could run concurrently with an auto/manual allocation of the same
    // event and rely entirely on the GiST exclusion constraint to notice.
    const consultantProfileId = await this.getConsultantProfileId(
      eventType,
      eventId,
    );
    if (!consultantProfileId) {
      // Same shape the auto/manual paths report, so a missing event reads the
      // same however it was reached.
      throw new AllocationNotFoundError(`${eventType} not found`);
    }
    const lock = await lockAutoAllocate(consultantProfileId);
    if (!lock) {
      throw new AllocationConflictError(
        "Another allocation is in progress for this consultant. Please try again.",
      );
    }

    // #898 follow-up — serialize on the consultee too. The GiST overlap guard
    // is consultant-keyed, so it cannot see a cross-consultant double-booking,
    // and this path confirms the consultee's slots. Without it an approval here
    // and an auto/manual allocation for the same consultee under a DIFFERENT
    // consultant both pass their conflict validation under Read Committed and
    // both commit. Lock order matches the other two paths: consultant → consultee.
    let consulteeLock: ApprovalLock | null = null;

    try {
      const consulteeLockUserId = await this.getConsulteeUserId(
        eventType,
        eventId,
      );
      if (consulteeLockUserId) {
        consulteeLock = await lockConsulteeBooking(consulteeLockUserId);
      }

      return await prisma.$transaction(
        async (tx) => {
          // Multi-tab guard: another tab already confirmed slots for this
          // event → typed 409 instead of re-approving over it. Advisory-locked
          // in-txn so it can't race the manual/auto write transactions; a
          // same-key retry that lost the pre-txn race replays the winner.
          // Always armed here: approving stored times is only ever valid for an
          // event that has not been allocated yet.
          {
            const lockedReplay =
              await SlotAllocationService.guardInitialAllocationInTx(
                tx,
                eventType,
                eventId,
                idempotencyKey,
              );
            if (lockedReplay) return lockedReplay;
          }

          // Fetch event with requested slots
          const eventData = await this.fetchEventData(tx, eventType, eventId);
          if (!eventData) {
            throw new AllocationNotFoundError(`${eventType} not found`);
          }

          const {
            consultant,
            config,
            requestedSlots,
            consulteeUserId,
            planId,
          } = eventData;

          if (!requestedSlots || requestedSlots.length === 0) {
            throw new AllocationValidationError("No requested slots found");
          }

          // CRITICAL FIX: Verify appointments actually exist before approving
          // This prevents approving requests with no actual bookings
          const relationField = this.getEventRelationField(eventType);
          const existingAppointments: AppointmentWithSlots[] =
            await tx.appointment.findMany({
              where: {
                [`${relationField}Id`]: eventId,
              } as Prisma.AppointmentWhereInput,
              include: { slotsOfAppointment: true },
            });

          const tentativeSlotCount = existingAppointments.reduce(
            (count, appointment) =>
              count +
              appointment.slotsOfAppointment.filter((slot) => slot.isTentative)
                .length,
            0,
          );
          // #1012 — stale-tab reschedule / approval precondition.
          SlotAllocationService.assertExpectedTentativeSlotCount(
            tentativeSlotCount,
            expectedTentativeSlotCount,
          );

          if (existingAppointments.length === 0) {
            throw new AllocationValidationError(
              "Cannot approve requested slots: No appointments found. " +
                "The consultee may not have created appointments yet, or they were deleted. " +
                "Please ask the consultee to resubmit their request.",
            );
          }

          // A rescheduled slot's startsAt is still the ORIGINAL time — the
          // reschedule route only flips isTentative/completionStatus, it never
          // writes a new one. fetchEventData derives requestedSlots from those
          // same rows, so "use the requested times" here would silently re-confirm
          // exactly the times the consultee asked to move. Refuse; the consultant
          // must allocate (auto or manual) instead.
          const rescheduledSlots = existingAppointments.flatMap((appointment) =>
            appointment.slotsOfAppointment.filter(
              (slot) =>
                slot.completionStatus === SlotCompletionStatus.RESCHEDULED,
            ),
          );

          if (rescheduledSlots.length > 0) {
            throw new AllocationValidationError(
              `Cannot reuse requested times: ${rescheduledSlots.length} slot(s) are awaiting reschedule, ` +
                `so the stored times are the ones being moved away from. ` +
                `Allocate new times instead.`,
            );
          }

          // Verify the appointments COVER exactly the requested half-hour atoms.
          //
          // #1319 — this compared row count to atom count, which are the same
          // number only for an appointment already stored the canonical way
          // (#1071). 76 of 87 production consultations are a single 60-minute
          // row, so a one-hour booking offered two atoms and answered "1", and
          // approving it was impossible: the message read "Found 1 slots but 2
          // requested" and the consultant had no action that could fix it.
          //
          // Both sides are atom COVERAGE now: `fetchEventData` expands each
          // stored row into the atom starts it covers, so normalising only the
          // left side would have swapped one mismatch for its mirror image.
          const existingAtomCount = existingAppointments.reduce(
            (sum, appointment) =>
              sum +
              appointment.slotsOfAppointment.reduce(
                (atoms, slot) => atoms + countHalfHourAtoms(slot),
                0,
              ),
            0,
          );

          if (existingAtomCount !== requestedSlots.length) {
            throw new AllocationValidationError(
              `Appointment mismatch: the existing appointments cover ${existingAtomCount} ` +
                `half-hour atoms but ${requestedSlots.length} were requested. ` +
                `The appointments may have been modified. Please review and try again.`,
            );
          }

          // Validate requested slots still meet all requirements.
          // Pass existing appointment IDs so the event's own tentative slots
          // are not flagged as conflicts during self-validation.
          const validator = new SlotValidationService(tx);
          const existingAppointmentIds = existingAppointments.map((a) => a.id);
          const validation = await validator.validate(
            eventType,
            eventId,
            requestedSlots,
            consultant,
            config,
            existingAppointmentIds,
            { consulteeUserId, overrideAvailabilityWindow },
          );

          if (!validation.isValid) {
            throw new AllocationValidationError(
              `Validation failed: ${validation.errors.join("; ")}`,
            );
          }

          // AE-2 (#784) — confirming the consultee's stored times is a time
          // commit like any other, so the co-host guard applies here too. This
          // path has no createAppointments; the isTentative flip below is the
          // write it protects.
          await SlotAllocationService.assertCollaboratorsFree(
            tx,
            eventType,
            planId,
            requestedSlots,
            existingAppointmentIds,
          );

          // Update event status to approved (appointments already exist and verified)
          await this.updateEventStatus(
            tx,
            eventType,
            eventId,
            requestedSlots[0],
            config,
          );

          // CRITICAL FIX: Clear isTentative flag on all slots after approval
          // This ensures slots are no longer marked as pending reschedule
          const appointmentIds = existingAppointments.map(
            (appointment) => appointment.id,
          );
          await tx.slotOfAppointment.updateMany({
            where: {
              appointmentId: { in: appointmentIds },
            },
            data: { isTentative: false },
          });

          // #837 — stamp the batch's key on the FIRST appointment so a retry
          // replays this approval instead of re-running it (mirrors
          // createAppointments). The @unique index turns a concurrent
          // duplicate submit into a typed 409.
          if (idempotencyKey) {
            try {
              await tx.appointment.update({
                where: { id: appointmentIds[0] },
                data: { allocationIdempotencyKey: idempotencyKey },
              });
            } catch (err) {
              // Not captured here — useRequestedSlots only ever runs inside
              // allocate()'s try, whose catch reports every error reaching it
              // (including this one, same instance) with the correct modeled
              // classification. A second capture here would be a pure dupe.
              if (isUniqueViolation(err)) {
                // A same-key retry losing this race is the ordinary replay
                // case (#837).
                throw new AllocationConflictError(
                  "This allocation was already submitted; the original result applies.",
                );
              }
              throw err;
            }
          }

          return {
            success: true,
            appointments: existingAppointments,
            warnings: validation.warnings,
          };
        },
        {
          // Shared with the auto/manual paths rather than a local literal, so
          // all three allocation transactions age out the same way.
          maxWait: ALLOCATION_TX_MAX_WAIT_MS,
          timeout: ALLOCATION_TX_TIMEOUT_MS,
        },
      );
    } finally {
      if (consulteeLock) await unlockConsulteeBooking(consulteeLock);
      await unlockAutoAllocate(lock);
    }
  }

  /**
   * Check if a 30-minute candidate slot falls within the consultant's availability.
   * Replaces the pre-computed availableSlotsSet to eliminate the 8-week cap.
   *
   * FIX Issue #6: Now uses Int (minutes since midnight UTC) directly
   * instead of extracting hours/minutes from DateTime objects.
   *
   * Handles overnight (cross-midnight) availability slots where
   * endTimeUtc <= startTimeUtc (e.g., 22:00→02:00 spanning two days).
   * Mirrors the logic from SlotValidationService.validateMatchesSchedule().
   */
  private static isWithinAvailability(
    candidate: Date,
    consultant: ConsultantAllocationData,
  ): boolean {
    if (consultant.scheduleType === ScheduleType.WEEKLY) {
      const candidateDay = candidate.getUTCDay();
      const candidateMinutes =
        candidate.getUTCHours() * 60 + candidate.getUTCMinutes();

      return consultant.slotsOfAvailabilityWeekly.some((slot) =>
        isMinuteWithinWeeklySlot(
          candidateDay,
          candidateMinutes,
          30, // all atomic slots are 30 minutes
          slot.startDay,
          slot.startTimeUtc,
          slot.endTimeUtc,
          slot.utcOffsetMinutes,
        ),
      );
    } else {
      // CUSTOM schedule: candidate must fall within a specific date range
      const thirtyMinMs = 30 * 60 * 1000;
      return consultant.slotsOfAvailabilityCustom.some((slot) => {
        const slotStart = new Date(slot.startsAt);
        const slotEnd = new Date(slot.endsAt);

        return (
          candidate >= slotStart &&
          candidate.getTime() + thirtyMinMs <= slotEnd.getTime()
        );
      });
    }
  }

  /**
   * Every 30-minute start inside one availability row that could host a call.
   *
   * The search used to test only the row's own start instant: a booked 09:00
   * forfeited the entire 09:00-17:00 window and the loop advanced to the next
   * row, so auto-allocate yielded at most one placement per row per week even
   * with seven hours free. Walking the row restores the other fifteen starts.
   *
   * #1194 — the walk is bounded by the ROW'S OWN END (passed by the caller),
   * not just by isWithinAvailability (which adjacent rows keep answering true)
   * nor by the old hard MAX_CANDIDATE_STARTS_PER_ROW=48 ceiling (which
   * silently truncated legitimate long rows). Callers that cannot supply a
   * row end still get the 48-step safety net.
   */
  private static candidateStartsInRow(
    rowStart: Date,
    consultant: ConsultantAllocationData,
    /**
     * Epoch ms of this row's own end; the walk stops here (#1194). Required —
     * every live caller has the row it is walking, and the optional form was
     * how the 48-step ceiling came to silently truncate a legitimate row.
     */
    rowEndMs: number,
    walk?: AllocationWalkContext,
  ): Date[] {
    const starts: Date[] = [];
    /** Did the ROW (its end, or the edge of availability) stop the walk? */
    let boundedByRow = false;

    for (let step = 0; step < MAX_CANDIDATE_STARTS_PER_ROW; step++) {
      const candidate = new Date(rowStart.getTime() + step * SLOT_DURATION_MS);
      // Stop at the row's own end before checking availability — adjacent
      // rows would otherwise let the walk escape past its owner.
      if (candidate.getTime() + SLOT_DURATION_MS > rowEndMs) {
        boundedByRow = true;
        break;
      }
      if (!this.isWithinAvailability(candidate, consultant)) {
        boundedByRow = true;
        break;
      }
      starts.push(candidate);
    }

    // #1194 — the CEILING ended the walk, not the row: a row longer than a
    // day of cover was truncated and its tail is invisible to allocation. The
    // walk used to exit here in silence, so an unallocatable long row looked
    // like "no slots available". Probing the NEXT candidate keeps a row that
    // simply ends at the 48th start from reporting a truncation it never had.
    if (!boundedByRow) {
      const next = new Date(
        rowStart.getTime() + MAX_CANDIDATE_STARTS_PER_ROW * SLOT_DURATION_MS,
      );
      if (
        next.getTime() + SLOT_DURATION_MS <= rowEndMs &&
        this.isWithinAvailability(next, consultant)
      ) {
        this.reportRowWalkTruncated(rowStart, rowEndMs, consultant, walk);
      }
    }

    return starts;
  }

  /**
   * #1194 — one breadcrumb + one structured warning per truncated row, so a
   * SLOT_SHORTAGE that was really a scan ceiling is attributable to a
   * consultant and an event instead of being indistinguishable from a genuinely
   * full calendar.
   */
  private static reportRowWalkTruncated(
    rowStart: Date,
    rowEndMs: number,
    consultant: ConsultantAllocationData,
    walk?: AllocationWalkContext,
  ): void {
    // One report per row per allocation. A walk with no context (a direct unit
    // call) has no set and still reports, which is what its callers assert on.
    const rowKey = `${rowStart.getTime()}-${rowEndMs}`;
    if (walk?.reportedTruncations) {
      if (walk.reportedTruncations.has(rowKey)) return;
      walk.reportedTruncations.add(rowKey);
    }
    const detail = {
      rowStart: rowStart.toISOString(),
      rowEnd: new Date(rowEndMs).toISOString(),
      cap: MAX_CANDIDATE_STARTS_PER_ROW,
      consultantUserId: consultant.userId,
      consultantProfileId: walk?.consultantProfileId ?? null,
      eventType: walk?.eventType ?? null,
      eventId: walk?.eventId ?? null,
    };
    try {
      Sentry.addBreadcrumb({
        category: "scheduling",
        message: "allocation: availability row hit the candidate-start ceiling",
        level: "warning",
        data: detail,
      });
    } catch {
      // Telemetry must never fail an allocation.
    }
    console.warn(
      "[allocation] availability row truncated at MAX_CANDIDATE_STARTS_PER_ROW",
      detail,
    );
  }

  /**
   * Build one call's worth of back-to-back slots from `start`, or null if the
   * run is interrupted by a booking, the edge of availability, or the past.
   */
  private static buildConsecutiveBlock(
    start: Date,
    slotsPerCall: number,
    consultant: ConsultantAllocationData,
    bookedSlots: Set<string>,
    now: Date,
  ): Date[] | null {
    const block: Date[] = [];
    let currentTime = new Date(start);

    for (let i = 0; i < slotsPerCall; i++) {
      if (
        bookedSlots.has(currentTime.toISOString()) ||
        !this.isWithinAvailability(currentTime, consultant) ||
        currentTime < now
      ) {
        return null;
      }
      block.push(new Date(currentTime));
      currentTime = new Date(currentTime.getTime() + SLOT_DURATION_MS);
    }

    return block;
  }

  /**
   * Best-scoring placeable call inside one row on a recurring event's day, or
   * null when the row can host none.
   *
   * Candidates are held to the row's own scheduling-timezone day so that
   * walking an overnight row cannot spill a session into the next day and
   * breach the per-day cap the validator enforces (ADR B9 buckets by the
   * event's timezone, not the server's).
   *
   * #1065 — ordering by preference score, never filtering by it. Every
   * candidate that was placeable before is still placeable; only which of them
   * is returned can change. With no preference the maximum score is 0, the
   * first placeable candidate hits it, and this returns exactly what the old
   * first-fit walk returned.
   */
  private static bestFittingBlockInRow(
    rowStart: Date,
    slotsPerCall: number,
    consultant: ConsultantAllocationData,
    bookedSlots: Set<string>,
    /** The clock and the window the placement has to fall inside. */
    bounds: {
      now: Date;
      startDate: Date;
      endDate: Date;
      schedulingTimezone?: string;
    },
    /** Epoch ms of this row's own end (#1194). */
    rowEndMs: number,
    preference?: AllocationPreference,
    walk?: AllocationWalkContext,
  ): { block: Date[]; score: number } | null {
    const { now, startDate, endDate, schedulingTimezone } = bounds;
    const rowDayKey = SlotCalculationService.dayKey(
      rowStart,
      schedulingTimezone,
    );
    const maxScore = maxPreferenceScore(preference);
    let best: { block: Date[]; score: number } | null = null;

    for (const candidateStart of this.candidateStartsInRow(
      rowStart,
      consultant,
      rowEndMs,
      walk,
    )) {
      // The whole session must fit, not just its first slot: the validator
      // rejects any slot whose end passes endDate, so testing the start alone
      // would emit a block the validator then throws out.
      const candidateEnd = new Date(
        candidateStart.getTime() + slotsPerCall * SLOT_DURATION_MS,
      );

      if (
        candidateStart < now ||
        candidateStart < startDate ||
        candidateEnd > endDate ||
        SlotCalculationService.dayKey(candidateStart, schedulingTimezone) !==
          rowDayKey
      ) {
        continue;
      }

      const block = this.buildConsecutiveBlock(
        candidateStart,
        slotsPerCall,
        consultant,
        bookedSlots,
        now,
      );
      if (!block) continue;

      const score = scoreCandidateStart(
        candidateStart,
        preference,
        schedulingTimezone,
      );
      // Nothing later in the row can beat a perfect match, and an earlier one
      // is the better session anyway — so stop. This is also the no-preference
      // fast path: maxScore is 0, so the first placeable candidate ends the walk.
      if (score >= maxScore) return { block, score };
      if (!best || score > best.score) best = { block, score };
    }

    return best;
  }

  /**
   * The one block a consultation or webinar needs, or null if the search window
   * holds none.
   *
   * The walk order is unchanged — chronologically sorted rows, week by week,
   * every 30-minute start inside each row. What changed for #1065 is that a
   * placeable block is SCORED and remembered rather than returned outright, and
   * the walk stops early only once a candidate matches the preference in full.
   * With no preference the ceiling is 0, so the very first placeable block ends
   * the walk and this returns precisely what the old first-fit search did.
   *
   * The remembered best is the entire safety property: whatever the preference
   * says, if any block was placeable at all this returns one, so a preference
   * that cannot be met costs a less-liked time and never the allocation.
   */
  private static bestBlockForSingleSession(
    eventType: EventType,
    consultant: ConsultantAllocationData,
    slotsPerCall: number,
    bookedSlots: Set<string>,
    now: Date,
    sortedWeekly: ConsultantAllocationData["slotsOfAvailabilityWeekly"],
    sortedCustom: ConsultantAllocationData["slotsOfAvailabilityCustom"],
    schedulingTimezone?: string,
    preference?: AllocationPreference,
    walk?: AllocationWalkContext,
  ): Date[] | null {
    const maxWeeksToSearch = eventType === "consultation" ? 8 : 4;
    const maxScore = maxPreferenceScore(preference);

    let bestBlock: Date[] | null = null;
    let bestScore = -1;

    /** Row {start, endMs} pairs, in the order the search has always used them. */
    const rowStarts: { start: Date; endMs: number }[] = [];
    if (consultant.scheduleType === ScheduleType.WEEKLY) {
      for (let week = 0; week < maxWeeksToSearch; week++) {
        for (const slot of sortedWeekly) {
          const start = this.getNextOccurrenceWeekly(
            slot.startDay,
            slot.startTimeUtc,
            slot.utcOffsetMinutes,
          );
          if (week > 0) start.setUTCDate(start.getUTCDate() + week * 7);
          // #1342 — the same duration rule the validator applies, in one place.
          const durationMin = weeklyRowDurationMinutes(slot);
          rowStarts.push({
            start,
            endMs: start.getTime() + durationMin * 60_000,
          });
        }
      }
    } else {
      for (const slot of sortedCustom) {
        rowStarts.push({
          start: new Date(slot.startsAt),
          endMs: new Date(slot.endsAt).getTime(),
        });
      }
    }

    for (const { start: rowStart, endMs: rowEndMs } of rowStarts) {
      for (const candidateStart of this.candidateStartsInRow(
        rowStart,
        consultant,
        rowEndMs,
        walk,
      )) {
        if (candidateStart < now) continue;

        const consecutiveBlock = this.buildConsecutiveBlock(
          candidateStart,
          slotsPerCall,
          consultant,
          bookedSlots,
          now,
        );
        if (!consecutiveBlock) continue;

        const score = scoreCandidateStart(
          candidateStart,
          preference,
          schedulingTimezone,
        );
        // A full match cannot be beaten, and the earliest full match is the
        // better session — so stop here rather than scanning the whole window.
        if (score >= maxScore) return consecutiveBlock;
        if (score > bestScore) {
          bestScore = score;
          bestBlock = consecutiveBlock;
        }
      }
    }

    return bestBlock;
  }

  /**
   * Find available consecutive slots for auto-allocation.
   *
   * #1065 — `preference` orders the candidates that are already valid. Every
   * hard constraint (availability, both parties' bookings, per-day and per-week
   * caps, the scheduling period) is evaluated exactly as before and no
   * preference can relax or tighten one. An unsatisfiable preference therefore
   * changes nothing except which of the equally-legal placements is chosen.
   */
  private static async findAvailableSlots(
    // #908 — accepts the base client so slot discovery can run OUTSIDE the write
    // transaction (under the locks). Reads only — no writes happen here.
    db: PrismaLike,
    consultant: ConsultantAllocationData,
    totalSlotsNeeded: number,
    slotsPerCall: number,
    eventType: EventType,
    config: EventConfig,
    excludeAppointmentIds: string[] = [],
    eventOwnAppointments: AppointmentWithSlots[] = [],
    // #898 follow-up — when set, the CONSULTEE's existing bookings (across ANY
    // consultant) are also treated as occupied, so auto-allocate picks
    // mutually-free slots instead of consultant-free ones that then fail the
    // consultee-conflict validation.
    consulteeUserId?: string,
    // Lets the occupancy predicate include appointments delivered under this
    // consultant's own plans, matching what the availability grid counts.
    consultantProfileId?: string,
    // #1065 — how the consultee would like the replacement placed. Scores
    // candidates; absent (or all-null) leaves selection exactly as it was.
    preference?: AllocationPreference,
    // #1194 — identifies the walk in the truncation warning below.
    eventId?: string,
    // #1206 — return what fits instead of throwing SLOT_SHORTAGE. Only the
    // consultant, having been shown the shortfall, can turn this on.
    allowPartial = false,
  ): Promise<Date[]> {
    const walk: AllocationWalkContext = {
      eventType,
      eventId,
      consultantProfileId,
      reportedTruncations: new Set(),
    };
    // Only FUTURE occupancy can collide with a candidate: buildConsecutiveBlock
    // rejects any candidate start before `now`, so a slot that has already
    // ended can never block a placement. Bounding the read to live intervals
    // keeps this query O(upcoming bookings) instead of O(entire consultant
    // history) — the pool-starvation shape documented in
    // docs/performance/allocation-500-investigation.md.
    const occupancyClock = new Date();

    // Get all existing booked slots for this consultant
    // FIX Bug #15: Use centralized occupancy policy for consistent conflict detection
    // Shared with the availability grid so the two cannot disagree about who
    // is busy — see buildConsultantOccupancyWhere.
    const appointmentFilter: Prisma.AppointmentWhereInput[] = [
      buildConsultantOccupancyWhere(consultantProfileId, consultant.userId),
      // Bounded read — see occupancyClock above. deletedAt: null keeps a
      // tombstoned slot from blocking (defense-in-depth; RESCHEDULED rows
      // stay occupied — a pending reschedule is a live hold).
      {
        slotsOfAppointment: {
          some: { endsAt: { gt: occupancyClock }, deletedAt: null },
        },
      },
    ];

    // Exclude tentative appointments during reschedule — they'll be deleted,
    // so their slots should not block availability or count toward weekly limits.
    if (excludeAppointmentIds.length > 0) {
      appointmentFilter.push({
        NOT: { id: { in: excludeAppointmentIds } },
      });
    }

    const existingAppointments = await db.appointment.findMany({
      where: {
        AND: appointmentFilter,
      },
      include: {
        // Tombstoned children of a qualifying appointment must not enter
        // bookedSlots — the parent-level filter above only qualifies the
        // appointment, not every row this include returns.
        // endsAt bound keeps bookedSlots O(upcoming): past children can never
        // match a candidate (buildConsecutiveBlock rejects < now), so
        // materializing them only re-creates pool pressure on long-lived
        // appointments (CodeRabbit triage).
        slotsOfAppointment: {
          where: { deletedAt: null, endsAt: { gt: occupancyClock } },
        },
        // RV-2 — status + payment let isOccupiedByLiveAppointment drop expired
        // APPROVED_PENDING_PAYMENT holds, matching what the validator skips.
        consultation: { select: { status: true, bookingSource: true } },
        subscription: { select: { status: true, bookingSource: true } },
        payment: { select: { expiresAt: true, paymentStatus: true } },
      },
    });

    // RV-2 — an expired pending-payment hold is not a live blocker, so its slots
    // must not enter bookedSlots; otherwise the allocator avoids a slot the
    // validator would happily accept and the two disagree.
    const bookedSlots = new Set(
      existingAppointments
        .filter((appointment) =>
          isOccupiedByLiveAppointment(appointment, occupancyClock),
        )
        .flatMap((appointment) =>
          appointment.slotsOfAppointment.map((slot) =>
            new Date(slot.startsAt).toISOString(),
          ),
        ),
    );

    // #898 follow-up — also fold the CONSULTEE's existing bookings into
    // bookedSlots so auto-allocate avoids slots where the consultee is already
    // busy with ANOTHER consultant. Without this, selection picks
    // consultant-free slots that then fail validateNoConflicts' consultee check
    // (a graceful 400, but no placement and no retry). Mirrors the consultant
    // query above, scoped to the consultee on the slot↔user M2M — bounded to
    // live intervals for the same reason.
    if (consulteeUserId) {
      const consulteeAppointments = await db.appointment.findMany({
        where: {
          AND: [
            { OR: buildOccupiedAppointmentFilter() },
            {
              slotsOfAppointment: {
                some: {
                  user: { some: { id: consulteeUserId } },
                  endsAt: { gt: occupancyClock },
                  deletedAt: null,
                },
              },
            },
            ...(excludeAppointmentIds.length > 0
              ? [{ NOT: { id: { in: excludeAppointmentIds } } }]
              : []),
          ],
        },
        include: {
          // Same tombstone exclusion as the consultant query above.
          // endsAt bound keeps bookedSlots O(upcoming): past children can never
          // match a candidate (buildConsecutiveBlock rejects < now), so
          // materializing them only re-creates pool pressure on long-lived
          // appointments (CodeRabbit triage).
          slotsOfAppointment: {
            where: { deletedAt: null, endsAt: { gt: occupancyClock } },
          },
          consultation: { select: { status: true, bookingSource: true } },
          subscription: { select: { status: true, bookingSource: true } },
          payment: { select: { expiresAt: true, paymentStatus: true } },
        },
      });
      consulteeAppointments
        .filter((appointment) =>
          isOccupiedByLiveAppointment(appointment, occupancyClock),
        )
        .flatMap((appointment) =>
          appointment.slotsOfAppointment.map((slot) =>
            new Date(slot.startsAt).toISOString(),
          ),
        )
        .forEach((iso) => bookedSlots.add(iso));
    }

    // Validate availability exists
    const hasWeeklySlots = consultant.slotsOfAvailabilityWeekly.length > 0;
    const hasCustomSlots = consultant.slotsOfAvailabilityCustom.length > 0;
    if (
      (consultant.scheduleType === ScheduleType.WEEKLY && !hasWeeklySlots) ||
      (consultant.scheduleType === ScheduleType.CUSTOM && !hasCustomSlots)
    ) {
      throw new AllocationValidationError(
        "No availability slots configured for consultant",
        "NO_AVAILABILITY",
      );
    }

    const now = occupancyClock;
    const selectedSlots: Date[] = [];

    // Sort weekly slots by next calendar occurrence (not raw clock time)
    // so auto-allocation picks the chronologically earliest slot first.
    // Without this, Tue 08:00 (480min) would sort before Mon 09:00 (540min).
    const sortedWeekly =
      consultant.scheduleType === ScheduleType.WEEKLY
        ? [...consultant.slotsOfAvailabilityWeekly]
            .map((slot) => ({
              slot,
              nextOccurrence: this.getNextOccurrenceWeekly(
                slot.startDay,
                slot.startTimeUtc,
                slot.utcOffsetMinutes,
              ),
            }))
            .sort(
              (a, b) => a.nextOccurrence.getTime() - b.nextOccurrence.getTime(),
            )
            .map((w) => w.slot)
        : [];
    const sortedCustom =
      consultant.scheduleType === ScheduleType.CUSTOM
        ? [...consultant.slotsOfAvailabilityCustom].sort(
            (a, b) =>
              new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
          )
        : [];

    // #1065 — the preference's ceiling. Zero when nothing was asked for, which
    // makes every "is this candidate perfect?" test below true on the first
    // placeable candidate and preserves first-fit verbatim.
    const maxScore = maxPreferenceScore(preference);

    // For consultations/webinars: find one consecutive block, searching multiple weeks
    if (eventType === "consultation" || eventType === "webinar") {
      const singleSession = this.bestBlockForSingleSession(
        eventType,
        consultant,
        slotsPerCall,
        bookedSlots,
        now,
        sortedWeekly,
        sortedCustom,
        config.schedulingTimezone,
        preference,
        walk,
      );
      if (singleSession) return singleSession;

      // One session, so nothing is placeable short of the whole thing —
      // placeableSessions 0 tells the client not to offer a partial schedule.
      throw new SlotShortageError(
        `No ${slotsPerCall} consecutive slots available for ${eventType}`,
        0,
        1,
      );
    }

    // For subscriptions/classes: find distributed slots across weeks
    const startDate = config.schedulingPeriodStartsAt || new Date();
    const endDate =
      config.schedulingPeriodEndsAt ||
      addMonths(startDate, config.durationInMonths || 1);
    const sessionsPerWeek = config.sessionsPerWeek || 1;

    // Build a map of existing confirmed calls per week.
    // During partial reschedule, weeks with confirmed appointments already
    // have calls that must count toward the weekly limit.
    // IMPORTANT: Only count THIS event's own appointments (not consultations or
    // other event types), and exclude the tentative ones being replaced.
    const excludeSet = new Set(excludeAppointmentIds);
    const existingSessionsPerWeek = new Map<string, number>();
    // Sessions per day already spoken for by surviving appointments — the
    // seed of the per-day cap counter. Seeded for the same reason as the week
    // map: validatePerDaySessionCap counts existing appointments, so a
    // partial reschedule that only looked at this run's placements could put
    // a replacement on a day that is already at its cap and be rejected
    // downstream.
    const existingSessionsPerDay = new Map<string, number>();
    for (const apt of eventOwnAppointments) {
      if (excludeSet.has(apt.id)) continue; // skip tentative (being replaced)
      if (apt.slotsOfAppointment.length === 0) continue;
      const firstSlot = apt.slotsOfAppointment.reduce((earliest, s) =>
        new Date(s.startsAt) < new Date(earliest.startsAt) ? s : earliest,
      );
      // ADR B9 — weekly buckets in the event's scheduling timezone
      const weekKey = SlotCalculationService.weekKey(
        new Date(firstSlot.startsAt),
        config.schedulingTimezone,
      );
      existingSessionsPerWeek.set(
        weekKey,
        (existingSessionsPerWeek.get(weekKey) || 0) + 1,
      );
      const dayKey = SlotCalculationService.dayKey(
        new Date(firstSlot.startsAt),
        config.schedulingTimezone,
      );
      existingSessionsPerDay.set(
        dayKey,
        (existingSessionsPerDay.get(dayKey) || 0) + 1,
      );
    }

    // The cursor advances in UTC days because matchWeeklySlotToDay resolves the
    // row's UTC day-of-week from targetDay.getUTCDay(). Anchoring the cursor to
    // a timezone week instead made those two disagree: Sunday 00:00 IST is
    // Saturday 18:30 UTC, so getUTCDay() answered SATURDAY and every placement
    // was credited to the week before the one being iterated — the allocator
    // then emitted output its own validate() rejected with [WEEKLY_LIMIT].
    //
    // Caps are counted in the event's scheduling timezone (ADR B9), keyed off
    // the placed slot rather than the cursor, so the two bucketings cannot drift.
    const sessionsPlacedPerWeek = new Map(existingSessionsPerWeek);
    // Per-day cap counter, seeded from the surviving sessions. The cap is the
    // SAME constant validatePerDaySessionCap enforces (sessionCaps.ts) — it
    // used to be a hard one-session-per-day set, which made auto-allocate
    // unable to fill a class whose sessionsPerWeek exceeds its available
    // days per week even though the validator (and manual allocation) allow
    // two sessions on one day.
    const placedPerDay = new Map(existingSessionsPerDay);
    const maxPerDay =
      eventType === "class"
        ? MAX_CLASS_SESSIONS_PER_DAY
        : MAX_SUBSCRIPTION_SESSIONS_PER_DAY;

    /**
     * Availability rows that touch this UTC day, as {start, endMs} pairs.
     * #1194 — the end lets candidateStartsInRow bound its walk to the row's
     * own time range instead of a blind 48-step cap that adjacent rows can
     * trick into walking past.
     */
    const rowStartsForDay = (
      currentDay: Date,
    ): { start: Date; endMs: number }[] =>
      consultant.scheduleType === ScheduleType.WEEKLY
        ? sortedWeekly
            .map((slot) => {
              const start = this.matchWeeklySlotToDay(
                slot.startDay,
                slot.startTimeUtc,
                currentDay,
                slot.utcOffsetMinutes,
              );
              if (!start) return null;
              // #1342 — shared duration rule (see bestBlockForSingleSession).
              const durationMin = weeklyRowDurationMinutes(slot);
              return {
                start,
                endMs: start.getTime() + durationMin * 60_000,
              };
            })
            .filter((r): r is { start: Date; endMs: number } => r !== null)
        : sortedCustom
            .map((slot) => {
              const start = this.matchCustomSlotToDay(
                slot.startsAt,
                currentDay,
              );
              if (!start) return null;
              return { start, endMs: new Date(slot.endsAt).getTime() };
            })
            .filter((r): r is { start: Date; endMs: number } => r !== null);

    /**
     * Place at most `maxPerDay` calls on this day, honouring the
     * timezone-bucketed per-day and per-week caps the validator will
     * re-check.
     *
     * `perfectOnly` is the day-preference half of #1065. A day of the week is a
     * property of the whole day, so unlike the time band it cannot be chosen
     * between candidates inside one row — the sweep has to be run twice
     * instead. The first pass accepts only fully-preferred placements; the
     * second accepts anything and is byte-for-byte the sweep that shipped
     * before. Passing over a day in the first sweep never loses it, because the
     * second sweep walks the same window with the same cap counters.
     */
    const tryPlaceOnDay = (currentDay: Date, perfectOnly: boolean): boolean => {
      let best: { block: Date[]; score: number } | null = null;

      for (const { start: rowStart, endMs: rowEndMs } of rowStartsForDay(
        currentDay,
      )) {
        const rowDayKey = SlotCalculationService.dayKey(
          rowStart,
          config.schedulingTimezone,
        );
        const rowWeekKey = SlotCalculationService.weekKey(
          rowStart,
          config.schedulingTimezone,
        );

        if ((placedPerDay.get(rowDayKey) ?? 0) >= maxPerDay) continue;
        if ((sessionsPlacedPerWeek.get(rowWeekKey) ?? 0) >= sessionsPerWeek)
          continue;

        // Day-of-week is a property of the whole row, so a preferred-only sweep
        // can rule the row out here instead of walking its availability,
        // building blocks and then discarding them below. On a year-long class
        // with a weekend preference that is ~260 days of wasted block-building
        // per sweep. Safe because bestFittingBlockInRow holds every candidate
        // to the row's own timezone day, so they all share this weekday.
        if (
          perfectOnly &&
          !matchesPreferredDays(rowStart, preference, config.schedulingTimezone)
        ) {
          continue;
        }

        const candidate = this.bestFittingBlockInRow(
          rowStart,
          slotsPerCall,
          consultant,
          bookedSlots,
          {
            now,
            startDate,
            endDate,
            schedulingTimezone: config.schedulingTimezone,
          },
          rowEndMs,
          preference,
          walk,
        );
        if (!candidate) continue;
        // LOAD-BEARING: discarding a placeable block here is only safe because
        // sweepPeriod(false) below is UNCONDITIONAL. Any early return inserted
        // between the two sweeps turns this line into a filter and
        // reintroduces #1065 — the preference would start costing allocations.
        if (perfectOnly && candidate.score < maxScore) continue;

        // A full match ends the row walk for the same reason it ends the
        // candidate walk — and with no preference maxScore is 0, so the first
        // row that yields anything wins, exactly as before.
        if (candidate.score >= maxScore) {
          best = candidate;
          break;
        }
        if (!best || candidate.score > best.score) best = candidate;
      }

      if (!best) return false;

      const sessionSlots = best.block;
      selectedSlots.push(...sessionSlots);
      sessionSlots.forEach((s) => bookedSlots.add(s.toISOString()));

      // Re-key on the slot actually placed rather than on the row it came
      // from, so the counters record where the session really landed.
      const placedDayKey = SlotCalculationService.dayKey(
        sessionSlots[0],
        config.schedulingTimezone,
      );
      const placedWeekKey = SlotCalculationService.weekKey(
        sessionSlots[0],
        config.schedulingTimezone,
      );
      placedPerDay.set(placedDayKey, (placedPerDay.get(placedDayKey) ?? 0) + 1);
      sessionsPlacedPerWeek.set(
        placedWeekKey,
        (sessionsPlacedPerWeek.get(placedWeekKey) ?? 0) + 1,
      );

      return true;
    };

    /**
     * One walk of the scheduling period, day by day, until the need is met.
     *
     * Each day hosts as many sessions as its per-day cap (sessionCaps.ts)
     * allows, not just one: a class whose sessionsPerWeek exceeds the
     * consultant's available days per week can only be satisfied by stacking
     * sessions on a day, which is exactly what validatePerDaySessionCap
     * permits (≤2/day) and what the old one-placement-per-day cursor
     * made impossible. The while loop terminates because every successful
     * placement strictly advances a bounded counter (per-day cap, weekly cap,
     * totalSlotsNeeded).
     */
    const sweepPeriod = (perfectOnly: boolean): void => {
      const cursor = new Date(
        Date.UTC(
          startDate.getUTCFullYear(),
          startDate.getUTCMonth(),
          startDate.getUTCDate(),
        ),
      );

      for (
        ;
        cursor <= endDate && selectedSlots.length < totalSlotsNeeded;
        cursor.setUTCDate(cursor.getUTCDate() + 1)
      ) {
        while (
          selectedSlots.length < totalSlotsNeeded &&
          tryPlaceOnDay(new Date(cursor), perfectOnly)
        ) {
          // Placed; re-attempt the same day under the updated counters.
        }
      }
    };

    // Skipped entirely when nothing was asked for, so the single sweep below is
    // the only one that runs and today's placements are reproduced exactly.
    if (maxScore > 0) sweepPeriod(true);
    // MUST stay unconditional and MUST stay over the whole window. This is the
    // only thing making the preferred-only sweep above a preference rather than
    // a filter: everything it declined is reconsidered here.
    sweepPeriod(false);

    if (selectedSlots.length < totalSlotsNeeded) {
      // PR 2c resilience (audit gap #6) — a consultant staring at "Could only
      // find 0 of 12" deserves to know WHY: the scheduling period is over
      // (add availability or extend the period), vs everything is booked
      // (wait for cancellations), vs caps are unsatisfiable. The period check
      // runs first because it's the most actionable answer.
      if (
        config.schedulingPeriodEndsAt &&
        config.schedulingPeriodEndsAt < now
      ) {
        throw new AllocationValidationError(
          `The scheduling period ended on ${config.schedulingPeriodEndsAt.toLocaleDateString()}. ` +
            `Found ${selectedSlots.length} of ${totalSlotsNeeded} required slots. ` +
            `Extend the period on the plan to allocate more sessions.`,
          "PERIOD_ENDED",
        );
      }
      // #1206 — whole SESSIONS, which is the unit the consultant reasons in
      // and the only unit a partial schedule can be measured in. The sweep
      // only ever places complete sessions, so this division is exact.
      const placeableSessions = Math.floor(selectedSlots.length / slotsPerCall);
      const requiredSessions = Math.ceil(totalSlotsNeeded / slotsPerCall);

      // The consultant said "place what fits and follow up with the rest".
      // A paid subscription whose window cannot hold every session used to be
      // simply unallocatable — nothing was scheduled at all.
      if (allowPartial && placeableSessions > 0) {
        return selectedSlots
          .slice(0, placeableSessions * slotsPerCall)
          .sort((a, b) => a.getTime() - b.getTime());
      }

      throw new SlotShortageError(
        `Could only find ${selectedSlots.length} of ${totalSlotsNeeded} required slots`,
        placeableSessions,
        requiredSessions,
      );
    }

    return selectedSlots.sort((a, b) => a.getTime() - b.getTime());
  }

  /**
   * Get next occurrence of a weekly slot starting from now.
   * Uses Int (startTimeUtc) and DayOfWeek enum string directly.
   *
   * FIX Issue #6: No longer parses DateTime objects for time extraction.
   * FIX BUG-2: Applies UTC day adjustment using utcOffsetMinutes so that
   * a slot on "MONDAY" in local time is correctly resolved to the UTC day
   * (e.g., IST Monday 01:00 = UTC Sunday 19:30).
   */
  private static getNextOccurrenceWeekly(
    startDay: string,
    startTimeUtc: number,
    utcOffsetMinutes: number = 0,
  ): Date {
    const now = new Date();
    // #1342 — one shared derivation for the row's UTC weekday.
    const targetDay = utcStartDayIndex({
      startDay: startDay as DayOfWeek,
      startTimeUtc,
      utcOffsetMinutes,
    });
    if (targetDay === -1) {
      throw new Error(`Invalid day of week: ${startDay}`);
    }

    const targetHours = Math.floor(startTimeUtc / 60);
    const targetMinutes = startTimeUtc % 60;
    const currentDay = now.getUTCDay();

    // Calculate days until next occurrence
    let daysToAdd = targetDay - currentDay;
    if (daysToAdd < 0) {
      daysToAdd += 7; // Next week
    } else if (daysToAdd === 0) {
      // Same day - check if time has passed
      const nowHours = now.getUTCHours();
      const nowMinutes = now.getUTCMinutes();
      if (
        nowHours > targetHours ||
        (nowHours === targetHours && nowMinutes >= targetMinutes)
      ) {
        daysToAdd = 7; // Next week
      }
    }

    const nextOccurrence = new Date(now);
    nextOccurrence.setUTCDate(now.getUTCDate() + daysToAdd);
    nextOccurrence.setUTCHours(targetHours, targetMinutes, 0, 0);

    return nextOccurrence;
  }

  /**
   * Match a weekly slot pattern to a specific target day.
   * Uses Int startTimeUtc and DayOfWeek string directly.
   *
   * FIX BUG-2: Applies UTC day adjustment so that a local-day slot
   * is matched against the correct UTC day-of-week.
   */
  private static matchWeeklySlotToDay(
    startDay: string,
    startTimeUtc: number,
    targetDay: Date,
    utcOffsetMinutes: number = 0,
  ): Date | null {
    // #1342 — one shared derivation for the row's UTC weekday.
    const slotDayOfWeek = utcStartDayIndex({
      startDay: startDay as DayOfWeek,
      startTimeUtc,
      utcOffsetMinutes,
    });
    if (slotDayOfWeek === -1) return null;

    const targetDayOfWeek = targetDay.getUTCDay();

    if (slotDayOfWeek === targetDayOfWeek) {
      const result = new Date(targetDay);
      result.setUTCHours(
        Math.floor(startTimeUtc / 60),
        startTimeUtc % 60,
        0,
        0,
      );
      return result;
    }

    return null;
  }

  /**
   * Match a custom slot to a specific target day.
   */
  private static matchCustomSlotToDay(
    slotTime: Date,
    targetDay: Date,
  ): Date | null {
    const slotDate = new Date(slotTime);
    // Use ISO date string for reliable comparison (always YYYY-MM-DD format).
    // Previous code used getUTCMonth() (0-indexed) without padding, which was fragile.
    const slotDateStr = slotDate.toISOString().split("T")[0];
    const targetDateStr = targetDay.toISOString().split("T")[0];

    if (slotDateStr === targetDateStr) {
      return new Date(slotTime);
    }
    return null;
  }

  /**
   * Create appointment records for allocated slots
   *
   * ARCHITECTURE:
   * - One Appointment = One call/session
   * - Each Appointment contains multiple SlotOfAppointment records
   * - Number of slots per appointment = session duration / 30 minutes
   *
   * EXAMPLE: 2.5-hour subscription call
   * - Creates 1 Appointment record
   * - With 5 SlotOfAppointment records (2.5h ÷ 0.5h = 5 slots)
   * - Each slot: [startTime, startTime + 30min]
   *
   * DEFENSIVE VALIDATION:
   * This is a defensive check - slot count should already be validated
   * by the caller, but we verify again to prevent data corruption.
   */
  private static async createAppointments(
    tx: Tx,
    eventType: EventType,
    eventId: string,
    slots: Date[],
    consultantUserId: string,
    consulteeUserId?: string,
    config?: EventConfig,
    // #768 Comment 5 — slots created here inherit the org context
    // resolved by fetchEventData. SUBSCRIPTION pulls from the placeholder
    // Appointment's Payment.organizationId; CLASS pulls from
    // classPlan.organizationId (host wins per #768 design decision);
    // CONSULTATION/WEBINAR re-read the existing Appointment's tag.
    organizationId?: string | null,
    // #898 — when set (a 1:1 consultation/webinar whose payment-bearing
    // appointment was preserved by the delete guard), REUSE that appointment
    // instead of creating a second row on the @unique event FK (P2002). Only
    // ever set for single-call event types.
    reuseAppointmentId?: string,
    // #837 — stamp this batch's dedupe key on the FIRST appointment only, so a
    // replay trips the @unique (P2002 → typed 409 below) if it slips past the
    // pre-check. Nullable by design: only real keys dedupe.
    idempotencyKey?: string,
  ): Promise<any[]> {
    const slotsPerCall = SlotCalculationService.getSlotsPerCall(
      config?.sessionDurationInHours || config?.durationInHours || 1,
    );

    // DEFENSIVE CHECK: Ensure slots divide evenly into complete appointments
    // This should never fail if validation was done correctly, but prevents
    // database corruption if validation was bypassed
    if (slots.length % slotsPerCall !== 0) {
      throw new Error(
        `INTERNAL ERROR: Cannot create appointments - ${slots.length} slots ` +
          `cannot be evenly divided into ${slotsPerCall}-slot sessions. ` +
          `This indicates a validation bug.`,
      );
    }

    // Group slots by call (consecutive blocks)
    const calls: Date[][] = [];
    for (let i = 0; i < slots.length; i += slotsPerCall) {
      calls.push(slots.slice(i, i + slotsPerCall));
    }

    // CRITICAL: For consultations/webinars, ensure only ONE appointment is created
    if (
      (eventType === "consultation" || eventType === "webinar") &&
      calls.length > 1
    ) {
      throw new Error(
        `INTERNAL ERROR: ${eventType} should create exactly 1 appointment, but ${calls.length} were grouped. ` +
          `This indicates non-consecutive slots were provided. Slots: ${slots.map((s) => s.toISOString()).join(", ")}`,
      );
    }

    // #440 — denormalize the consultant onto each slot for the DB-level
    // overlap guard. The column is nullable for LEGACY rows only — an active
    // allocation without a resolvable profile would silently disable the
    // guard, so it throws instead (review catch on #843).
    const consultantProfileRow = await tx.consultantProfile.findFirst({
      where: { user: { id: consultantUserId } },
      select: { id: true },
    });
    if (!consultantProfileRow) {
      throw new Error(
        `Consultant profile not found for user ${consultantUserId} — refusing to create slots without the #440 overlap-guard column`,
      );
    }

    // Create appointment for each call. A concurrent booking that overlaps an
    // existing confirmed slot trips the #440 exclusion constraint (or the unique
    // guard); convert it to a typed 409 here at the source so classifyError can
    // stay typed-only rather than sniffing Postgres error strings (#837).
    // #873 — kept as any[]: tx.appointment.create's include-payload type does
    // not narrow to AppointmentWithSlots through Promise.all+map here (tsc rejects).
    let appointments: any[];
    try {
      appointments = await Promise.all(
        calls.map((sessionSlots, callIndex) => {
          // #837 — key belongs on the first appointment of the batch only.
          const idempotencyData =
            idempotencyKey && callIndex === 0
              ? { allocationIdempotencyKey: idempotencyKey }
              : {};
          const slotsToCreate = sessionSlots.map((slotStart) => {
            const endTime = new Date(slotStart.getTime() + 30 * 60 * 1000);
            return {
              startsAt: slotStart,
              endsAt: endTime,
              isTentative: false,
              consultantProfileId: consultantProfileRow.id,
              user: {
                connect: consulteeUserId
                  ? [{ id: consultantUserId }, { id: consulteeUserId }]
                  : [{ id: consultantUserId }],
              },
            };
          });

          // #898 — REUSE the preserved 1:1 appointment: attach the new slots to
          // it rather than creating a second row on the @unique event FK. Its
          // event link and booking-time cancellationPolicySnapshot are already
          // set, so leave them untouched.
          if (reuseAppointmentId) {
            return tx.appointment.update({
              where: { id: reuseAppointmentId },
              data: {
                ...idempotencyData,
                slotsOfAppointment: {
                  create: slotsToCreate,
                },
              },
              include: {
                slotsOfAppointment: true,
              },
            });
          }

          return tx.appointment.create({
            data: {
              appointmentType: this.getAppointmentType(eventType),
              [this.getEventRelationField(eventType)]: {
                connect: { id: eventId },
              },
              ...idempotencyData,
              ...(organizationId ? { organizationId } : {}),
              // B1 — freeze the refund terms at booking (see cancellation-policy.ts).
              cancellationPolicySnapshot: JSON.parse(
                JSON.stringify(resolveCancellationPolicySnapshot()),
              ),
              slotsOfAppointment: {
                create: slotsToCreate,
              },
            },
            include: {
              slotsOfAppointment: true,
            },
          });
        }),
      );
      // #1319 A9 — allocation writes confirmed slots, so the participants are
      // CONFIRMED from the start; a reused 1:1 appointment already has its
      // rows (createMany skips duplicates).
      for (const appt of appointments) {
        await recordParticipants(
          tx,
          appt.id,
          consulteeUserId
            ? [
                { userId: consultantUserId, role: "CONSULTANT" },
                { userId: consulteeUserId, role: "CONSULTEE" },
              ]
            : [{ userId: consultantUserId, role: "CONSULTANT" }],
          { organizationId: organizationId ?? null, status: "CONFIRMED" },
        );
      }
    } catch (error) {
      // Not captured here — createAppointments only runs inside
      // autoAllocate/manualAllocate, both under allocate()'s try, whose catch
      // reports every error reaching it (this one included). A second
      // capture here would be a pure dupe of the same instance.
      if (isExclusionViolation(error) || isUniqueViolation(error)) {
        // A concurrent booking winning the #440 overlap guard is the ordinary
        // "someone else got there first" race, not a fault.
        throw new AllocationConflictError(
          "This time slot was just booked by someone else. Please pick another time.",
        );
      }
      throw error;
    }

    // Issue #710: per-allocation cap debit for SUBSCRIPTION.
    //
    // CONSULTATION/WEBINAR debit at checkout (1 engagement, slots known
    // synchronously). CLASS debits at enrolment (N engagements, all
    // appointments pre-allocated by the consultant). SUBSCRIPTION is the
    // only event type with truly lazy slot allocation — the consultant
    // adds calls one-at-a-time via the Requests tab — so the cap debit
    // must happen here, once per Appointment row created.
    //
    // The original Payment carries the org tag; we re-resolve the
    // ProgramAssignment fresh because cycles may have rolled since
    // signup and we want today's cap, not signup-time's cap. If the
    // booking wasn't org-sponsored (no organizationId on the original
    // Payment) we skip silently.
    if (
      eventType === "subscription" &&
      consulteeUserId &&
      appointments.length > 0
    ) {
      await this.recordSubscriptionAllocationCap(
        tx,
        eventId,
        consulteeUserId,
        appointments.map((a) => a.id),
      );
    }

    return appointments;
  }

  /**
   * For SUBSCRIPTION: debit `engagementsConsumed` per Appointment created
   * in this allocation batch against the consultee's active org program
   * assignment. No-op when the booking isn't org-sponsored.
   *
   * Throws `ProgramAssignmentLimitError` if the cap is BLOCK and would
   * be exceeded — the surrounding transaction rolls back the new slots.
   */
  private static async recordSubscriptionAllocationCap(
    tx: Tx,
    subscriptionId: string,
    consulteeUserId: string,
    newAppointmentIds: string[],
  ): Promise<void> {
    // Find the original signup Payment via the placeholder Appointment.
    // SUBSCRIPTION checkout creates exactly one Appointment with a
    // linked Payment; subsequent allocation appointments have no Payment
    // of their own.
    const subscription = await tx.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        appointments: {
          include: { payment: true },
        },
      },
    });

    // Schema declares Appointment.payment as Payment[] (one Appointment
    // can carry multiple Payments historically — refunds/retries chain
    // off the original). Flatten and pick the EARLIEST org-tagged one:
    // an unordered .find() over a retry chain debits whichever row the DB
    // happened to return first, landing utilization on the wrong
    // ProgramAssignment cycle (#1169 PR 1).
    const orgPayment = subscription?.appointments
      .flatMap((a) => a.payment)
      .filter((p) => !!p.organizationId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];

    if (!orgPayment || !orgPayment.organizationId) {
      // PERSONAL-funded subscription — no org cap to debit.
      return;
    }

    const membership = await tx.membership.findUnique({
      where: {
        userId_organizationId: {
          userId: consulteeUserId,
          organizationId: orgPayment.organizationId,
        },
      },
    });
    if (!membership || membership.status !== "ACTIVE") return;

    // Re-resolve the active ProgramAssignment at allocation time.
    // Mirrors the resolver in lib/payments/operations/checkout.ts so the
    // same coverage filters apply (assignment ACTIVE, program ACTIVE,
    // contract ACTIVE, covers SUBSCRIPTION).
    const now = new Date();
    const assignment = await tx.programAssignment.findFirst({
      where: {
        membershipId: membership.id,
        // #1132 follow-up — checkout filters on status too; without it the
        // period window alone matched ROLLED / CLOSED / CANCELLED rows, so a
        // dead assignment inside its old window could still be debited by a
        // lazily-allocated subscription session.
        status: "ACTIVE",
        periodStart: { lte: now },
        periodEnd: { gte: now },
        program: {
          status: "ACTIVE",
          OR: [
            { coveredPlanTypes: { isEmpty: true } },
            { coveredPlanTypes: { has: "SUBSCRIPTION" } },
          ],
          contract: {
            organizationId: orgPayment.organizationId,
            status: "ACTIVE",
            effectiveFrom: { lte: now },
            OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }],
          },
        },
      },
      orderBy: { periodEnd: "desc" },
      select: { id: true },
    });
    if (!assignment) return;

    // priceAtBookingPaise: full upfront sub price on the very first
    // allocation (so the BookingUtilization row carries it for
    // analytics); 0 on subsequent allocations (no new money). The
    // helper's upsert preserves the first-create priceAtBookingPaise.
    const existingUtil = await tx.bookingUtilization.findUnique({
      where: { paymentId: orgPayment.id },
      select: { id: true, appointmentIds: true },
    });
    const priceAtBookingPaise = existingUtil ? 0 : orgPayment.amount;

    // Re-allocation deletes counted appointments and recreates them with
    // fresh ids, so an id-set diff alone re-debits every replaced session.
    // Substitute stale tracked ids (no longer live on this subscription)
    // with incoming ids 1:1 WITHOUT debiting; only ids beyond the
    // substitution budget are genuinely additional sessions.
    let idsToDebit = newAppointmentIds;
    if (existingUtil) {
      const liveIds = new Set(subscription!.appointments.map((a) => a.id));
      const trackedLive = existingUtil.appointmentIds.filter((id) =>
        liveIds.has(id),
      );
      const staleCount =
        existingUtil.appointmentIds.length - trackedLive.length;
      if (staleCount > 0) {
        const alreadyTracked = new Set(trackedLive);
        const incomingNew = newAppointmentIds.filter(
          (id) => !alreadyTracked.has(id),
        );
        const substituted = incomingNew.slice(0, staleCount);
        idsToDebit = incomingNew.slice(staleCount);
        await tx.bookingUtilization.update({
          where: { id: existingUtil.id },
          data: { appointmentIds: [...trackedLive, ...substituted] },
        });

        // The substitution above only cancels out the sessions that were
        // REPLACED. Sessions removed and not re-created in this allocation
        // (a partial reschedule that drops 3 and re-places 1, an in-progress
        // reallocation that shrinks the remaining plan) were left debited
        // forever: the org kept paying for engagements the consultee will
        // never take, and the seat never came back. Give the difference back
        // through the ledger-derived reversal, which is idempotent and clamps
        // itself to what is still reversible.
        const netRemoved = staleCount - substituted.length;
        if (netRemoved > 0) {
          await reverseBookingUtilization(tx, {
            paymentId: orgPayment.id,
            engagementsToReverse: netRemoved,
            reason: "Subscription sessions removed during re-allocation",
          });
        }

        if (idsToDebit.length === 0) return;
      }
    }

    // Not captured here — this only runs from createAppointments, itself only
    // reachable via allocate()'s try, whose catch reports every error
    // reaching it (a ProgramAssignmentLimitError cap-exceeded included,
    // correctly classified as one of its modelled outcomes). A capture here
    // too would be a dupe, so this no longer needs its own try/catch.
    await recordBookingUtilization(tx, {
      programAssignmentId: assignment.id,
      paymentId: orgPayment.id,
      engagementsConsumed: idsToDebit.length,
      priceAtBookingPaise,
      // PR-1e (G3): pass the appointment ids so re-allocation
      // (delete+recreate of the same slot) can't double-debit. The
      // helper computes the set diff against
      // BookingUtilization.appointmentIds and increments only by the
      // genuinely-new ids.
      appointmentIds: idsToDebit,
    });
  }

  /**
   * Reconnect enrolled users to newly created slots.
   * Used during in-progress reallocation of group events (classes):
   * when future slots are deleted and recreated, the enrolled users'
   * M2M links are lost. This restores them on the new slots.
   */
  private static async reconnectEnrolledUsers(
    tx: Tx,
    appointments: AppointmentWithSlots[],
    enrolledUserIds: string[],
    consultantUserId: string,
    organizationId: string | null | undefined,
  ): Promise<void> {
    // Filter out the consultant (already connected via createAppointments)
    const userIdsToConnect = enrolledUserIds.filter(
      (id) => id !== consultantUserId,
    );
    if (userIdsToConnect.length === 0) return;

    const connectData = userIdsToConnect.map((id) => ({ id }));
    for (const appointment of appointments) {
      for (const slot of appointment.slotsOfAppointment) {
        await tx.slotOfAppointment.update({
          where: { id: slot.id },
          data: { user: { connect: connectData } },
        });
      }
      // #1319 A9 — re-linked learners keep their seat; idempotent on retry.
      await recordParticipants(
        tx,
        appointment.id,
        userIdsToConnect.map((userId) => ({
          userId,
          role: "CONSULTEE" as const,
        })),
        // Same org tag as the consultant row createAppointments wrote, so an
        // org-scoped read of the participants never sees a half-tagged seat.
        { status: "CONFIRMED", organizationId },
      );
    }
  }

  /**
   * #1206 — the people already seated on an event's confirmed sessions.
   *
   * Every delete branch harvests these ids from the rows it frees, so that
   * `reconnectEnrolledUsers` can re-link them to the replacements. A top-up
   * frees nothing, so it reads them off the surviving slots instead. Without
   * this a class topped up with two more sessions would create them empty:
   * enrolment for a group event lives ONLY on the slot↔user join.
   */
  private static async collectEventParticipantIds(
    tx: Tx,
    eventType: EventType,
    eventId: string,
  ): Promise<string[]> {
    const relationField = this.getEventRelationField(eventType);
    const slots = await tx.slotOfAppointment.findMany({
      where: {
        isTentative: false,
        deletedAt: null,
        // A cancelled or replaced slot keeps its user relation as history; only
        // live seats should be carried onto the new sessions.
        completionStatus: {
          notIn: [
            SlotCompletionStatus.CANCELLED,
            SlotCompletionStatus.RESCHEDULED,
          ],
        },
        appointment: {
          [`${relationField}Id`]: eventId,
        } as Prisma.AppointmentWhereInput,
      },
      select: { user: { select: { id: true } } },
    });
    return Array.from(
      new Set(slots.flatMap((slot) => slot.user.map((user) => user.id))),
    );
  }

  /**
   * Delete existing appointments for an event
   *
   * @param onlyTentative - If true, only delete tentative SlotOfAppointment records,
   *                        preserving confirmed slots and their parent appointments.
   *                        Appointments are only deleted if they have zero remaining slots
   *                        after tentative slot removal. This is used for partial reschedules.
   * @param preservePastSlots - If true (and onlyTentative is false), only delete future slots,
   *                            preserving past confirmed slots and their MeetingSession records.
   *                            Used for in-progress reallocation of classes/subscriptions.
   * @returns preservedSlotCount - Number of past slots that were preserved.
   * @returns enrolledUserIds - User IDs connected to deleted future slots (for reconnection).
   * @returns deletedAppointmentIds - AE-4: appointment ids whose tentative slots
   *   were freed (partial reschedule path), so callers can refresh those slots.
   */
  private static async deleteExistingAppointments(
    tx: Tx,
    eventType: EventType,
    eventId: string,
    onlyTentative: boolean = false,
    preservePastSlots: boolean = false,
  ): Promise<{
    preservedSlotCount: number;
    enrolledUserIds: string[];
    deletedAppointmentIds: string[];
    // #898 — id of a preserved 1:1 (consultation/webinar) payment-bearing
    // appointment the caller must REUSE: its @unique event FK is still taken,
    // so a fresh create would throw P2002. At most one per 1:1 event.
    reusableAppointmentId?: string;
  }> {
    const relationField = this.getEventRelationField(eventType);
    const whereClause = {
      [`${relationField}Id`]: eventId,
    } as Prisma.AppointmentWhereInput;
    // #898 — set in the onlyTentative / full-delete branches when a 1:1
    // payment-bearing appointment is kept rather than deleted.
    let reusableAppointmentId: string | undefined;

    if (onlyTentative) {
      // Find appointments with tentative slots for this event
      const appointments = await tx.appointment.findMany({
        where: whereClause,
        include: {
          // Include slot participants so enrolled learners on the tentative
          // slots can be re-linked to the new slots after they're deleted.
          slotsOfAppointment: { include: { user: { select: { id: true } } } },
          // B8 — Payment has onDelete: Cascade on Appointment; deleting an
          // appointment with payment rows destroys the payment/refund audit
          // trail. The refusal now rides in the delete's own WHERE clause
          // (B-P1-05) rather than this read, which can go stale mid-txn.
        },
      });

      // AE-4 — record which appointments had tentative slots freed here (ids
      // captured from the pre-fetched rows, before the deleteMany runs).
      const deletedAppointmentIds: string[] = [];
      // Capture users connected to the tentative slots being deleted. For a
      // group event (class) the enrolled learners live ONLY on the slot↔user
      // M2M — createAppointments reconnects just the consultant, so without
      // this they'd be orphaned when the class is scheduled (tentative
      // crud-with-plan slots → onlyTentative path). reconnectEnrolledUsers
      // re-links them to the new slots; it filters the consultant itself.
      const enrolledUserIdSet = new Set<string>();
      for (const appointment of appointments) {
        const hasConfirmed = appointment.slotsOfAppointment.some(
          (slot) => !slot.isTentative,
        );
        const hasTentative = appointment.slotsOfAppointment.some(
          (slot) => slot.isTentative,
        );

        if (hasTentative) {
          deletedAppointmentIds.push(appointment.id);
          // Collect enrolled participants from the tentative slots before they
          // are deleted (their M2M links vanish with the slots).
          for (const slot of appointment.slotsOfAppointment) {
            if (!slot.isTentative) continue;
            for (const user of slot.user ?? []) {
              enrolledUserIdSet.add(user.id);
            }
          }
          // Delete only tentative slots using a direct query (not stale IDs)
          await tx.slotOfAppointment.deleteMany({
            where: {
              appointmentId: appointment.id,
              isTentative: true,
            },
          });

          // If no confirmed slots exist, delete the now-empty appointment —
          // unless payments reference it (B8): the empty shell is cheaper
          // than a destroyed audit trail; the orphan sweep reports it.
          //
          // B-P1-05 (#1189 audit) — the payment guard rides IN the delete's
          // WHERE clause rather than trusting `_count.payment` above. That
          // count was read earlier in this transaction; a checkout's Payment
          // insert can COMMIT between the read and the delete, and
          // Payment.appointment is onDelete: Cascade, so an unconditional
          // delete would cascade-destroy a payment that did not exist when we
          // looked. Zero rows deleted means a payment appeared: keep the
          // appointment exactly like the payment-bearing path.
          const deletedAppointment = !hasConfirmed
            ? await tx.appointment.deleteMany({
                where: { id: appointment.id, payment: { none: {} } },
              })
            : null;
          if (
            (hasConfirmed || deletedAppointment?.count === 0) &&
            (eventType === "consultation" || eventType === "webinar")
          ) {
            // #898 — the appointment is kept (confirmed slots remain, or the
            // payment guard fired). For a 1:1 event it still holds the @unique
            // event FK, so the allocator must REUSE it; a fresh create P2002s.
            reusableAppointmentId = appointment.id;
          }
        }
      }
      return {
        preservedSlotCount: 0,
        enrolledUserIds: Array.from(enrolledUserIdSet),
        deletedAppointmentIds,
        reusableAppointmentId,
      };
    } else if (preservePastSlots) {
      // In-progress reallocation: only delete future slots, preserve past ones
      const now = new Date();
      const appointments = await tx.appointment.findMany({
        where: whereClause,
        include: {
          slotsOfAppointment: {
            include: {
              user: { select: { id: true } },
              meetingSession: { select: { id: true, endedAt: true } },
            },
          },
          // The payment guard on the empty-appointment delete below rides in
          // that delete's WHERE clause (B-P1-05), not in a pre-read count.
        },
      });

      let preservedSlotCount = 0;
      const enrolledUserIdSet = new Set<string>();
      const imminentCutoff = new Date(now.getTime() + TWENTY_FOUR_HOURS_IN_MS);

      for (const appointment of appointments) {
        const pastSlots = appointment.slotsOfAppointment.filter(
          (slot) => new Date(slot.endsAt) <= now,
        );
        const futureSlots = appointment.slotsOfAppointment.filter(
          (slot) => new Date(slot.endsAt) > now,
        );

        // Guard: preserve slots that are imminent (<24h) or have active sessions
        const protectedFutureSlots = futureSlots.filter(
          (slot) =>
            new Date(slot.startsAt) < imminentCutoff ||
            (slot.meetingSession && !slot.meetingSession.endedAt),
        );
        const deletableFutureSlots = futureSlots.filter(
          (slot) =>
            new Date(slot.startsAt) >= imminentCutoff &&
            (!slot.meetingSession || slot.meetingSession.endedAt !== null),
        );

        preservedSlotCount += pastSlots.length + protectedFutureSlots.length;

        // Capture enrolled user IDs from deletable future slots before deletion
        for (const slot of deletableFutureSlots) {
          for (const user of slot.user) {
            enrolledUserIdSet.add(user.id);
          }
        }

        if (deletableFutureSlots.length > 0) {
          await tx.slotOfAppointment.deleteMany({
            where: {
              appointmentId: appointment.id,
              id: { in: deletableFutureSlots.map((s) => s.id) },
            },
          });
        }

        // Only delete the appointment if no slots remain at all — and never
        // when it carries payments (#898 defense-in-depth: the Payment cascade
        // is Restrict-blocked by ConsultantEarnings and rolls back the tx).
        // Latent today (the subscription placeholder can't reach this branch),
        // but mirrors the onlyTentative / full-delete guards. The payment
        // guard rides in the delete's WHERE (B-P1-05) — same race as the
        // onlyTentative branch.
        if (pastSlots.length === 0 && protectedFutureSlots.length === 0) {
          await tx.appointment.deleteMany({
            where: { id: appointment.id, payment: { none: {} } },
          });
        }
      }

      return {
        preservedSlotCount,
        enrolledUserIds: Array.from(enrolledUserIdSet),
        // AE-4 — in-progress path frees future slots, not tentative ones; the
        // freed-id contract is scoped to the partial-reschedule case.
        deletedAppointmentIds: [],
        // #898 — only class/subscription (1:N) reach this branch; no 1:1 reuse.
        reusableAppointmentId,
      };
    } else {
      // Full delete: remove all appointments for this event.
      // B8 — an appointment that carries Payment rows must NOT be deleted: the
      // delete cascades to Payment (onDelete: Cascade), which is Restrict-
      // referenced by ConsultantEarnings, so the cascade trips the
      // ConsultantEarnings_paymentId_fkey constraint and the whole allocation
      // rolls back. This is exactly the SUBSCRIPTION case — checkout leaves a
      // zero-slot placeholder Appointment carrying the signup Payment+earnings,
      // and initial allocation reaches this branch. Mirror the onlyTentative
      // guard: preserve payment-bearing appointments, just free their slots so
      // they no longer block availability; delete the rest as before.
      const existingAppointments = await tx.appointment.findMany({
        where: whereClause,
        include: {
          // Slot participants, so enrolled learners (group events) can be
          // re-linked to the new slots — same reason as the onlyTentative
          // branch. Without this, re-scheduling a confirmed, not-yet-started
          // class orphans its enrolled learners (all slots here are removed).
          // meetingSession rides along so held-session slots can be preserved
          // (#1169 PR 1 — deleting them cascades MeetingSession → Recording).
          slotsOfAppointment: {
            include: {
              user: { select: { id: true } },
              meetingSession: { select: { id: true } },
            },
          },
          _count: { select: { payment: true } },
        },
      });

      // Capture enrolled participants from every slot before it's deleted or
      // stripped; reconnectEnrolledUsers (called by the allocator on a non-empty
      // result) re-links them to the new slots and filters the consultant.
      const enrolledUserIdSet = new Set<string>();
      for (const appointment of existingAppointments) {
        for (const slot of appointment.slotsOfAppointment) {
          for (const user of slot.user ?? []) {
            enrolledUserIdSet.add(user.id);
          }
        }
      }

      await Promise.all(
        existingAppointments.map(async (appointment) => {
          // #1169 PR 1 — a slot whose MeetingSession already happened is
          // history, not availability: deleting it cascades MeetingSession →
          // Recording. Preserve the appointment and every held-session slot;
          // only sessionless slots are freed.
          const hasHeldSession = appointment.slotsOfAppointment.some(
            (slot) => slot.meetingSession !== null,
          );
          if ((appointment._count?.payment ?? 0) > 0 || hasHeldSession) {
            // Keep the Appointment (and its Payment + ConsultantEarnings audit
            // trail); strip its slots. No-op for the slot-less subscription
            // placeholder, but frees slots for any other payment-bearing case.
            if (eventType === "consultation" || eventType === "webinar") {
              // #898 — 1:1 event: the kept appointment still holds the @unique
              // event FK, so the allocator must REUSE it (a fresh create P2002s).
              // At most one such appointment exists per 1:1 event.
              reusableAppointmentId = appointment.id;
            }
            return tx.slotOfAppointment.deleteMany({
              where: {
                appointmentId: appointment.id,
                meetingSession: { is: null },
              },
            });
          }
          // B-P1-05 (#1189 audit) — atomic payment guard, same as the
          // onlyTentative branch: a checkout's Payment can commit between the
          // `_count` read above and this delete; the WHERE clause re-checks at
          // write time so the cascade can never consume it. Zero rows deleted
          // means a payment appeared — keep the appointment and strip only its
          // sessionless slots, exactly like the payment-bearing path above.
          const deletedAppointment = await tx.appointment.deleteMany({
            where: { id: appointment.id, payment: { none: {} } },
          });
          if (deletedAppointment.count === 0) {
            if (eventType === "consultation" || eventType === "webinar") {
              reusableAppointmentId = appointment.id;
            }
            return tx.slotOfAppointment.deleteMany({
              where: {
                appointmentId: appointment.id,
                meetingSession: { is: null },
              },
            });
          }
          return deletedAppointment;
        }),
      );
      return {
        preservedSlotCount: 0,
        enrolledUserIds: Array.from(enrolledUserIdSet),
        deletedAppointmentIds: [],
        reusableAppointmentId,
      };
    }
  }

  /**
   * Update event status after allocation
   */
  private static async updateEventStatus(
    tx: Tx,
    eventType: EventType,
    eventId: string,
    firstSlot: Date,
    config: EventConfig,
  ): Promise<void> {
    switch (eventType) {
      // #836 — allocation racing a cancel/expiry must not resurrect the
      // request to APPROVED; the allowed-from guard rides the WHERE and a
      // miss rolls back the whole allocation tx. fromIn keeps the APPROVED
      // self-edge legal for re-allocation of an already-approved event.
      case "consultation":
        await transitionConsultationRequest(tx, {
          where: { id: eventId },
          to: AppointmentStatus.APPROVED,
          fromIn: ALLOCATION_APPROVABLE_FROM,
        });
        break;

      case "subscription":
        await transitionSubscriptionRequest(tx, {
          where: { id: eventId },
          to: AppointmentStatus.APPROVED,
          fromIn: ALLOCATION_APPROVABLE_FROM,
          data: {
            // FIX: Only set schedulingPeriod if not already configured
            // This prevents overwriting the user's scheduling period with the first allocated slot
            // which could cause slots to appear outside the intended scheduling window
            ...(!config.schedulingPeriodStartsAt ||
            !config.schedulingPeriodEndsAt
              ? {
                  schedulingPeriodStartsAt: firstSlot,
                  schedulingPeriodEndsAt: addMonths(
                    firstSlot,
                    config.durationInMonths || 1,
                  ),
                }
              : {}),
          },
        });
        break;

      case "webinar": {
        // Webinar model does NOT have startDate/endDate fields
        // Start date is stored in the Appointment's slots.
        //
        // Allocation gives an event its sessions; it does NOT publish one. A
        // DRAFT therefore keeps its status here and merely receives its slots:
        // "add a session, then publish" is the editor's flow, and publishing is
        // one-way (EVENT_PUBLISHABLE_FROM). Re-allocating a live event still
        // re-stamps SCHEDULED, and CANCELLED/COMPLETED are still refused —
        // that resurrection hazard is why the guard exists at all.
        //
        // This used to transition to SCHEDULED against a map that deliberately
        // excludes DRAFT, so it matched zero rows and 409'd the entire
        // allocation: the one affordance that gives a draft its first session
        // always failed (#1060).
        const restamped = await tx.webinar.updateMany({
          where: { id: eventId, status: { in: EVENT_ALLOWED_FROM.SCHEDULED } },
          data: { status: "SCHEDULED" },
        });
        if (restamped.count === 0) {
          const current = await tx.webinar.findUnique({
            where: { id: eventId },
            select: { status: true },
          });
          if (current?.status !== "DRAFT") {
            throw new IllegalTransitionError("Webinar", "SCHEDULED");
          }
        }
        break;
      }

      case "class": {
        // Class model HAS schedulingPeriod fields
        // FIX: Only set schedulingPeriod if not already configured — same guard as SUBSCRIPTION.
        // Overwriting an explicitly-set period on re-allocation shifts the window, allowing
        // slots outside the original range to pass the scheduling-period validation check.
        const periodData =
          !config.schedulingPeriodStartsAt || !config.schedulingPeriodEndsAt
            ? {
                schedulingPeriodStartsAt: firstSlot,
                schedulingPeriodEndsAt: addMonths(
                  firstSlot,
                  config.durationInMonths || 2,
                ),
              }
            : {};

        // Same DRAFT-keeps-its-status rule as WEBINAR above, and the same
        // resurrection guard.
        const restamped = await tx.class.updateMany({
          where: {
            id: eventId,
            status: { in: CLASS_EVENT_ALLOWED_FROM.SCHEDULED },
          },
          data: { status: "SCHEDULED", ...periodData },
        });
        if (restamped.count === 0) {
          const current = await tx.class.findUnique({
            where: { id: eventId },
            select: { status: true },
          });
          if (current?.status !== "DRAFT") {
            throw new IllegalTransitionError("Class", "SCHEDULED");
          }
          // A draft keeps DRAFT but still needs its scheduling period, or the
          // slots it just received sit outside a window that is never set.
          if (Object.keys(periodData).length > 0) {
            await tx.class.updateMany({
              where: { id: eventId, status: "DRAFT" },
              data: periodData,
            });
          }
        }
        break;
      }
    }
  }

  /**
   * Fetch event data including consultant and config
   */
  private static async fetchEventData(
    // #908 — accepts the base client so event/config reads can run OUTSIDE the
    // write transaction (under the locks). Reads only.
    db: PrismaLike,
    eventType: EventType,
    eventId: string,
  ): Promise<{
    consultant: ConsultantAllocationData;
    config: EventConfig;
    consulteeUserId?: string;
    requestedSlots?: Date[];
    /**
     * Org context for any Appointment rows created by this allocation.
     * Resolved per event type; see #768 Comment 5.
     */
    organizationId?: string | null;
    /** AE-2 (#784) — the plan the co-host guard reads its collaborators from. */
    planId?: string | null;
  } | null> {
    const consultantProfileSelect = {
      select: {
        user: true,
        scheduleType: true,
        slotsOfAvailabilityWeekly: true,
        slotsOfAvailabilityCustom: true,
      },
    } as const;

    let consultantProfile:
      | {
          user: { id: string; timezone?: string | null };
          scheduleType: "WEEKLY" | "CUSTOM";
          slotsOfAvailabilityWeekly: ConsultantAllocationData["slotsOfAvailabilityWeekly"];
          slotsOfAvailabilityCustom: ConsultantAllocationData["slotsOfAvailabilityCustom"];
        }
      | null
      | undefined;
    let config: EventConfig;
    let consulteeUserId: string | undefined;
    let requestedSlots: Date[] | undefined;
    // #768 Comment 5
    let organizationId: string | null = null;
    // AE-2 (#784) — webinar/class only; the other two have no collaborators.
    let planId: string | null = null;

    switch (eventType) {
      case "consultation": {
        const event = await db.consultation.findUnique({
          where: { id: eventId },
          include: {
            consultationPlan: {
              include: { consultantProfile: consultantProfileSelect },
            },
            requestedBy: { include: { user: true } },
            appointment: { include: { slotsOfAppointment: true } },
          },
        });
        if (!event) return null;
        consultantProfile = event.consultationPlan?.consultantProfile;
        config = {
          durationInHours: event.consultationPlan?.durationInHours,
        };
        consulteeUserId = event.requestedBy?.user?.id;
        // #1319 — atom STARTS, not one entry per row. The approval gate counts
        // covered half-hour atoms and `validateConsultation` compares against
        // `getSlotsPerCall`, so a legacy 60-minute row offered as one requested
        // slot answered "1" to both questions and could never be approved.
        requestedSlots = event.appointment?.slotsOfAppointment?.flatMap((s) =>
          halfHourAtomStarts(s),
        );
        // #768 — preserve org tag across reschedule (delete+recreate).
        organizationId = event.appointment?.organizationId ?? null;
        break;
      }

      case "subscription": {
        const event = await db.subscription.findUnique({
          where: { id: eventId },
          include: {
            subscriptionPlan: {
              include: { consultantProfile: consultantProfileSelect },
            },
            requestedBy: { include: { user: true } },
            appointments: {
              include: {
                slotsOfAppointment: true,
                payment: { select: { organizationId: true } },
              },
            },
          },
        });
        if (!event) return null;
        consultantProfile = event.subscriptionPlan?.consultantProfile;
        config = {
          durationInMonths: event.subscriptionPlan?.durationInMonths,
          sessionsPerWeek: event.subscriptionPlan?.sessionsPerWeek,
          sessionDurationInHours:
            event.subscriptionPlan?.sessionDurationInHours,
          totalSessions: event.subscriptionPlan?.totalSessions,
          schedulingPeriodStartsAt: event.schedulingPeriodStartsAt ?? undefined,
          schedulingPeriodEndsAt: event.schedulingPeriodEndsAt ?? undefined,
          schedulingTimezone: event.schedulingTimezone ?? undefined,
        };
        consulteeUserId = event.requestedBy?.user?.id;
        // #1319 — same coverage rule as the consultation arm above.
        requestedSlots = event.appointments?.flatMap((app) =>
          app.slotsOfAppointment.flatMap((s) => halfHourAtomStarts(s)),
        );
        // #768 — placeholder Appointment from checkout carries the org
        // tag. New lazy-allocated slots inherit it.
        organizationId =
          event.appointments?.find((a) => a.organizationId)?.organizationId ??
          event.appointments
            ?.flatMap((a) => a.payment)
            .find((p) => p?.organizationId)?.organizationId ??
          null;
        break;
      }

      case "webinar": {
        const event = await db.webinar.findUnique({
          where: { id: eventId },
          include: {
            webinarPlan: {
              include: { consultantProfile: consultantProfileSelect },
            },
          },
        });
        if (!event) return null;
        consultantProfile = event.webinarPlan?.consultantProfile;
        config = {
          durationInHours: event.webinarPlan?.durationInHours,
        };
        // #768 — WEBINAR Appointment is SHARED across registrants from
        // multiple orgs; tag with the plan's host org if any.
        organizationId = event.webinarPlan?.organizationId ?? null;
        planId = event.webinarPlanId ?? null;
        break;
      }

      case "class": {
        const event = await db.class.findUnique({
          where: { id: eventId },
          include: {
            classPlan: {
              include: {
                consultantProfile: consultantProfileSelect,
              },
            },
            appointments: { include: { slotsOfAppointment: true } },
          },
        });
        if (!event) return null;
        consultantProfile = event.classPlan?.consultantProfile;
        // The plan's sessionDurationInHours is the ONE source of truth for a
        // class session's slot count: crud-with-plan writes tentative slots at
        // this duration, /validate validates against it, and the client picks
        // slots with it. The former avg(classContents.hoursAllotted)
        // derivation disagreed with all three whenever a curriculum item's
        // hours differed from the plan — validate passed while allocate
        // rejected, and createAppointments regrouped sessions to the wrong
        // length. Curriculum items describe content coverage, not the length
        // of the sessions that teach it.
        const sessionDuration = event.classPlan?.sessionDurationInHours || 1;

        config = {
          durationInMonths: event.classPlan?.durationInMonths,
          sessionsPerWeek: event.classPlan?.sessionsPerWeek,
          sessionDurationInHours: sessionDuration,
          totalSessions: event.classPlan?.totalSessions,
          schedulingPeriodStartsAt: event.schedulingPeriodStartsAt ?? undefined,
          schedulingPeriodEndsAt: event.schedulingPeriodEndsAt ?? undefined,
          schedulingTimezone: event.schedulingTimezone ?? undefined,
        };
        // #768 — CLASS sessions inherit host-org from the plan; locked
        // even on reschedule. Marketplace classes stay null.
        organizationId = event.classPlan?.organizationId ?? null;
        planId = event.classPlanId ?? null;
        break;
      }
    }

    if (!consultantProfile) {
      throw new AllocationNotFoundError("Consultant profile not found");
    }

    // FIX: Validate date ordering for events with scheduling periods
    // This prevents bugs in auto-allocation and week calculation
    if (config.schedulingPeriodStartsAt && config.schedulingPeriodEndsAt) {
      if (config.schedulingPeriodStartsAt >= config.schedulingPeriodEndsAt) {
        throw new AllocationValidationError(
          `Invalid date range: schedulingPeriodStartsAt (${config.schedulingPeriodStartsAt.toISOString()}) ` +
            `must be before schedulingPeriodEndsAt (${config.schedulingPeriodEndsAt.toISOString()}). ` +
            `Please check the ${eventType} configuration.`,
        );
      }
    }

    return {
      consultant: {
        userId: consultantProfile.user.id,
        scheduleType: consultantProfile.scheduleType,
        slotsOfAvailabilityWeekly: consultantProfile.slotsOfAvailabilityWeekly,
        slotsOfAvailabilityCustom: consultantProfile.slotsOfAvailabilityCustom,
        timezone: consultantProfile.user.timezone ?? undefined,
      },
      config,
      consulteeUserId,
      requestedSlots,
      organizationId,
      planId,
    };
  }

  /**
   * Get Prisma appointment type enum
   */
  private static getAppointmentType(eventType: EventType): AppointmentsType {
    const map: Record<EventType, AppointmentsType> = {
      consultation: AppointmentsType.CONSULTATION,
      subscription: AppointmentsType.SUBSCRIPTION,
      webinar: AppointmentsType.WEBINAR,
      class: AppointmentsType.CLASS,
    };
    return map[eventType];
  }

  /**
   * Get event relation field name for Prisma
   */
  private static getEventRelationField(eventType: EventType): string {
    return eventType;
  }
}
