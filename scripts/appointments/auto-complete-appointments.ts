/**
 * Auto-Complete Appointments - Core Logic
 *
 * Automatically marks appointments as COMPLETED after their session time ends.
 * For Webinars/Classes: Updates status to COMPLETED.
 * For Consultations/Subscriptions: Updates status to COMPLETED.
 *
 * This enables:
 * - Feedback collection from participants
 * - Final billing/payout processing
 * - Accurate reporting
 *
 * This module exports the core function.
 * It is imported by:
 * - jobs/auto-complete-appointments.ts (GitHub Actions)
 * - app/api/cleanup/auto-complete-appointments/route.ts (API endpoint)
 *
 * Schedule: Hourly, at :07.
 *
 * One consultation it deliberately does not complete: a paid session the
 * consultant never joined belongs to `detect-consultant-no-shows` (:57), which
 * cancels and refunds it. Both jobs classify attendance through
 * `lib/booking/attendance.ts` so their candidate sets partition instead of
 * racing (#1504).
 */

import prisma from "../../lib/prisma";
import {
  WebinarStatus,
  ClassStatus,
  AppointmentStatus,
  SlotCompletionStatus,
  TrialSessionStatus,
  Prisma,
} from "@prisma/client";
import { notifyAppointmentCompleted } from "../../lib/novu/service";
import { notificationScope } from "../../lib/novu/workflows";
import { notificationHref } from "../../lib/novu/resolve-href";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import {
  EVENT_ALLOWED_FROM,
  REQUEST_ALLOWED_FROM,
  transitionTrialSession,
} from "@/lib/booking/transitions";
import { transitionSlotsInChunks } from "@/lib/booking/slot-release";
import {
  classifyConsultantAttendance,
  isPastNoShowHandoff,
} from "@/lib/booking/attendance";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";

// Only complete appointments that ended at least 1 hour ago
// This gives buffer time for any post-session activities
const COMPLETION_BUFFER_HOURS = 1;
// Slot rows each completion pass moves per run; the next hourly run continues.
const MAX_SLOT_COMPLETIONS_PER_RUN = 2000;

export interface AutoCompleteResult {
  success: boolean;
  webinarsCompleted: number;
  classesCompleted: number;
  consultationsCompleted: number;
  subscriptionsCompleted: number;
  trialsCompleted: number;
  errors: string[];
  timestamp: string;
}

/**
 * Auto-complete webinars that have ended
 */
async function completeWebinars(): Promise<{
  completed: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let completed = 0;

  const bufferTime = new Date(
    Date.now() - COMPLETION_BUFFER_HOURS * 60 * 60 * 1000,
  );

  // Find SCHEDULED or IN_PROGRESS webinars where all slots have ended
  const webinarsToComplete = await prisma.webinar.findMany({
    where: {
      status: { in: [WebinarStatus.SCHEDULED, WebinarStatus.IN_PROGRESS] },
      appointment: {
        slotsOfAppointment: {
          some: {
            endsAt: { lt: bufferTime },
          },
          every: {
            endsAt: { lt: bufferTime },
          },
        },
      },
    },
    include: {
      webinarPlan: { select: { title: true } },
      appointment: {
        include: {
          slotsOfAppointment: {
            orderBy: { endsAt: "desc" },
            take: 1,
          },
        },
      },
    },
  });

  console.log(`Found ${webinarsToComplete.length} webinars to auto-complete`);

  for (const webinar of webinarsToComplete) {
    try {
      const lastSlot = webinar.appointment?.slotsOfAppointment[0];
      console.log(`\nCompleting webinar ${webinar.id}`);
      console.log(`   Title: ${webinar.webinarPlan.title}`);
      console.log(`   Previous status: ${webinar.status}`);
      console.log(
        `   Last slot ended: ${lastSlot?.endsAt?.toISOString() || "Unknown"}`,
      );

      // CAS (#1319): a webinar cancelled since the cohort read must not be
      // resurrected as COMPLETED — that would release earnings for nothing.
      const moved = await prisma.webinar.updateMany({
        where: { id: webinar.id, status: { in: EVENT_ALLOWED_FROM.COMPLETED } },
        data: { status: WebinarStatus.COMPLETED },
      });
      if (moved.count === 0) {
        console.log(`   ⏭️ Skipped — status changed since the sweep read`);
        continue;
      }

      console.log(`   ✅ Marked as COMPLETED`);
      completed++;
    } catch (error) {
      const msg = `Failed to complete webinar ${webinar.id}: ${error}`;
      console.error(`   ❌ ${msg}`);
      errors.push(msg);
    }
  }

  return { completed, errors };
}

