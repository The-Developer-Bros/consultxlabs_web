/**
 * Slot Availability Reconciliation - Core Logic
 *
 * Fixes slot availability inconsistencies:
 * 1. Clears isTentative flag on slots with successful payments
 * 2. Detects double-booked slots (overlapping confirmed bookings)
 *
 * This catches cases where:
 * - Payment succeeded but isTentative wasn't cleared
 * - Race condition caused overlapping bookings
 * - System error left slots in inconsistent state
 *
 * This module exports the core reconciliation function.
 * It is imported by:
 * - jobs/reconcile-slot-availability.ts (GitHub Actions)
 * - app/api/cleanup/reconcile-slot-availability/route.ts (API endpoint)
 *
 * Schedule: Hourly
 */

import prisma from "../../lib/prisma";
import {
  AppointmentStatus,
  PaymentStatus,
  SlotCompletionStatus,
} from "@prisma/client";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";
import {
  buildOccupiedAppointmentFilter,
  OCCUPIED_EVENT_STATUSES,
} from "@/utils/slotAllocation/occupancyPolicy";
import { SlotAllocationService } from "@/utils/slotAllocation/SlotAllocationService";
import { SlotCalculationService } from "@/utils/slotAllocation/SlotCalculationService";
import type { EventConfig } from "@/utils/slotAllocation/types";

export interface SlotReconciliationResult {
  success: boolean;
  tentativeFlagsCleared: number;
  doubleBookingsDetected: number;
  doubleBookings: DoubleBookingInfo[];
  /** #1206 — outcome of the top-up pass; see `topUpIncompleteEvents`. */
  topUps: TopUpSweepResult;
  errors: string[];
  timestamp: string;
}

interface DoubleBookingInfo {
  consultantId: string;
  consultantName: string;
  slotTime: string;
  appointments: string[];
}

/**
 * #1206 — what one top-up pass did. `failed` is deliberately NOT folded into
 * the run's errors: a consultant whose calendar still has no room, or an event
 * that lost a lock race, is an ordinary outcome, and turning it into a red cron
 * would train everyone to ignore this job.
 */
export interface TopUpSweepResult {
  attempted: number;
  /** Events that gained at least one session. */
  placed: number;
  /** Events already complete, or still without room. */
  noChange: number;
  failed: number;
  /** Appointment rows created across the whole pass. */
  sessionsPlaced: number;
}

/**
 * Clear isTentative flag on slots with successful payments
 */
