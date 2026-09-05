import * as Sentry from "@sentry/nextjs";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import {
  AppointmentBusyError,
  BookingLockUnavailableError,
  withAppointmentLock,
} from "@/utils/appointmentlock";
import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
import type {
  Prisma,
  RescheduleInitiatorRole,
  ReschedulePreferredDays,
  ReschedulePreferredTimeOfDay,
} from "@prisma/client";
import { RescheduleProposalSchema } from "@/schemas/appointments";
import {
  computeProposalExpiry,
  proposalCountMatches,
  rescheduleNotificationVariant,
  supportsProposals,
} from "@/lib/booking/reschedule-proposals";
import {
  ReschedulePolicyError,
  RescheduleAuthorizationError,
  AppointmentTypeMismatchError,
  AppointmentNotFoundError,
} from "@/utils/errors/RescheduleErrors";
import { notifyAppointmentRescheduled } from "@/lib/novu/service";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";
import { logActivity } from "@/lib/activity/log-activity";
import { tryAutoConfirmProposal } from "@/lib/booking/reschedule-auto-confirm";
import { hasActiveDisputeForAppointment } from "@/lib/payments/dispute-guard";
import {
  CLASS_EVENT_ALLOWED_FROM,
  EVENT_ALLOWED_FROM,
  RESCHEDULABLE_FROM,
  SLOT_RESCHEDULABLE_FROM,
  transitionClassEvent,
  transitionConsultationRequest,
  transitionSlotCompletion,
  transitionSubscriptionRequest,
  transitionWebinarEvent,
} from "@/lib/booking/transitions";
import { isOrgAdminOfAppointment } from "@/lib/booking/org-actor";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { isUniqueViolation } from "@/lib/db/pg-errors";

const MINIMUM_HOURS_BEFORE_RESCHEDULE = 24;

/**
 * Which side is asking. Null for a privileged ADMIN/STAFF bypass, which is
 * neither party and therefore never auto-confirms on someone else's behalf.
 */
function roleOf(
  isConsultee: boolean,
  isConsultant: boolean,
): RescheduleInitiatorRole | null {
  if (isConsultee) return "CONSULTEE";
  if (isConsultant) return "CONSULTANT";
  return null;
}