/**
 * Auto-complete classes that have ended (all sessions done)
 */
async function completeClasses(): Promise<{
  completed: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let completed = 0;

  const bufferTime = new Date(
    Date.now() - COMPLETION_BUFFER_HOURS * 60 * 60 * 1000,
  );

  // Find SCHEDULED or IN_PROGRESS classes where all slots have ended
  const classesToComplete = await prisma.class.findMany({
    where: {
      status: { in: [ClassStatus.SCHEDULED, ClassStatus.IN_PROGRESS] },
      appointments: {
        some: {
          slotsOfAppointment: {
            some: {
              endsAt: { lt: bufferTime },
            },
          },
        },
        every: {
          slotsOfAppointment: {
            every: {
              endsAt: { lt: bufferTime },
            },
          },
        },
      },
    },
    include: {
      classPlan: { select: { title: true } },
      appointments: {
        include: {
          slotsOfAppointment: {
            orderBy: { endsAt: "desc" },
            take: 1,
          },
        },
      },
    },
  });

  console.log(`Found ${classesToComplete.length} classes to auto-complete`);

  for (const cls of classesToComplete) {
    try {
      // Find the latest slot end time across all appointments
      let latestEnd: Date | null = null;
      for (const apt of cls.appointments) {
        const slot = apt.slotsOfAppointment[0];
        if (slot && (!latestEnd || slot.endsAt > latestEnd)) {
          latestEnd = slot.endsAt;
        }
      }

      console.log(`\nCompleting class ${cls.id}`);
      console.log(`   Title: ${cls.classPlan.title}`);
      console.log(`   Previous status: ${cls.status}`);
      console.log(
        `   Last slot ended: ${latestEnd?.toISOString() || "Unknown"}`,
      );

      // CAS (#1319) — same reasoning as the webinar arm above.
      const moved = await prisma.class.updateMany({
        where: { id: cls.id, status: { in: EVENT_ALLOWED_FROM.COMPLETED } },
        data: { status: ClassStatus.COMPLETED },
      });
      if (moved.count === 0) {
        console.log(`   ⏭️ Skipped — status changed since the sweep read`);
        continue;
      }

      console.log(`   ✅ Marked as COMPLETED`);
      completed++;
    } catch (error) {
      const msg = `Failed to complete class ${cls.id}: ${error}`;
      console.error(`   ❌ ${msg}`);
      errors.push(msg);
    }
  }

  return { completed, errors };
}

/**
 * Auto-complete consultations that have ended
 */