async function clearTentativeOnSuccessfulPayments(): Promise<{
  cleared: number;
  errors: string[];
}> {
  const errors: string[] = [];

  console.log("🔍 Finding tentative slots with successful payments...");

  // #1424 — the sweep's own predicate, hoisted so the write can repeat it
  // (ADR 21: a sweep restates its money predicate in the WHERE it writes with).
  // The completion from-set is the point: a partial reschedule releases a slot
  // as isTentative=true / completionStatus=RESCHEDULED while leaving the parent
  // APPROVED, so the parent-status guard below does not see it. Stamping such a
  // slot confirmed blocks the consultant's calendar for a session nobody will
  // deliver. CANCELLED is excluded for the same reason.
  const CLEARABLE_COMPLETION_STATUSES: SlotCompletionStatus[] = [
    SlotCompletionStatus.SCHEDULED,
    SlotCompletionStatus.COMPLETED,
    SlotCompletionStatus.UNVERIFIED,
  ];
  const LIVE_TENTATIVE_SLOT = {
    isTentative: true,
    deletedAt: null,
    completionStatus: { in: CLEARABLE_COMPLETION_STATUSES },
  };

  try {
    // FIX #623: Find tentative slots with successful payments, but EXCLUDE
    // slots that are tentative due to an in-progress reschedule.
    // The reschedule workflow sets consultation/subscription status back to PENDING
    // while new slots are being selected. We must not clear those prematurely.
    const slotsToFix = await prisma.slotOfAppointment.findMany({
      where: {
        ...LIVE_TENTATIVE_SLOT,
        appointment: {
          payment: {
            some: {
              paymentStatus: PaymentStatus.SUCCEEDED,
            },
          },
          // FIX #623: Only clear tentative on consultation/subscription appointments
          // where tentative = "payment succeeded but flag wasn't cleared".
          // Webinar/class are intentionally excluded because:
          // 1. Their reschedule marks ALL slots tentative with no status signal
          //    to distinguish "stale payment" from "reschedule-in-progress"
          // 2. Without a reliable discriminator, clearing would break reschedules
          // Trade-off: stale webinar/class tentative slots won't auto-heal here,
          // but that's safer than breaking active reschedules. A future
          // `tentativeReason` column would let us reconcile all event types.
          OR: [
            { consultationId: { not: null } },
            { subscriptionId: { not: null } },
          ],
          NOT: {
            OR: [
              { consultation: { status: "PENDING" } },
              { subscription: { status: "PENDING" } },
            ],
          },
        },
      },
      include: {
        appointment: {
          include: {
            payment: { select: { id: true, paymentStatus: true } },
            consultation: { select: { id: true } },
          },
        },
      },
    });

    console.log(
      `Found ${slotsToFix.length} tentative slots with successful payments`,
    );

    for (const slot of slotsToFix) {
      console.log(`\nFixing slot ${slot.id}`);
      console.log(`   Appointment: ${slot.appointmentId}`);
      console.log(
        `   Time: ${slot.startsAt.toISOString()} - ${slot.endsAt.toISOString()}`,
      );
    }

    if (slotsToFix.length > 0) {
      // Bulk update to clear tentative flag — use exact IDs from the filtered
      // query so we never touch a slot outside the cohort, AND repeat the
      // cohort's own predicate so we never touch a slot that LEFT the cohort
      // between the read and this write (#1424).
      const ids = slotsToFix.map((s) => s.id);
      const result = await prisma.slotOfAppointment.updateMany({
        where: { id: { in: ids }, ...LIVE_TENTATIVE_SLOT },
        data: { isTentative: false },
      });

      console.log(`✅ Cleared tentative flag on ${result.count} slots`);
      if (result.count < ids.length) {
        // Not an error: the skipped rows were rescheduled, cancelled or
        // soft-deleted mid-run and will be picked up by the cohort that owns
        // them. Logged so a persistent gap is visible rather than silent.
        console.warn(
          JSON.stringify({
            event: "reconcile_tentative_clear_raced",
            read: ids.length,
            cleared: result.count,
            skipped: ids.length - result.count,
            note: "slots left the cohort between the read and the write",
            timestamp: new Date().toISOString(),
          }),
        );
      }
      return { cleared: result.count, errors };
    }

    return { cleared: 0, errors };
  } catch (error) {
    const msg = `Failed to clear tentative flags: ${error}`;
    console.error(`❌ ${msg}`);
    errors.push(msg);
    return { cleared: 0, errors };
  }
}

/**
 * Detect double-booked slots (overlapping confirmed bookings for same consultant)
 */