/**
 * POST /api/appointments/[appointmentId]/reschedule
 *
 * Reschedule an appointment or specific session(s) within a subscription.
 *
 * Query Parameters:
 * - type: AppointmentType (CONSULTATION, SUBSCRIPTION, WEBINAR, CLASS)
 *
 * Body (optional):
 * - slotIds: string[] - For SUBSCRIPTION type only. If provided, only these specific
 *                       slots will be marked as tentative. If not provided,
 *                       all slots in the subscription will be marked as tentative.
 *
 * Behavior:
 * - For CONSULTATION: Marks all slots as tentative, reverts status to PENDING
 * - For SUBSCRIPTION with slotIds: Marks only specified slots as tentative (individual/multiple session reschedule)
 * - For SUBSCRIPTION without slotIds: Marks ALL slots as tentative (entire subscription reschedule)
 * - For WEBINAR/CLASS: Marks all slots as tentative
 *
 * 24-Hour Restriction:
 * - Cannot reschedule if ANY slot to be rescheduled is within 24 hours
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // #1319 — this route triggers refunds/reallocation and had no limiter.
    const limited = await applyRateLimit(eventMutationLimiter, session.user.id);
    if (limited) return limited;

    const { appointmentId } = await params;
    const { searchParams } = new URL(request.url);
    const appointmentType = searchParams.get("type");

    // #1008 — an appointment with a live payment dispute is frozen: its state is
    // evidence and must not move while the dispute is contested.
    if (await hasActiveDisputeForAppointment(appointmentId)) {
      return NextResponse.json(
        {
          error:
            "This appointment has an open payment dispute and can't be rescheduled until it resolves.",
          code: "DISPUTE_ACTIVE",
        },
        { status: 409 },
      );
    }

    // Parse request body for optional slotIds (used for individual/multiple session reschedule)
    let slotIds: string[] | undefined;
    // Concrete replacement times. Optional: "release these, any time works" is
    // still a valid request and remains the whole contract for group events.
    let proposedSlots: { startsAt: Date; endsAt: Date }[] | undefined;
    let reason: string | undefined;
    // #1065 — how the initiator wants the replacement placed when they name no
    // time. Scored by the allocator, never used to exclude a candidate.
    let preferredTimeOfDay: ReschedulePreferredTimeOfDay | undefined;
    let preferredDays: ReschedulePreferredDays | undefined;
    try {
      const body = await request.json();
      // Support both single slotId (legacy) and slotIds array
      if (body?.slotIds && Array.isArray(body.slotIds)) {
        slotIds = body.slotIds;
      } else if (body?.slotId) {
        // Legacy support: convert single slotId to array
        slotIds = [body.slotId];
      }
      const parsedProposal = RescheduleProposalSchema.safeParse(body);
      if (!parsedProposal.success) {
        return NextResponse.json(
          {
            error: "Invalid proposed times",
            code: "INVALID_PROPOSAL",
            details: parsedProposal.error.flatten(),
          },
          { status: 400 },
        );
      }
      if (parsedProposal.data.proposedSlots?.length) {
        proposedSlots = parsedProposal.data.proposedSlots.map((s) => ({
          startsAt: new Date(s.startsAt),
          endsAt: new Date(s.endsAt),
        }));
      }
      reason = parsedProposal.data.reason;
      preferredTimeOfDay = parsedProposal.data.preferredTimeOfDay;
      preferredDays = parsedProposal.data.preferredDays;
    } catch {
      // No body or invalid JSON - that's fine, every field here is optional
    }

    // #1166 — resolve the funding org's admin membership BEFORE the interactive
    // transaction opens. `isOrgAdminOfAppointment` runs on the global client, so
    // calling it from inside the callback issues a query on a SECOND pooled
    // connection while this transaction is already holding one — the exact
    // shape #908 documents (below, on the auto-confirm check) as having 500'd
    // with "Unable to start a transaction in the given time". A membership row
    // is not transaction state, so reading it early costs nothing.
    const orgScope = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: { organizationId: true },
    });
    const actorIsFundingOrgAdmin = await isOrgAdminOfAppointment(
      session.user.id,
      orgScope?.organizationId,
    );

    // Start transaction
    // #1319 — serialize lifecycle mutations per appointment (lock order:
    // appointment first, before any consultee/slot key a future change adds).
    const result = await withAppointmentLock(appointmentId, () =>
      prisma.$transaction(
        async (tx) => {
          // Get appointment details with all related data
          const appointment = await tx.appointment.findUnique({
            where: { id: appointmentId },
            include: {
              slotsOfAppointment: {
                orderBy: { startsAt: "asc" },
              },
              consultation: {
                include: {
                  consultationPlan: {
                    include: {
                      consultantProfile: true,
                    },
                  },
                  requestedBy: true,
                },
              },
              subscription: {
                include: {
                  subscriptionPlan: {
                    include: {
                      consultantProfile: true,
                    },
                  },
                  requestedBy: true,
                },
              },
              webinar: {
                include: {
                  webinarPlan: true,
                },
              },
              class: {
                include: {
                  classPlan: true,
                },
              },
            },
          });

          if (!appointment) {
            throw new AppointmentNotFoundError("appointment", appointmentId);
          }

          // Participant authorization check
          const consultantProfileId = session.user.consultantProfileId;
          const consulteeProfileId = session.user.consulteeProfileId;

          let isParticipant = false;
          // Which side is asking. Load-bearing rather than descriptive: only a
          // CONSULTEE proposal may auto-confirm, because publishing availability
          // is standing consent to be booked inside it while merely being free is
          // not consent to be moved. Null for a privileged bypass, which never
          // auto-confirms on someone else's behalf.
          let initiatorRole: RescheduleInitiatorRole | null = null;

          // Check the single event-type relation (mutually exclusive via if-else)
          if (appointment.consultation) {
            const consultationConsultantId =
              appointment.consultation.consultationPlan?.consultantProfileId;
            const isConsultant =
              consultantProfileId === consultationConsultantId;
            const isConsultee =
              consulteeProfileId === appointment.consultation.requestedById;
            isParticipant = isConsultant || isConsultee;
            initiatorRole = roleOf(isConsultee, isConsultant);
          } else if (appointment.subscription) {
            const subscriptionConsultantId =
              appointment.subscription.subscriptionPlan?.consultantProfileId;
            const isConsultant =
              consultantProfileId === subscriptionConsultantId;
            const isConsultee =
              consulteeProfileId === appointment.subscription.requestedById;
            isParticipant = isConsultant || isConsultee;
            initiatorRole = roleOf(isConsultee, isConsultant);
          } else if (appointment.webinar) {
            // Only the consultant (organizer) can reschedule group events,
            // since rescheduling changes the time for all participants.
            const webinarConsultantId =
              appointment.webinar.webinarPlan?.consultantProfileId;
            isParticipant = consultantProfileId === webinarConsultantId;
          } else if (appointment.class) {
            // Same as webinar: consultant-only reschedule
            const classConsultantId =
              appointment.class.classPlan?.consultantProfileId;
            isParticipant = consultantProfileId === classConsultantId;
          }

          // Allow ADMIN/STAFF bypass
          const isPrivilegedUser = isPrivileged(session.user.role);

          // #1166 — an admin of the FUNDING org may reschedule the booking. They
          // act on the payer side, so their proposals carry the CONSULTEE role:
          // same auto-confirm consent semantics as the buyer they act for.
          const isOrgAdminActor =
            !isParticipant && !isPrivilegedUser && actorIsFundingOrgAdmin;
          if (isOrgAdminActor) {
            initiatorRole = "CONSULTEE";
          }

          if (!isParticipant && !isPrivilegedUser && !isOrgAdminActor) {
            throw new RescheduleAuthorizationError();
          }

          // Derive type from DB instead of trusting query param
          const derivedType = appointment.consultation
            ? "CONSULTATION"
            : appointment.subscription
              ? "SUBSCRIPTION"
              : appointment.webinar
                ? "WEBINAR"
                : appointment.class
                  ? "CLASS"
                  : null;

          if (
            appointmentType &&
            derivedType &&
            appointmentType !== derivedType
          ) {
            throw new AppointmentTypeMismatchError(
              appointmentType,
              derivedType,
            );
          }

          // For SUBSCRIPTION and CLASS types, we need to get ALL slots across ALL appointments
          // because the UI collects slots from all appointments but only passes one appointmentId
          let allSubscriptionSlots: typeof appointment.slotsOfAppointment = [];

          if (derivedType === "SUBSCRIPTION" && appointment.subscription) {
            // Fetch all appointments for this subscription with their slots
            const allAppointments = await tx.appointment.findMany({
              where: { subscriptionId: appointment.subscription.id },
              include: { slotsOfAppointment: { orderBy: { startsAt: "asc" } } },
            });
            allSubscriptionSlots = allAppointments.flatMap(
              (apt) => apt.slotsOfAppointment,
            );
          } else if (derivedType === "CLASS" && appointment.class) {
            // Fetch all appointments for this class with their slots
            const allAppointments = await tx.appointment.findMany({
              where: { classId: appointment.class.id },
              include: { slotsOfAppointment: { orderBy: { startsAt: "asc" } } },
            });
            allSubscriptionSlots = allAppointments.flatMap(
              (apt) => apt.slotsOfAppointment,
            );
          }

          // E2E-audit fix — whole-series flows must act on LIVE slots only.
          // The 24-hour gate and the proposal-count check used to iterate every
          // historical row (COMPLETED/CANCELLED sessions included), so any
          // past session made hoursUntilSlot negative and the aggregate
          // reschedule was bricked with a guaranteed 400 after the first
          // delivery. SLOT_RESCHEDULABLE_FROM is the canonical live set — a
          // requested-but-completed id now correctly reports as missing.
          allSubscriptionSlots = allSubscriptionSlots.filter((s) =>
            (SLOT_RESCHEDULABLE_FROM as string[]).includes(s.completionStatus),
          );

          // Determine which slots will be affected
          // For multi-appointment types (SUBSCRIPTION, CLASS) without slotIds, check all slots
          let slotsToReschedule =
            (derivedType === "SUBSCRIPTION" || derivedType === "CLASS") &&
            (!slotIds || slotIds.length === 0) &&
            allSubscriptionSlots.length > 0
              ? allSubscriptionSlots
              : appointment.slotsOfAppointment;

          // For SUBSCRIPTION/CLASS with slotIds, only reschedule the specific
          // slots. CLASS previously fell through to the whole-class branch, so
          // a per-session class reschedule silently escalated to every session.
          if (
            slotIds &&
            slotIds.length > 0 &&
            ((derivedType === "SUBSCRIPTION" && appointment.subscription) ||
              (derivedType === "CLASS" && appointment.class))
          ) {
            // Filter to only the requested slots from ALL subscription slots
            slotsToReschedule = allSubscriptionSlots.filter((s) =>
              slotIds.includes(s.id),
            );

            // Validate all requested slots exist
            if (slotsToReschedule.length !== slotIds.length) {
              const foundIds = slotsToReschedule.map((s) => s.id);
              const missingIds = slotIds.filter((id) => !foundIds.includes(id));
              throw new AppointmentNotFoundError("slot", missingIds.join(", "));
            }
          }

          // 24-hour restriction check - validate ALL selected slots
          const now = new Date();
          for (const slot of slotsToReschedule) {
            const hoursUntilSlot =
              (new Date(slot.startsAt).getTime() - now.getTime()) /
              (1000 * 60 * 60);

            if (hoursUntilSlot < MINIMUM_HOURS_BEFORE_RESCHEDULE) {
              throw new ReschedulePolicyError(
                hoursUntilSlot,
                MINIMUM_HOURS_BEFORE_RESCHEDULE,
              );
            }
          }

          // Audit attribution for every BookingStatusHistory row this
          // reschedule writes (#1322 A12). `appointmentId` is added per call
          // site: a whole-subscription or whole-class release moves slots of
          // sibling appointments, whose history belongs on their own timeline.
          const auditMeta = {
            actorUserId: session.user.id,
            reason: reason ?? null,
            organizationId: appointment.organizationId,
          };
          // Every slot flip below releases the row in place: RESCHEDULED plus
          // tentative, never a tombstone. The reschedule keeps these rows —
          // the proposal's releasedSlotIds point at them and a withdrawal
          // restores them — so `deletedAt` is the cancel path's business only.
          //
          // From-state guard on every slot flip: a reschedule must never
          // resurrect COMPLETED/CANCELLED history to RESCHEDULED (#837). It
          // rides in `fromIn`, not in `where`, because the helper overwrites
          // `completionStatus` in the caller's WHERE with its own from-set.
          // `allowZero` keeps the pre-existing contract: a release that matches
          // no live row answers 200 with `slotsAffected: 0`, not a 409.
          const releaseSlots = (where: Prisma.SlotOfAppointmentWhereInput) =>
            transitionSlotCompletion(tx, {
              ...auditMeta,
              where,
              to: "RESCHEDULED",
              data: { isTentative: true },
              fromIn: SLOT_RESCHEDULABLE_FROM,
              allowZero: true,
            });

          // Mark the appropriate slots as tentative
          if (
            slotIds &&
            slotIds.length > 0 &&
            ((derivedType === "SUBSCRIPTION" && appointment.subscription) ||
              (derivedType === "CLASS" && appointment.class))
          ) {
            // Individual/multiple session reschedule - mark ALL slots of the affected appointments
            // (e.g. a 1.5h session has 3 consecutive slots; all must be marked tentative together)
            const affectedAppointmentIds = Array.from(
              new Set(slotsToReschedule.map((s) => s.appointmentId)),
            );
            await releaseSlots({
              appointmentId: { in: affectedAppointmentIds },
            });
          } else if (
            derivedType === "SUBSCRIPTION" &&
            appointment.subscription
          ) {
            // Entire subscription reschedule - mark ALL slots in ALL appointments
            const allAppointmentIds = (
              await tx.appointment.findMany({
                where: { subscriptionId: appointment.subscription.id },
                select: { id: true },
              })
            ).map((a) => a.id);

            await releaseSlots({ appointmentId: { in: allAppointmentIds } });
          } else if (derivedType === "CLASS" && appointment.class) {
            // Entire class reschedule - mark ALL slots in ALL appointments
            const allAppointmentIds = (
              await tx.appointment.findMany({
                where: { classId: appointment.class.id },
                select: { id: true },
              })
            ).map((a) => a.id);

            await releaseSlots({ appointmentId: { in: allAppointmentIds } });
          } else {
            // Non-multi-appointment: mark all slots in the single appointment
            await releaseSlots({ appointmentId });
          }

          // Update status based on appointment type — through the CAS helpers
          // (B2): a reschedule racing a cancel/completion must not resurrect
          // the booking, so the allowed-from set rides the WHERE and a zero-row
          // match throws instead of writing. The set lives in
          // lib/booking/transitions.ts so the map is canonical.
          try {
            if (appointment.consultation) {
              await transitionConsultationRequest(tx, {
                ...auditMeta,
                appointmentId,
                where: { id: appointment.consultation.id },
                to: "PENDING",
                // requestedAt rides along deliberately: the stale-request
                // expiry sweep keys its PENDING cohort on requestedAt, so a
                // reschedule re-entering PENDING must refresh the clock or the
                // next hourly run reads the ORIGINAL request age — for any
                // booking older than 48h that is "stale", and the sweep would
                // terminalise (EXPIRED) and fully refund a live booking the
                // consultee is actively trying to move.
                data: { requestedAt: new Date() },
                fromIn: [...RESCHEDULABLE_FROM],
              });
            } else if (appointment.subscription) {
              // #448 — a single/multi-session reschedule must NOT flip the WHOLE
              // subscription to PENDING. Subscription has no per-session status;
              // the affected slots already carry isTentative + RESCHEDULED, so the
              // session-level state is captured there. Only a full-subscription
              // reschedule (no slotIds) genuinely re-enters PENDING. The partial
              // path still terminal-guards (count, no write): rescheduling a
              // session of a cancelled/completed subscription stays a 409.
              const isPartialSubscriptionReschedule = Boolean(
                slotIds && slotIds.length > 0,
              );
              if (isPartialSubscriptionReschedule) {
                const live = await tx.subscription.count({
                  where: {
                    id: appointment.subscription.id,
                    status: { in: [...RESCHEDULABLE_FROM] },
                  },
                });
                // No status moves on this path, so there is nothing to CAS and
                // nothing to record; the throw only reuses the 409 below.
                if (live === 0) {
                  throw new IllegalTransitionError("Subscription", "PENDING");
                }
              } else {
                await transitionSubscriptionRequest(tx, {
                  ...auditMeta,
                  appointmentId,
                  where: { id: appointment.subscription.id },
                  to: "PENDING",
                  // Same clock-refresh rationale as the consultation flip
                  // above: expirePendingSubscriptions keys on requestedAt.
                  data: { requestedAt: new Date() },
                  fromIn: [...RESCHEDULABLE_FROM],
                });
              }
            } else if (appointment.webinar) {
              // Explicit allowed-from (was notIn) — robust against future enum
              // additions (#837).
              await transitionWebinarEvent(tx, {
                ...auditMeta,
                appointmentId,
                where: { id: appointment.webinar.id },
                to: "SCHEDULED",
                fromIn: EVENT_ALLOWED_FROM.SCHEDULED,
              });
            } else if (appointment.class) {
              await transitionClassEvent(tx, {
                ...auditMeta,
                appointmentId,
                where: { id: appointment.class.id },
                to: "SCHEDULED",
                fromIn: CLASS_EVENT_ALLOWED_FROM.SCHEDULED,
              });
            }
          } catch (err) {
            // The helper's zero-row throw IS the old `movedStatus === 0`; the
            // client contract stays NOT_RESCHEDULABLE.
            if (!(err instanceof IllegalTransitionError)) throw err;
            throw Object.assign(
              new Error(
                "This appointment can no longer be rescheduled (already cancelled or completed).",
              ),
              { httpStatus: 409, code: "NOT_RESCHEDULABLE" },
            );
          }

          // Attach the proposed replacement times, if any were given. Without
          // this a reschedule reaches the consultant carrying LESS information
          // than the original booking did — which slots to drop, and nothing
          // about when the consultee actually wants them.
          //
          // #1065 — a stated preference opens the same record with no times on
          // it, so "any time works, but ideally weekday mornings" survives to the
          // allocator. It takes the openForAppointmentId reservation like any
          // other reschedule: "at most one live reschedule per appointment" is an
          // invariant four other places rely on, and a row that opted out of it
          // could shadow a real proposal in the consultant's card or be picked
          // arbitrarily by the withdraw route. The allocator closes the row when
          // it places the replacement times (resolveConsumedPreferenceRequests),
          // so the reservation is released the moment it stops meaning anything.
          let rescheduleRequestId: string | null = null;
          const hasPreference = Boolean(preferredTimeOfDay || preferredDays);
          if (
            (proposedSlots?.length || hasPreference) &&
            initiatorRole &&
            supportsProposals(derivedType)
          ) {
            if (
              proposedSlots?.length &&
              !proposalCountMatches(
                slotsToReschedule.length,
                proposedSlots.length,
              )
            ) {
              throw Object.assign(
                new Error(
                  `Proposed ${proposedSlots.length} time(s) for ${slotsToReschedule.length} released slot(s). ` +
                    `A reschedule replaces slots one for one; changing the count would change what was paid for.`,
                ),
                { httpStatus: 400, code: "PROPOSAL_COUNT_MISMATCH" },
              );
            }

            const expiresAt = computeProposalExpiry(
              slotsToReschedule.map((s) => new Date(s.startsAt)),
            );
            if (!expiresAt) {
              // The 24-hour policy gate above should already have rejected this,
              // so reaching here means the two rules have drifted apart.
              throw Object.assign(
                new Error(
                  "This session is too close to propose a new time for.",
                ),
                { httpStatus: 400, code: "PROPOSAL_WINDOW_CLOSED" },
              );
            }

            const created = await tx.rescheduleRequest.create({
              data: {
                appointmentId,
                initiatorRole,
                initiatedById: session.user.id,
                reason,
                releasedSlotIds: slotsToReschedule.map((s) => s.id),
                expiresAt,
                // Reserves the appointment: the nullable @unique makes a second
                // live reschedule a DB-level conflict rather than a race. Claimed
                // by EVERY reschedule row, times or preference-only, because the
                // uniqueness is what four downstream readers assume (#1065).
                openForAppointmentId: appointmentId,
                organizationId: appointment.organizationId ?? null,
                preferredTimeOfDay,
                preferredDays,
                proposedSlots: {
                  create: (proposedSlots ?? []).map((s) => ({
                    startsAt: s.startsAt,
                    endsAt: s.endsAt,
                    proposedById: session.user.id,
                  })),
                },
              },
              select: { id: true },
            });
            // Only a request carrying times can auto-confirm or be answered, and
            // the caller reads this id as "times were sent" — so a preference-only
            // row deliberately leaves it null.
            if (proposedSlots?.length) rescheduleRequestId = created.id;
          }

          // #448 — count SESSIONS, not raw slots: one Appointment is one session
          // (a 1-hour session is 2 × 30-min slots), so a single 1h-session
          // reschedule must report 1 session, not "2 sessions"/multiple_sessions.
          const sessionsAffected = new Set(
            slotsToReschedule.map((s) => s.appointmentId),
          ).size;

          // Determine reschedule type for response — session-based (#448)
          const getRescheduleType = () => {
            if (
              derivedType !== "SUBSCRIPTION" ||
              !slotIds ||
              slotIds.length === 0
            ) {
              return "entire_booking";
            }
            return sessionsAffected === 1
              ? "individual_session"
              : "multiple_sessions";
          };

          const rescheduleType = getRescheduleType();

          // Captured here because an auto-confirm deletes these rows and writes
          // new ones — by the time the notification is built, the time being
          // given up no longer exists anywhere.
          const releasedAt = slotsToReschedule.reduce<Date | null>(
            (earliest, slot) =>
              !earliest || slot.startsAt < earliest ? slot.startsAt : earliest,
            null,
          );

          // Return detailed response
          return {
            success: true,
            rescheduleType,
            releasedAt,
            // #448 — sessionsAffected is the user-facing count (distinct sessions);
            // slotsAffected stays for back-compat / debugging.
            sessionsAffected,
            slotsAffected: slotsToReschedule.length,
            message:
              rescheduleType === "entire_booking"
                ? "All sessions marked for rescheduling. Please select new times."
                : `${sessionsAffected} session(s) marked for rescheduling. Please select new time(s).`,
            // B14 — context for the post-tx activity log (appointment is only
            // in scope inside this callback).
            logContext: {
              cpId:
                appointment.consultation?.consultationPlan
                  ?.consultantProfileId ??
                appointment.subscription?.subscriptionPlan
                  ?.consultantProfileId ??
                appointment.webinar?.webinarPlan?.consultantProfileId ??
                appointment.class?.classPlan?.consultantProfileId ??
                null,
              appointmentType: appointment.appointmentType,
              consultationId: appointment.consultation?.id,
              subscriptionId: appointment.subscription?.id,
              webinarId: appointment.webinar?.id,
              classId: appointment.class?.id,
            },
            rescheduleRequestId,
          };
        },
        {
          timeout: 60000, // 60 second timeout for complex transactions
        },
      ),
    );

    // A consultee's proposal that lands in published availability and finds both
    // calendars free needs no approval, so take it now. Deliberately AFTER the
    // transaction: validating inside it would pin a pooled connection through
    // the whole availability check, which is the shape #908 documents as having
    // 500'd with "Unable to start a transaction in the given time".
    //
    // Failure here is an ordinary outcome, not an error — the proposal simply
    // stays PENDING_REVIEW for the consultant to answer.
    let autoConfirmed = false;
    if (result.rescheduleRequestId) {
      // Only the two 1:1 kinds carry proposals; a group event never opens one.
      const proposal = result.logContext.consultationId
        ? {
            type: "consultation" as const,
            id: result.logContext.consultationId,
          }
        : null;
      const proposalTarget =
        proposal ??
        (result.logContext.subscriptionId
          ? {
              type: "subscription" as const,
              id: result.logContext.subscriptionId,
            }
          : null);

      if (proposalTarget) {
        try {
          const outcome = await tryAutoConfirmProposal(
            result.rescheduleRequestId,
            proposalTarget.type,
            proposalTarget.id,
          );
          autoConfirmed = outcome.confirmed;
        } catch (err) {
          // A lost CAS race on the final AUTO_ACCEPTED write (proposal answered
          // or expired concurrently) is an ordinary outcome, not an error —
          // reschedule-auto-confirm.ts already reports anything else itself.
          if (!(err instanceof IllegalTransitionError)) {
            Sentry.captureException(
              err instanceof Error ? err : new Error(String(err)),
              {
                tags: { subsystem: "bookings", op: "reschedule-auto-confirm" },
              },
            );
          }
        }
      }
    }

    // B14 — reschedule now leaves an activity-log entry (cancel always did).
    if (result.logContext.cpId) {
      await logActivity({
        activityType: "APPOINTMENT_RESCHEDULED",
        description: `Appointment reschedule requested (${result.logContext.appointmentType.toLowerCase()})`,
        actorId: session.user.id,
        actorName: session.user.name || "User",
        actorImage: session.user.image,
        consultantProfileId: result.logContext.cpId,
        consultationId: result.logContext.consultationId,
        subscriptionId: result.logContext.subscriptionId,
        webinarId: result.logContext.webinarId,
        classId: result.logContext.classId,
      });
    }

    // Fire-and-forget: notify both parties about reschedule

    // FIX #624: Include webinar/class so group event participants are also notified.
    try {
      const appointment = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          consultation: {
            include: {
              consultationPlan: {
                select: {
                  title: true,
                  consultantProfile: {
                    select: { userId: true, user: { select: { name: true } } },
                  },
                },
              },
              requestedBy: {
                select: { userId: true, user: { select: { name: true } } },
              },
            },
          },
          subscription: {
            include: {
              subscriptionPlan: {
                select: {
                  title: true,
                  consultantProfile: {
                    select: { userId: true, user: { select: { name: true } } },
                  },
                },
              },
              requestedBy: {
                select: { userId: true, user: { select: { name: true } } },
              },
            },
          },
          webinar: {
            include: {
              webinarPlan: {
                select: {
                  title: true,
                  consultantProfile: {
                    select: { userId: true, user: { select: { name: true } } },
                  },
                },
              },
            },
          },
          class: {
            include: {
              classPlan: {
                select: {
                  title: true,
                  consultantProfile: {
                    select: { userId: true, user: { select: { name: true } } },
                  },
                },
              },
            },
          },
          slotsOfAppointment: {
            select: {
              user: { select: { id: true, name: true } },
            },
          },
        },
      });

      if (appointment) {
        const consultation = appointment.consultation;
        const subscription = appointment.subscription;
        const webinar = appointment.webinar;
        const classEvent = appointment.class;

        const plan =
          consultation?.consultationPlan ??
          subscription?.subscriptionPlan ??
          webinar?.webinarPlan ??
          classEvent?.classPlan ??
          null;
        const requestedBy =
          consultation?.requestedBy ?? subscription?.requestedBy ?? null;

        // For 1:1 events, notify consultant + consultee
        // For group events (webinar/class), notify consultant + all slot participants
        const userIds: string[] = [];
        if (plan?.consultantProfile?.userId) {
          userIds.push(plan.consultantProfile.userId);
        }
        if (requestedBy?.userId) {
          userIds.push(requestedBy.userId);
        }
        // FIX #624: Add all participants from slots (webinar/class attendees)
        if (appointment.slotsOfAppointment) {
          for (const slot of appointment.slotsOfAppointment) {
            for (const user of slot.user) {
              userIds.push(user.id);
            }
          }
        }

        // Deduplicate; exclude the initiator — you don't need a notification
        // about your own reschedule (B15).
        const uniqueUserIds = Array.from(new Set(userIds)).filter(
          (id) => id !== session.user.id,
        );

        const appointmentType = consultation
          ? "consultation"
          : subscription
            ? "subscription"
            : webinar
              ? "webinar"
              : "class";

        // Earliest of the times asked for, and only when a proposal actually
        // opened: a group event never carries one, so it is always a release.
        const proposedAt = result.rescheduleRequestId
          ? (proposedSlots?.reduce<Date | null>(
              (earliest, slot) =>
                !earliest || slot.startsAt < earliest
                  ? slot.startsAt
                  : earliest,
              null,
            ) ?? null)
          : null;

        if (uniqueUserIds.length > 0) {
          void notifyAppointmentRescheduled(uniqueUserIds, {
            ...notificationScope(appointment.organizationId),
            ...rescheduleNotificationVariant({
              releasedAt: result.releasedAt,
              proposedAt,
              autoConfirmed,
            }),
            appointmentType,
            consultantName: plan?.consultantProfile?.user?.name ?? "Consultant",
            consulteeName: requestedBy?.user?.name ?? "Participant",
            planTitle: plan?.title ?? "Unknown",
            // Group events fan out to every attendee, so one href must serve
            // them all — org route when org-hosted, router bounce otherwise.
            dashboardUrl: notificationHref(
              appointment.organizationId,
              "appointments",
            ),
          }).catch((err) =>
            console.error("[reschedule] Failed to send notification:", err),
          );
        }
      }
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "appointments" } },
      );
      console.error("[reschedule] Failed to send notification:", error);
    }

    // The three outcomes read very differently to a user — you're moved, we've
    // asked, or nothing was proposed — so they must not collapse into one line.
    const resultMessage = () => {
      if (autoConfirmed) return "Your new time is confirmed.";
      if (result.rescheduleRequestId) {
        return "Your requested time has been sent to the consultant.";
      }
      return result.message;
    };

    return NextResponse.json({
      ...result,
      autoConfirmed,
      // The two outcomes read very differently to a user — "you're moved" versus
      // "we've asked" — so the client must be able to tell them apart rather
      // than inferring it from the proposal's presence.
      message: resultMessage(),
    });
  } catch (error) {
    // #1319 — lock outcomes are structured, never a 500.
    if (error instanceof BookingLockUnavailableError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    if (error instanceof AppointmentBusyError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    // openForAppointmentId is a nullable @unique, so a second reschedule while
    // one is still open is MEANT to fail here — that is the DB-level guarantee
    // of at most one live proposal per appointment. Without this branch the
    // expected outcome surfaced as a 500 "Failed to request reschedule" and
    // was reported to Sentry as an unexpected error.
    if (isUniqueViolation(error)) {
      return NextResponse.json(
        {
          error: "A reschedule request is already open for this booking.",
          code: "RESCHEDULE_ALREADY_OPEN",
        },
        { status: 409 },
      );
    }

    // B2 — the CAS guard's structured 409 (NOT_RESCHEDULABLE).
    if (error instanceof Error && "httpStatus" in error) {
      const status =
        typeof (error as { httpStatus?: number }).httpStatus === "number"
          ? (error as { httpStatus: number }).httpStatus
          : 500;
      const code =
        "code" in error && typeof (error as { code?: string }).code === "string"
          ? (error as { code: string }).code
          : undefined;
      return NextResponse.json(
        { error: error.message, ...(code && { code }) },
        { status },
      );
    }
    // Type-safe error handling using custom error classes
    if (error instanceof RescheduleAuthorizationError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }

    if (error instanceof AppointmentTypeMismatchError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    if (error instanceof ReschedulePolicyError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    if (error instanceof AppointmentNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }

    // Only log unexpected errors — the known error types above are normal control flow
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "appointments" } },
    );
    console.error("Error requesting reschedule:", error);
    return NextResponse.json(
      { error: "Failed to request reschedule" },
      { status: 500 },
    );
  }
}