async function completeConsultations(): Promise<{
  completed: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let completed = 0;

  const bufferTime = new Date(
    Date.now() - COMPLETION_BUFFER_HOURS * 60 * 60 * 1000,
  );

  // Find APPROVED or SCHEDULED consultations where all slots have ended
  const consultationsToComplete = await prisma.consultation.findMany({
    where: {
      status: { in: [AppointmentStatus.APPROVED, AppointmentStatus.SCHEDULED] },
      appointment: {
        slotsOfAppointment: {
          some: {
            endsAt: { lt: bufferTime },
          },
          every: {
            endsAt: { lt: bufferTime },
          },
        },
      },
    },
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
      appointment: {
        include: {
          // #1504 — every slot, not just the latest, because the no-show
          // handoff below is decided from the attendance rows across all of
          // this booking's sessions. Still ordered newest-first, so `[0]` is
          // the last slot the logging and the deadline both want.
          slotsOfAppointment: {
            orderBy: { endsAt: "desc" },
            include: {
              meetingSession: {
                select: { attendances: { select: { userId: true } } },
              },
            },
          },
        },
      },
    },
  });

  console.log(
    `Found ${consultationsToComplete.length} consultations to auto-complete`,
  );

  for (const consultation of consultationsToComplete) {
    try {
      const lastSlot = consultation.appointment?.slotsOfAppointment[0];
      const consultantUserId =
        consultation.consultationPlan?.consultantProfile?.userId;
      const consulteeUserId = consultation.requestedBy?.userId;
      console.log(`\nCompleting consultation ${consultation.id}`);
      console.log(`   Title: ${consultation.consultationPlan.title}`);
      console.log(`   Previous status: ${consultation.status}`);
      console.log(
        `   Last slot ended: ${lastSlot?.endsAt?.toISOString() || "Unknown"}`,
      );

      // #1504 — the consultant no-show refund is only ever issued by
      // detect-consultant-no-shows, which reads the same two statuses this
      // sweep does. This one's buffer is an hour and that one's grace window is
      // two, so completing an unattended consultation here removed it from the
      // only job that could refund it, and the promised refund could never
      // fire. A booking in the no-show shape is left alone until the handoff
      // deadline, after which it completes regardless so a candidate the
      // detector declined (Stream contradicted our rows, or nobody joined at
      // all) cannot be stranded live forever.
      if (consultantUserId && consulteeUserId) {
        const verdict = classifyConsultantAttendance(
          consultation.appointment?.slotsOfAppointment ?? [],
          { consultantUserId, consulteeUserId },
        );
        if (
          verdict === "consultant-absent" &&
          !isPastNoShowHandoff(lastSlot?.endsAt)
        ) {
          console.log(
            `   ⏭️ Deferred — no consultant join yet; detect-consultant-no-shows owns it`,
          );
          continue;
        }
      }

      // #836 — guard rides the WHERE: a cancel landing between the sweep's
      // read and this write must not be overwritten by COMPLETED.
      const moved = await prisma.consultation.updateMany({
        where: {
          id: consultation.id,
          status: { in: REQUEST_ALLOWED_FROM.COMPLETED },
        },
        data: { status: AppointmentStatus.COMPLETED },
      });
      if (moved.count === 0) {
        console.log(`   ⏭️ Skipped — status changed since sweep read`);
        continue;
      }

      console.log(`   ✅ Marked as COMPLETED`);
      completed++;

      // Fire-and-forget: notify both parties (non-blocking)
      const userIds = [consultantUserId, consulteeUserId].filter(
        (id): id is string => !!id,
      );
      if (userIds.length > 0) {
        void notifyAppointmentCompleted(userIds, {
          ...notificationScope(consultation.appointment?.organizationId),
          appointmentType: "consultation",
          consultantName:
            consultation.consultationPlan?.consultantProfile?.user?.name ??
            "Consultant",
          consulteeName: consultation.requestedBy?.user?.name ?? "Consultee",
          planTitle: consultation.consultationPlan.title,
          dashboardUrl: notificationHref(
            consultation.appointment?.organizationId,
            "appointments",
          ),
        }).catch((error) =>
          console.error(
            `[auto-complete] Failed to send consultation completion notification:`,
            error,
          ),
        );
      }
    } catch (error) {
      const msg = `Failed to complete consultation ${consultation.id}: ${error}`;
      console.error(`   ❌ ${msg}`);
      errors.push(msg);
    }
  }

  return { completed, errors };
}

/**
 * Auto-complete subscriptions that have ended (all sessions done)
 */