async function detectDoubleBookings(): Promise<{
  detected: number;
  bookings: DoubleBookingInfo[];
  errors: string[];
}> {
  const errors: string[] = [];
  const doubleBookings: DoubleBookingInfo[] = [];

  console.log("\n🔍 Detecting double-booked slots...");

  try {
    // Get all future slots whose parent event is in an occupied state, grouped
    // by consultant. Occupancy is defined by the canonical policy
    // (buildOccupiedAppointmentFilter), not by a SUCCEEDED-payment filter, so
    // overlaps involving unpaid/tentative holds (PENDING, APPROVED,
    // APPROVED_PENDING_PAYMENT) are caught too — the old payment-only query
    // missed them.
    // #1169 PR 6 — window-bound: reconciling ALL future slots scans without
    // limit as the book grows; overlaps meaningfully surface within the
    // scheduling horizon, and later runs cover later windows.
    const RECONCILE_WINDOW_DAYS = 60;
    const windowEnd = new Date(
      Date.now() + RECONCILE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    const confirmedSlots = await prisma.slotOfAppointment.findMany({
      where: {
        endsAt: { gt: new Date() }, // Only future slots
        startsAt: { lt: windowEnd },
        appointment: {
          AND: [
            { OR: buildOccupiedAppointmentFilter() },
            // Exclude legitimately in-flight tentative holds. A consultation/
            // subscription reset to PENDING is either awaiting first approval or
            // mid-reschedule (#623) — its slots are transient and self-resolve, so
            // flagging them is report noise, not a real double-booking. We still
            // catch APPROVED_PENDING_PAYMENT (unpaid but committed) overlaps, which
            // is the widening this detector was changed to cover.
            {
              NOT: {
                OR: [
                  { consultation: { status: "PENDING" } },
                  { subscription: { status: "PENDING" } },
                ],
              },
            },
          ],
        },
      },
      // FIX #625: Include all 5 appointment types (not just consultation/subscription)
      // so webinar and class overlaps are also detected. Note: trial sessions
      // typically lack SUCCEEDED payments, so they won't match this query's
      // payment filter — their inclusion here is for consultant resolution only.
      include: {
        appointment: {
          include: {
            consultation: {
              include: {
                consultationPlan: {
                  include: {
                    consultantProfile: {
                      include: {
                        user: { select: { id: true, name: true, email: true } },
                      },
                    },
                  },
                },
              },
            },
            subscription: {
              include: {
                subscriptionPlan: {
                  include: {
                    consultantProfile: {
                      include: {
                        user: { select: { id: true, name: true, email: true } },
                      },
                    },
                  },
                },
              },
            },
            webinar: {
              include: {
                webinarPlan: {
                  include: {
                    consultantProfile: {
                      include: {
                        user: { select: { id: true, name: true, email: true } },
                      },
                    },
                  },
                },
              },
            },
            class: {
              include: {
                classPlan: {
                  include: {
                    consultantProfile: {
                      include: {
                        user: { select: { id: true, name: true, email: true } },
                      },
                    },
                  },
                },
              },
            },
            trialSession: {
              include: {
                consultantProfile: {
                  include: {
                    user: { select: { id: true, name: true, email: true } },
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { startsAt: "asc" },
    });

    console.log(`Checking ${confirmedSlots.length} confirmed future slots`);

    // Group slots by consultant
    const slotsByConsultant = new Map<
      string,
      Array<{
        slot: (typeof confirmedSlots)[0];
        consultantId: string;
        consultantName: string;
      }>
    >();

    for (const slot of confirmedSlots) {
      // FIX #625: Resolve consultant from all 5 appointment types
      const {
        consultation,
        subscription,
        webinar,
        class: classEvent,
        trialSession,
      } = slot.appointment;

      const consultantProfile =
        consultation?.consultationPlan.consultantProfile ||
        subscription?.subscriptionPlan.consultantProfile ||
        webinar?.webinarPlan.consultantProfile ||
        classEvent?.classPlan.consultantProfile ||
        trialSession?.consultantProfile;

      if (!consultantProfile) continue;

      const consultantId = consultantProfile.user.id;
      const consultantName = consultantProfile.user.name || "Unknown";

      if (!slotsByConsultant.has(consultantId)) {
        slotsByConsultant.set(consultantId, []);
      }
      slotsByConsultant.get(consultantId)!.push({
        slot,
        consultantId,
        consultantName,
      });
    }

    // Check for overlaps within each consultant's slots
    for (const [consultantId, slots] of Array.from(
      slotsByConsultant.entries(),
    )) {
      // Sort by start time
      const sortedSlots = [...slots].sort(
        (a: { slot: { startsAt: Date } }, b: { slot: { startsAt: Date } }) =>
          a.slot.startsAt.getTime() - b.slot.startsAt.getTime(),
      );

      for (let i = 0; i < sortedSlots.length - 1; i++) {
        const current = sortedSlots[i];
        const next = sortedSlots[i + 1];

        // Check if slots overlap
        if (current.slot.endsAt > next.slot.startsAt) {
          // Double booking detected!
          const doubleBooking: DoubleBookingInfo = {
            consultantId,
            consultantName: current.consultantName,
            slotTime: `${current.slot.startsAt.toISOString()} - ${current.slot.endsAt.toISOString()}`,
            appointments: [current.slot.appointmentId, next.slot.appointmentId],
          };

          doubleBookings.push(doubleBooking);

          console.log(`\n🚨 DOUBLE BOOKING DETECTED:`);
          console.log(`   Consultant: ${current.consultantName}`);
          console.log(
            `   Slot 1: ${current.slot.id} (${current.slot.startsAt.toISOString()} - ${current.slot.endsAt.toISOString()})`,
          );
          console.log(
            `   Slot 2: ${next.slot.id} (${next.slot.startsAt.toISOString()} - ${next.slot.endsAt.toISOString()})`,
          );
          console.log(
            `   Appointments: ${current.slot.appointmentId}, ${next.slot.appointmentId}`,
          );
        }
      }
    }

    if (doubleBookings.length === 0) {
      console.log("✅ No double bookings detected");
    } else {
      console.log(
        `\n⚠️ Found ${doubleBookings.length} double booking conflicts`,
      );
    }

    return {
      detected: doubleBookings.length,
      bookings: doubleBookings,
      errors,
    };
  } catch (error) {
    const msg = `Failed to detect double bookings: ${error}`;
    console.error(`❌ ${msg}`);
    errors.push(msg);
    return { detected: 0, bookings: [], errors };
  }
}

/**
 * Ceiling on how many events one pass may actually allocate for.
 *
 * Every attempt is a full `autoAllocate` — two Redis locks, an O(window)
 * availability search and a write transaction — and this job already declares
 * the fleet's largest DB-active window (`cron-runtime-minutes: 8`). The cap and
 * the wall-clock budget below keep the top-up pass a tail on that budget rather
 * than a new, unbounded one; whatever is skipped is picked up next hour.
 */
const TOP_UP_MAX_EVENTS_PER_RUN = 25;
const TOP_UP_TIME_BUDGET_MS = 60_000;
/** Ceiling on the candidate READ, which is cheap per row but not free. */
const TOP_UP_SCAN_LIMIT = 200;
// Pages walked per run in `updatedAt` order. Complete events never move, so
// the oldest rows are mostly complete plans the JS check skips; three pages
// keep the scan bounded while still reaching past them.
const TOP_UP_SCAN_PAGES = 3;

/**
 * Cursor pagination arguments with an explicit type, so the query result's
 * inferred type does not depend on the cursor the previous page produced
 * (TS7022 otherwise flags the row variable as referencing itself).
 */
/**
 * The next page's cursor, through a declared return type: assigning
 * `rows[rows.length - 1].id` directly makes the loop's control-flow narrowing
 * of `cursor` depend on the query result's type, which depends on `cursor`
 * (TS7022).
 */
function nextCursor(rows: ReadonlyArray<{ id: string }>): string | undefined {
  return rows.length > 0 ? rows[rows.length - 1].id : undefined;
}

function pageArgs(cursor: string | undefined): {
  skip?: number;
  cursor?: { id: string };
} {
  return cursor ? { skip: 1, cursor: { id: cursor } } : {};
}

/** One recurring event that is short of sessions, with what the sweep needs. */
interface TopUpCandidate {
  eventType: "subscription" | "class";
  eventId: string;
  consultantProfileId: string;
  /**
   * The event's own last write. A successful top-up re-stamps the request or
   * the class through the transition helper, so `updatedAt` doubles as "when
   * this event was last attempted" without a new column (#1206: no schema
   * change, no backfill).
   */
  updatedAt: Date;
  confirmedSessions: number;
  requiredSessions: number;
}

/**
 * Sessions already confirmed on an event, counted the way the allocator counts
 * them: one Appointment is one session.
 */
/**
 * Whole sessions the plan owes, or null when the configuration cannot answer
 * (a class saved without a scheduling window, say). A candidate we cannot size
 * is a candidate we must not attempt.
 */
function requiredSessionsFor(
  eventType: "subscription" | "class",
  config: EventConfig,
): number | null {
  try {
    const slotsPerCall = SlotCalculationService.getSlotsPerCall(
      config.sessionDurationInHours || 1,
    );
    return Math.ceil(
      SlotCalculationService.calculateRequiredSlots(eventType, config) /
        slotsPerCall,
    );
  } catch {
    return null;
  }
}

/**
 * Recurring events whose confirmed sessions are fewer than their plan requires.
 *
 * Both arms exclude anything carrying a tentative slot: those rows are a
 * reschedule or a live checkout hold in flight, and a top-up must not run
 * against a schedule someone is currently moving.
 */
async function collectTopUpCandidates(now: Date): Promise<TopUpCandidate[]> {
  const candidates: TopUpCandidate[] = [];

  let cursor: string | undefined;
  for (let page = 0; page < TOP_UP_SCAN_PAGES; page++) {
    const subscriptions = await prisma.subscription.findMany({
      where: {
        status: AppointmentStatus.APPROVED,
        deletedAt: null,
        // Nothing can be placed in a window that has closed.
        schedulingPeriodEndsAt: { gt: now },
        appointments: {
          some: {
            deletedAt: null,
            slotsOfAppointment: {
              some: { isTentative: false, deletedAt: null },
            },
          },
        },
        NOT: {
          appointments: {
            some: {
              deletedAt: null,
              slotsOfAppointment: {
                some: { isTentative: true, deletedAt: null },
              },
            },
          },
        },
      },
      select: {
        id: true,
        updatedAt: true,
        schedulingPeriodStartsAt: true,
        schedulingPeriodEndsAt: true,
        subscriptionPlan: {
          select: {
            consultantProfileId: true,
            durationInMonths: true,
            sessionsPerWeek: true,
            sessionDurationInHours: true,
            totalSessions: true,
          },
        },
        // Only live appointments that hold a confirmed slot come back, and only
        // their ids: the count IS the confirmed-session count (1 appointment =
        // 1 session), so no slot rows travel.
        appointments: {
          where: {
            deletedAt: null,
            slotsOfAppointment: {
              some: { isTentative: false, deletedAt: null },
            },
          },
          select: { id: true },
        },
      },
      orderBy: { updatedAt: "asc" },
      take: TOP_UP_SCAN_LIMIT,
      ...pageArgs(cursor),
    });

    for (const subscription of subscriptions) {
      const plan = subscription.subscriptionPlan;
      const required = requiredSessionsFor("subscription", {
        durationInMonths: plan.durationInMonths,
        sessionsPerWeek: plan.sessionsPerWeek,
        sessionDurationInHours: plan.sessionDurationInHours,
        totalSessions: plan.totalSessions,
        schedulingPeriodStartsAt: subscription.schedulingPeriodStartsAt,
        schedulingPeriodEndsAt: subscription.schedulingPeriodEndsAt,
      });
      const confirmed = subscription.appointments.length;
      if (required === null || confirmed >= required) continue;
      candidates.push({
        eventType: "subscription",
        eventId: subscription.id,
        consultantProfileId: plan.consultantProfileId,
        updatedAt: subscription.updatedAt,
        confirmedSessions: confirmed,
        requiredSessions: required,
      });
    }
    if (subscriptions.length < TOP_UP_SCAN_LIMIT) break;
    cursor = nextCursor(subscriptions);
  }

  cursor = undefined;
  for (let page = 0; page < TOP_UP_SCAN_PAGES; page++) {
    const classes = await prisma.class.findMany({
      where: {
        // A class has no request to approve; SCHEDULED/IN_PROGRESS is the
        // occupancy policy's equivalent of an APPROVED request.
        status: { in: [...OCCUPIED_EVENT_STATUSES] },
        deletedAt: null,
        schedulingPeriodEndsAt: { gt: now },
        appointments: {
          some: {
            deletedAt: null,
            slotsOfAppointment: {
              some: { isTentative: false, deletedAt: null },
            },
          },
        },
        NOT: {
          appointments: {
            some: {
              deletedAt: null,
              slotsOfAppointment: {
                some: { isTentative: true, deletedAt: null },
              },
            },
          },
        },
      },
      select: {
        id: true,
        updatedAt: true,
        schedulingPeriodStartsAt: true,
        schedulingPeriodEndsAt: true,
        classPlan: {
          select: {
            consultantProfileId: true,
            durationInMonths: true,
            sessionsPerWeek: true,
            sessionDurationInHours: true,
            totalSessions: true,
          },
        },
        // Only live appointments that hold a confirmed slot come back, and only
        // their ids: the count IS the confirmed-session count (1 appointment =
        // 1 session), so no slot rows travel.
        appointments: {
          where: {
            deletedAt: null,
            slotsOfAppointment: {
              some: { isTentative: false, deletedAt: null },
            },
          },
          select: { id: true },
        },
      },
      orderBy: { updatedAt: "asc" },
      take: TOP_UP_SCAN_LIMIT,
      ...pageArgs(cursor),
    });

    for (const classRun of classes) {
      const plan = classRun.classPlan;
      const required = requiredSessionsFor("class", {
        durationInMonths: plan.durationInMonths,
        sessionsPerWeek: plan.sessionsPerWeek,
        sessionDurationInHours: plan.sessionDurationInHours,
        totalSessions: plan.totalSessions,
        schedulingPeriodStartsAt:
          classRun.schedulingPeriodStartsAt ?? undefined,
        schedulingPeriodEndsAt: classRun.schedulingPeriodEndsAt ?? undefined,
      });
      const confirmed = classRun.appointments.length;
      // `ClassPlan.consultantProfileId` is nullable; a plan with no consultant
      // has no availability to search and the allocator would answer NOT_FOUND.
      if (
        required === null ||
        confirmed >= required ||
        !plan.consultantProfileId
      )
        continue;
      candidates.push({
        eventType: "class",
        eventId: classRun.id,
        consultantProfileId: plan.consultantProfileId,
        updatedAt: classRun.updatedAt,
        confirmedSessions: confirmed,
        requiredSessions: required,
      });
    }
    if (classes.length < TOP_UP_SCAN_LIMIT) break;
    cursor = nextCursor(classes);
  }

  return candidates;
}

/**
 * When each of these consultants last touched their published availability.
 *
 * The cheapest correct trigger: re-attempting an event only makes sense once
 * the schedule it failed against has changed. A hard-deleted row leaves no
 * timestamp, but removing availability can never create room, so missing that
 * edit costs nothing.
 */
async function lastAvailabilityChangeByConsultant(
  consultantProfileIds: string[],
): Promise<Map<string, Date>> {
  const latest = new Map<string, Date>();
  if (consultantProfileIds.length === 0) return latest;

  const record = (id: string, at: Date | null): void => {
    if (!at) return;
    const known = latest.get(id);
    if (!known || known < at) latest.set(id, at);
  };

  const weekly = await prisma.slotOfAvailabilityWeekly.groupBy({
    by: ["consultantProfileId"],
    where: { consultantProfileId: { in: consultantProfileIds } },
    _max: { updatedAt: true },
  });
  for (const row of weekly) record(row.consultantProfileId, row._max.updatedAt);

  const custom = await prisma.slotOfAvailabilityCustom.groupBy({
    by: ["consultantProfileId"],
    where: { consultantProfileId: { in: consultantProfileIds } },
    _max: { updatedAt: true },
  });
  for (const row of custom) record(row.consultantProfileId, row._max.updatedAt);

  return latest;
}

/**
 * #1206 — place the sessions a partial allocation left unplaced, once the
 * consultant has opened up more time.
 *
 * `topUp` keeps every confirmed appointment (and the Payment rows hanging off
 * it) exactly where it is and asks only for the shortfall, which is what made
 * this sweep impossible before: the ordinary auto path deletes and re-plans.
 * `allowPartial` means a window that still cannot hold everything places what
 * it can instead of refusing, and turns "no room at all" into a silent
 * no-change rather than an error.
 */
async function topUpIncompleteEvents(): Promise<TopUpSweepResult> {
  const summary: TopUpSweepResult = {
    attempted: 0,
    placed: 0,
    noChange: 0,
    failed: 0,
    sessionsPlaced: 0,
  };

  console.log("🔍 Finding recurring events short of sessions...");

  let due: (TopUpCandidate & { availabilityChangedAt: Date })[];
  try {
    const candidates = await collectTopUpCandidates(new Date());
    if (candidates.length === 0) {
      console.log("✅ No incomplete recurring events");
      return summary;
    }

    const lastChange = await lastAvailabilityChangeByConsultant([
      ...new Set(candidates.map((c) => c.consultantProfileId)),
    ]);

    due = candidates
      .flatMap((candidate) => {
        const changedAt = lastChange.get(candidate.consultantProfileId);
        // Nothing has been published since this event was last attempted, so
        // the search would walk the same calendar to the same answer.
        if (!changedAt || changedAt <= candidate.updatedAt) return [];
        return [{ ...candidate, availabilityChangedAt: changedAt }];
      })
      // Most recently opened-up calendars first, so the cap below spends the
      // budget on the consultants who just made room rather than on the tail
      // of events that have had none for weeks.
      .sort(
        (a, b) =>
          b.availabilityChangedAt.getTime() - a.availabilityChangedAt.getTime(),
      );
  } catch (error) {
    console.error(`❌ Failed to collect top-up candidates: ${error}`);
    return summary;
  }

  console.log(
    `Found ${due.length} event(s) whose consultant published availability since the last attempt`,
  );

  const startedAt = Date.now();
  for (const candidate of due.slice(0, TOP_UP_MAX_EVENTS_PER_RUN)) {
    if (Date.now() - startedAt > TOP_UP_TIME_BUDGET_MS) {
      console.log("⏱️ Top-up time budget spent; remaining events wait an hour");
      break;
    }
    summary.attempted++;
    try {
      const result = await SlotAllocationService.allocate({
        eventType: candidate.eventType,
        eventId: candidate.eventId,
        mode: "auto",
        topUp: true,
        allowPartial: true,
      });

      // Every outcome advances the event's `updatedAt`, which is the attempt
      // marker: a no-change or failed event rotates to the tail of the
      // `updatedAt` order and is re-tried only after the consultant's
      // availability moves again, instead of heading the list every hour.
      await touchTopUpMarker(candidate);
      if (!result.success) {
        summary.failed++;
        console.log(
          `   ${candidate.eventType} ${candidate.eventId}: ${result.errorCode ?? "FAILED"} — ${result.error}`,
        );
        continue;
      }
      if (result.noChange) {
        summary.noChange++;
        continue;
      }
      summary.placed++;
      summary.sessionsPlaced += result.appointments?.length ?? 0;
      console.log(
        `   ✅ ${candidate.eventType} ${candidate.eventId}: ${result.appointments?.length ?? 0} session(s) placed ` +
          `(${result.placedSessions ?? "?"} of ${result.requiredSessions ?? candidate.requiredSessions} now scheduled)`,
      );
    } catch (error) {
      // allocate() already converts every modelled outcome into a result, so
      // reaching here is infrastructure. One event must never end the sweep.
      summary.failed++;
      console.error(
        `❌ Top-up failed for ${candidate.eventType} ${candidate.eventId}: ${error}`,
      );
      await touchTopUpMarker(candidate).catch(() => undefined);
    }
  }

  return summary;
}

/**
 * Main function to reconcile slot availability
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open: repeat-safe side effects, lock is belt-and-braces.
/**
 * Bumps the event's `updatedAt` without touching anything else. Not a status
 * write, so it does not go through the CAS helpers; it exists only so the
 * `updatedAt` order rotates attempted events to the tail.
 */
async function touchTopUpMarker(candidate: TopUpCandidate): Promise<void> {
  const data = { updatedAt: new Date() };
  if (candidate.eventType === "subscription") {
    await prisma.subscription.update({
      where: { id: candidate.eventId },
      data,
    });
  } else {
    await prisma.class.update({ where: { id: candidate.eventId }, data });
  }
}

export async function reconcileSlotAvailability(): Promise<SlotReconciliationResult> {
  return withCronLock(
    "reconcile-slot-availability",
    { failMode: "open", ttlMs: LONG_JOB_TTL_MS },
    () => reconcileSlotAvailabilityUnlocked(),
  );
}

async function reconcileSlotAvailabilityUnlocked(): Promise<SlotReconciliationResult> {
  const allErrors: string[] = [];

  console.log("🔄 Starting slot availability reconciliation...");

  // Clear tentative flags on successful payments
  const tentativeResult = await clearTentativeOnSuccessfulPayments();
  allErrors.push(...tentativeResult.errors);

  // Detect double bookings
  const doubleBookingResult = await detectDoubleBookings();
  allErrors.push(...doubleBookingResult.errors);

  // #1206 — re-attempt the sessions a partial allocation left unplaced, now
  // that `autoAllocate` has a top-up mode that preserves what is confirmed.
  const topUpResult = await topUpIncompleteEvents();

  // #1319 A9 — the only reader of the shadow participant table until the
  // reader flip: report divergence from the slot↔user join, never repair it.
  await logParticipantDrift();

  // Summary
  console.log("\n📊 Slot Availability Reconciliation Summary:");
  console.log(`   Tentative flags cleared: ${tentativeResult.cleared}`);
  console.log(`   Double bookings detected: ${doubleBookingResult.detected}`);
  console.log(
    `   Top-ups: ${topUpResult.placed} placed (${topUpResult.sessionsPlaced} session(s)), ` +
      `${topUpResult.noChange} unchanged, ${topUpResult.failed} failed of ${topUpResult.attempted} attempted`,
  );

  if (doubleBookingResult.detected > 0) {
    console.log("\n🚨 MANUAL INTERVENTION REQUIRED:");
    console.log("   Double bookings need to be resolved manually!");
  }

  return {
    success: allErrors.length === 0 && doubleBookingResult.detected === 0,
    tentativeFlagsCleared: tentativeResult.cleared,
    doubleBookingsDetected: doubleBookingResult.detected,
    doubleBookings: doubleBookingResult.bookings,
    topUps: topUpResult,
    errors: allErrors,
    timestamp: new Date().toISOString(),
  };
}

/**
 * #1319 A9 — compare AppointmentParticipant against the slot↔user join for
 * upcoming appointments. Log-only: the participant table is written by every
 * slot writer in the same transaction, so drift here means a writer was
 * missed, which is a bug to fix at the source rather than a row to patch.
 */
async function logParticipantDrift(): Promise<void> {
  const windowEnd = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
  const appointments = await prisma.appointment.findMany({
    where: {
      deletedAt: null,
      slotsOfAppointment: {
        some: { endsAt: { gt: new Date() }, startsAt: { lt: windowEnd } },
      },
    },
    select: {
      id: true,
      participants: { select: { userId: true, status: true } },
      // A cancelled or replaced slot keeps its user relation as history; only
      // live rows are the join-side truth the participant rows must match.
      slotsOfAppointment: {
        where: {
          deletedAt: null,
          completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] },
        },
        select: { user: { select: { id: true } } },
      },
    },
    take: 2000,
  });

  let drifted = 0;
  for (const appointment of appointments) {
    const joined = new Set(
      appointment.slotsOfAppointment.flatMap((s) => s.user.map((u) => u.id)),
    );
    const live = new Set(
      appointment.participants
        .filter((p) => p.status === "HELD" || p.status === "CONFIRMED")
        .map((p) => p.userId),
    );
    const onlyInJoin = [...joined].filter((id) => !live.has(id));
    const onlyInParticipants = [...live].filter((id) => !joined.has(id));
    if (onlyInJoin.length === 0 && onlyInParticipants.length === 0) continue;
    drifted++;
    console.log(
      JSON.stringify({
        event: "participant_drift",
        appointmentId: appointment.id,
        onlyInJoin,
        onlyInParticipants,
        timestamp: new Date().toISOString(),
      }),
    );
  }
  console.log(
    `   Participant drift: ${drifted} of ${appointments.length} upcoming appointments`,
  );
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