async function completeSubscriptions(): Promise<{
  completed: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let completed = 0;

  const bufferTime = new Date(
    Date.now() - COMPLETION_BUFFER_HOURS * 60 * 60 * 1000,
  );

  // Find APPROVED or SCHEDULED subscriptions where all slots have ended
  const subscriptionsToComplete = await prisma.subscription.findMany({
    where: {
      status: { in: [AppointmentStatus.APPROVED, AppointmentStatus.SCHEDULED] },
      appointments: {
        some: {
          slotsOfAppointment: {
            some: {
              endsAt: { lt: bufferTime },
            },
          },
        },
        every: {
          slotsOfAppointment: {
            every: {
              endsAt: { lt: bufferTime },
            },
          },
        },
      },
    },
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
      appointments: {
        include: {
          slotsOfAppointment: {
            orderBy: { endsAt: "desc" },
            take: 1,
          },
        },
      },
    },
  });

  console.log(
    `Found ${subscriptionsToComplete.length} subscriptions to auto-complete`,
  );

  for (const subscription of subscriptionsToComplete) {
    try {
      // Find the latest slot end time across all appointments
      let latestEnd: Date | null = null;
      for (const apt of subscription.appointments) {
        const slot = apt.slotsOfAppointment[0];
        if (slot && (!latestEnd || slot.endsAt > latestEnd)) {
          latestEnd = slot.endsAt;
        }
      }

      console.log(`\nCompleting subscription ${subscription.id}`);
      console.log(`   Title: ${subscription.subscriptionPlan.title}`);
      console.log(`   Previous status: ${subscription.status}`);
      console.log(
        `   Last slot ended: ${latestEnd?.toISOString() || "Unknown"}`,
      );

      // #836 — guard rides the WHERE: a cancel landing between the sweep's
      // read and this write must not be overwritten by COMPLETED.
      const moved = await prisma.subscription.updateMany({
        where: {
          id: subscription.id,
          status: { in: REQUEST_ALLOWED_FROM.COMPLETED },
        },
        data: { status: AppointmentStatus.COMPLETED },
      });
      if (moved.count === 0) {
        console.log(`   ⏭️ Skipped — status changed since sweep read`);
        continue;
      }

      console.log(`   ✅ Marked as COMPLETED`);
      completed++;

      // Fire-and-forget: notify both parties (non-blocking)
      const consultantUserId =
        subscription.subscriptionPlan?.consultantProfile?.userId;
      const consulteeUserId = subscription.requestedBy?.userId;
      const userIds = [consultantUserId, consulteeUserId].filter(
        (id): id is string => !!id,
      );
      if (userIds.length > 0) {
        void notifyAppointmentCompleted(userIds, {
          ...notificationScope(subscription.appointments[0]?.organizationId),
          appointmentType: "subscription",
          consultantName:
            subscription.subscriptionPlan?.consultantProfile?.user?.name ??
            "Consultant",
          consulteeName: subscription.requestedBy?.user?.name ?? "Consultee",
          planTitle: subscription.subscriptionPlan.title,
          dashboardUrl: notificationHref(
            subscription.appointments[0]?.organizationId,
            "appointments",
          ),
        }).catch((error) =>
          console.error(
            `[auto-complete] Failed to send subscription completion notification:`,
            error,
          ),
        );
      }
    } catch (error) {
      const msg = `Failed to complete subscription ${subscription.id}: ${error}`;
      console.error(`   ❌ ${msg}`);
      errors.push(msg);
    }
  }

  return { completed, errors };
}

/**
 * Auto-complete trial sessions that have ended
 */
async function completeTrials(): Promise<{
  completed: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let completed = 0;

  const bufferTime = new Date(
    Date.now() - COMPLETION_BUFFER_HOURS * 60 * 60 * 1000,
  );

  // Find SCHEDULED trials where the appointment slot has ended
  const trialsToComplete = await prisma.trialSession.findMany({
    where: {
      status: TrialSessionStatus.SCHEDULED,
      appointment: {
        slotsOfAppointment: {
          some: {
            endsAt: { lt: bufferTime },
          },
          every: {
            endsAt: { lt: bufferTime },
          },
        },
      },
    },
    include: {
      subscriptionPlan: { select: { title: true } },
      consulteeProfile: {
        include: {
          user: {
            select: { id: true, name: true, image: true },
          },
        },
      },
      appointment: {
        include: {
          slotsOfAppointment: {
            orderBy: { endsAt: "desc" },
            take: 1,
          },
        },
      },
    },
  });

  console.log(`Found ${trialsToComplete.length} trials to auto-complete`);

  for (const trial of trialsToComplete) {
    try {
      const lastSlot = trial.appointment?.slotsOfAppointment[0];
      console.log(`\nCompleting trial ${trial.id}`);
      console.log(`   Plan: ${trial.subscriptionPlan.title}`);
      console.log(`   Consultee: ${trial.consulteeProfile.user.name}`);
      console.log(`   Previous status: ${trial.status}`);
      console.log(
        `   Last slot ended: ${lastSlot?.endsAt?.toISOString() || "Unknown"}`,
      );

      // CAS (#1319): a trial cancelled or converted since the read stays put.
      try {
        await transitionTrialSession(prisma, {
          where: { id: trial.id },
          to: TrialSessionStatus.COMPLETED,
          data: { completedAt: new Date() },
        });
      } catch (error) {
        if (!(error instanceof IllegalTransitionError)) throw error;
        console.log(`   ⏭️ Skipped — status changed since the sweep read`);
        continue;
      }

      // Log activity for trial completion
      try {
        await prisma.activityLog.create({
          data: {
            activityType: "TRIAL_COMPLETED",
            description: `Completed trial session with ${trial.consulteeProfile.user.name}: ${trial.subscriptionPlan.title}`,
            actorId: trial.consulteeProfile.user.id,
            actorName: trial.consulteeProfile.user.name,
            actorImage: trial.consulteeProfile.user.image,
            consultantProfileId: trial.consultantProfileId,
            trialSessionId: trial.id,
            metadata: {
              planTitle: trial.subscriptionPlan.title,
              autoCompleted: true,
            },
          },
        });
      } catch (activityError) {
        console.warn(`   ⚠️ Failed to log activity: ${activityError}`);
      }

      console.log(`   ✅ Marked as COMPLETED`);
      completed++;
    } catch (error) {
      const msg = `Failed to complete trial ${trial.id}: ${error}`;
      console.error(`   ❌ ${msg}`);
      errors.push(msg);
    }
  }

  return { completed, errors };
}

/**
 * Mark individual SlotOfAppointment records with per-slot completion status.
 * Runs BEFORE parent-level completion so that parent logic can rely on slot statuses.
 *
 * - Slots past buffer WITH MeetingSession.endedAt → COMPLETED
 * - Slots past buffer WITHOUT MeetingSession → UNVERIFIED (may be offline sessions)
 */
async function completeIndividualSlots(): Promise<{
  completed: number;
  unverified: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const bufferTime = new Date(
    Date.now() - COMPLETION_BUFFER_HOURS * 60 * 60 * 1000,
  );

  // Doctrine rule 1: the completion column had no CAS here, and the WHERE
  // reached rows it has no business touching. A tentative hold is an unpaid
  // reservation, not a session, so a past-dated one was being stamped
  // UNVERIFIED and thereby put out of reach of the sweeps that free it; a
  // tombstoned row was being re-stamped after it had already been released.
  // Both guards ride the CAS WHERE alongside the from-set.
  const liveHeldSlot = {
    endsAt: { lt: bufferTime },
    isTentative: false,
    deletedAt: null,
  };
  // The from-set is SCHEDULED only, narrower than the maps' defaults: this
  // cron is a fallback for a missed webhook and must never lift a slot a
  // human parked at UNVERIFIED or pulled back from COMPLETED.
  const fromScheduled = [SlotCompletionStatus.SCHEDULED];

  try {
    // One transaction for the three passes: the helper writes the status and
    // then its history rows, and a slot must never be COMPLETED or UNVERIFIED
    // without the audit row that says why.
    // Each pass reads a bounded, oldest-first cohort of SCHEDULED slots and
    // moves it in chunked transactions, so a backlog can never outlive one
    // transaction's timeout and roll back with its history rows.
    const runPass = async (
      predicate: Prisma.SlotOfAppointmentWhereInput,
      to: SlotCompletionStatus,
      data?: { completedAt: Date },
    ): Promise<number> => {
      const cohort = await prisma.slotOfAppointment.findMany({
        where: {
          ...liveHeldSlot,
          ...predicate,
          completionStatus: SlotCompletionStatus.SCHEDULED,
        },
        select: { id: true },
        orderBy: { endsAt: "asc" },
        take: MAX_SLOT_COMPLETIONS_PER_RUN,
      });
      return transitionSlotsInChunks(
        cohort.map((s) => s.id),
        (idChunk) => ({
          where: { id: { in: idChunk }, ...liveHeldSlot, ...predicate },
          to,
          ...(data ? { data } : {}),
          fromIn: fromScheduled,
          allowZero: true,
        }),
      );
    };
    const completedCount = await runPass(
      { meetingSession: { endedAt: { not: null } } },
      SlotCompletionStatus.COMPLETED,
      { completedAt: new Date() },
    );
    const unverifiedCount = await runPass(
      { meetingSession: null },
      SlotCompletionStatus.UNVERIFIED,
    );
    const orphanedCount = await runPass(
      { meetingSession: { endedAt: null } },
      SlotCompletionStatus.UNVERIFIED,
    );
    if (completedCount > 0 || unverifiedCount > 0 || orphanedCount > 0) {
      console.log(
        `   Slot-level: ${completedCount} completed, ${unverifiedCount + orphanedCount} unverified (${orphanedCount} orphaned)`,
      );
    }

    return {
      completed: completedCount,
      unverified: unverifiedCount + orphanedCount,
      errors,
    };
  } catch (error) {
    const message = `Failed to complete individual slots: ${error instanceof Error ? error.message : "Unknown error"}`;
    console.error(`   ❌ ${message}`);
    errors.push(message);
    return { completed: 0, unverified: 0, errors };
  }
}

/**
 * Main function to auto-complete all eligible appointments
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open: repeat-safe side effects, lock is belt-and-braces.
export async function autoCompleteAppointments(): Promise<AutoCompleteResult> {
  return withCronLock("auto-complete-appointments", { failMode: "open" }, () =>
    autoCompleteAppointmentsUnlocked(),
  );
}

async function autoCompleteAppointmentsUnlocked(): Promise<AutoCompleteResult> {
  const allErrors: string[] = [];

  console.log("🔄 Starting auto-complete appointments scan...");
  console.log(
    `   Buffer time: ${COMPLETION_BUFFER_HOURS} hour(s) after session end`,
  );

  // Complete individual slots first (per-slot status before parent-level)
  const slotResult = await completeIndividualSlots();
  allErrors.push(...slotResult.errors);

  // Complete webinars
  const webinarResult = await completeWebinars();
  allErrors.push(...webinarResult.errors);

  // Complete classes
  const classResult = await completeClasses();
  allErrors.push(...classResult.errors);

  // Complete consultations
  const consultationResult = await completeConsultations();
  allErrors.push(...consultationResult.errors);

  // Complete subscriptions
  const subscriptionResult = await completeSubscriptions();
  allErrors.push(...subscriptionResult.errors);

  // Complete trial sessions
  const trialResult = await completeTrials();
  allErrors.push(...trialResult.errors);

  // Summary
  console.log("\n📊 Auto-Complete Summary:");
  console.log(
    `   Slots: ${slotResult.completed} completed, ${slotResult.unverified} unverified`,
  );
  console.log(`   Webinars completed: ${webinarResult.completed}`);
  console.log(`   Classes completed: ${classResult.completed}`);
  console.log(`   Consultations completed: ${consultationResult.completed}`);
  console.log(`   Subscriptions completed: ${subscriptionResult.completed}`);
  console.log(`   Trials completed: ${trialResult.completed}`);

  if (allErrors.length > 0) {
    console.log("\n⚠️ Errors encountered:");
    allErrors.forEach((e) => console.log(`   - ${e}`));
  }

  return {
    success: allErrors.length === 0,
    webinarsCompleted: webinarResult.completed,
    classesCompleted: classResult.completed,
    consultationsCompleted: consultationResult.completed,
    subscriptionsCompleted: subscriptionResult.completed,
    trialsCompleted: trialResult.completed,
    errors: allErrors,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
