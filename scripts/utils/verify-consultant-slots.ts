#!/usr/bin/env node

/**
 * Consultant Slots Verification Script
 *
 * Verifies availability slots, appointments, and schedule type for a specific consultant.
 * Used to debug slot allocation and booking issues.
 *
 * Usage:
 * - npm run scripts:verify-consultant-slots
 * - node scripts/verify-consultant-slots.ts
 */

import "dotenv/config";
import prisma from "@/lib/prisma";
import { minutesToTimeString } from "@/utils/slotAllocation/slotTimeUtils";

const CONSULTANT_ID = "31e2e9f4-c9d5-4c4c-b281-e8531da623dd";

// Date range from screenshot: Oct 5-11, 2025
const START_DATE = new Date("2025-10-05T00:00:00Z");
const END_DATE = new Date("2025-10-11T23:59:59Z");

async function verifyConsultantSlots() {
  console.log("🔍 Verifying consultant slots...\n");
  console.log("Consultant ID:", CONSULTANT_ID);
  console.log(
    "Date Range:",
    START_DATE.toISOString(),
    "to",
    END_DATE.toISOString(),
  );
  console.log("\n" + "=".repeat(80) + "\n");

  try {
    // 1. Get consultant profile
    const consultant = await prisma.consultantProfile.findUnique({
      where: { id: CONSULTANT_ID },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        subscriptionPlans: {
          orderBy: { durationInMonths: "asc" },
        },
      },
    });

    if (!consultant) {
      console.log("❌ Consultant not found!");
      return;
    }

    console.log("=== CONSULTANT PROFILE ===");
    console.log("Name:", consultant.user.name);
    console.log("Email:", consultant.user.email);
    console.log("Schedule Type:", consultant.scheduleType);
    console.log("Rating:", consultant.rating);
    console.log("\n");

    // 2. Get subscription plans
    console.log("=== SUBSCRIPTION PLANS ===");
    consultant.subscriptionPlans.forEach((plan) => {
      console.log(`\n📋 ${plan.title}`);
      console.log(`   Duration: ${plan.durationInMonths} months`);
      console.log(`   Calls/week: ${plan.sessionsPerWeek}`);
      console.log(`   Session: ${plan.sessionDurationInHours} hour(s)`);
      console.log(`   Price: $${(plan.price / 100).toFixed(2)}`);
      console.log(`   Email Support: ${plan.emailSupport}`);
    });
    console.log("\n");

    // 3. Get availability slots based on schedule type
    if (consultant.scheduleType === "WEEKLY") {
      const weeklySlots = await prisma.slotOfAvailabilityWeekly.findMany({
        where: { consultantProfileId: CONSULTANT_ID },
        orderBy: [{ startDay: "asc" }, { startTimeUtc: "asc" }],
      });

      console.log(
        `=== WEEKLY AVAILABILITY SLOTS (Total: ${weeklySlots.length}) ===`,
      );
      weeklySlots.forEach((slot, idx) => {
        console.log(`\nSlot ${idx + 1}:`);
        console.log(`  Day: ${slot.startDay}`);
        console.log(
          `  Time: ${minutesToTimeString(slot.startTimeUtc)} - ${minutesToTimeString(slot.endTimeUtc)} UTC`,
        );
        console.log(
          `  Start: ${slot.startDay} @ ${minutesToTimeString(slot.startTimeUtc)}`,
        );
        console.log(
          `  End: ${slot.endDay} @ ${minutesToTimeString(slot.endTimeUtc)}`,
        );
      });
    } else {
      const customSlots = await prisma.slotOfAvailabilityCustom.findMany({
        where: {
          consultantProfileId: CONSULTANT_ID,
          startsAt: {
            gte: START_DATE,
            lte: END_DATE,
          },
        },
        orderBy: { startsAt: "asc" },
      });

      console.log(
        `=== CUSTOM AVAILABILITY SLOTS (${START_DATE.toDateString()} - ${END_DATE.toDateString()}) ===`,
      );
      console.log(`Total slots in range: ${customSlots.length}\n`);
      customSlots.forEach((slot, idx) => {
        const startTime = new Date(slot.startsAt);
        const endTime = new Date(slot.endsAt);
        console.log(`Slot ${idx + 1}:`);
        console.log(`  ${startTime.toISOString()} - ${endTime.toISOString()}`);
      });
    }
    console.log("\n");

    // 4. Get all subscriptions for this consultant
    const subscriptions = await prisma.subscription.findMany({
      where: {
        subscriptionPlan: {
          consultantProfileId: CONSULTANT_ID,
        },
      },
      include: {
        subscriptionPlan: true,
        requestedBy: {
          include: {
            user: {
              select: {
                name: true,
                email: true,
              },
            },
          },
        },
        appointments: {
          include: {
            slotsOfAppointment: {
              where: {
                startsAt: {
                  gte: START_DATE,
                  lte: END_DATE,
                },
              },
              orderBy: { startsAt: "asc" },
            },
          },
        },
      },
    });

    console.log(`=== SUBSCRIPTIONS (Total: ${subscriptions.length}) ===`);
    subscriptions.forEach((sub, idx) => {
      console.log(`\nSubscription ${idx + 1}:`);
      console.log(`  ID: ${sub.id}`);
      console.log(`  Plan: ${sub.subscriptionPlan.title}`);
      console.log(`  Status: ${sub.status}`);
      console.log(
        `  Client: ${sub.requestedBy.user.name} (${sub.requestedBy.user.email})`,
      );
      console.log(`  Start: ${sub.schedulingPeriodStartsAt.toISOString()}`);
      console.log(`  End: ${sub.schedulingPeriodEndsAt.toISOString()}`);
      console.log(`  Appointments: ${sub.appointments.length}`);

      // Check if date range is in the future relative to subscription end date
      if (START_DATE > sub.schedulingPeriodEndsAt) {
        console.log(
          `  ⚠️ WARNING: Viewing dates (Oct 5-11, 2025) are AFTER subscription end date!`,
        );
        console.log(
          `     Subscription ends: ${sub.schedulingPeriodEndsAt.toISOString()}`,
        );
        console.log(`     Current view starts: ${START_DATE.toISOString()}`);
      }

      // Show slots for this subscription in the date range
      sub.appointments.forEach((appt, apptIdx) => {
        if (appt.slotsOfAppointment.length > 0) {
          console.log(`\n  Appointment ${apptIdx + 1} (${appt.id}):`);
          appt.slotsOfAppointment.forEach((slot) => {
            console.log(
              `    📅 ${slot.startsAt.toISOString()} - ${slot.endsAt.toISOString()}`,
            );
            console.log(`       Tentative: ${slot.isTentative}`);
          });
        }
      });
    });
    console.log("\n");

    // 5. Get all appointments in the date range for this consultant
    const appointments = await prisma.appointment.findMany({
      where: {
        slotsOfAppointment: {
          some: {
            startsAt: {
              gte: START_DATE,
              lte: END_DATE,
            },
          },
        },
        OR: [
          {
            consultation: {
              consultationPlan: {
                consultantProfileId: CONSULTANT_ID,
              },
            },
          },
          {
            subscription: {
              subscriptionPlan: {
                consultantProfileId: CONSULTANT_ID,
              },
            },
          },
          {
            webinar: {
              webinarPlan: {
                consultantProfileId: CONSULTANT_ID,
              },
            },
          },
          {
            class: {
              classPlan: {
                consultantProfileId: CONSULTANT_ID,
              },
            },
          },
        ],
      },
      include: {
        slotsOfAppointment: {
          where: {
            startsAt: {
              gte: START_DATE,
              lte: END_DATE,
            },
          },
          orderBy: { startsAt: "asc" },
        },
        consultation: {
          include: {
            consultationPlan: true,
          },
        },
        subscription: {
          include: {
            subscriptionPlan: true,
          },
        },
      },
    });

    console.log(
      `=== APPOINTMENTS IN DATE RANGE (Total: ${appointments.length}) ===`,
    );
    appointments.forEach((appt, idx) => {
      console.log(`\nAppointment ${idx + 1}:`);
      console.log(`  ID: ${appt.id}`);
      console.log(`  Type: ${appt.appointmentType}`);

      if (appt.consultation) {
        console.log(`  Plan: ${appt.consultation.consultationPlan.title}`);
      } else if (appt.subscription) {
        console.log(`  Plan: ${appt.subscription.subscriptionPlan.title}`);
      }

      console.log(`  Slots in range: ${appt.slotsOfAppointment.length}`);
      appt.slotsOfAppointment.forEach((slot) => {
        const day = slot.startsAt.toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
        });
        const time = slot.startsAt.toISOString().slice(11, 16);
        console.log(
          `    🔒 ${day} ${time} UTC ${slot.isTentative ? "(TENTATIVE)" : "(CONFIRMED)"}`,
        );
      });
    });
    console.log("\n");

    // 6. Summary
    console.log("=== VERIFICATION SUMMARY ===");
    console.log(`✓ Schedule Type: ${consultant.scheduleType}`);
    console.log(`✓ Total Subscriptions: ${subscriptions.length}`);
    console.log(`✓ Total Appointments in range: ${appointments.length}`);

    // Check for critical issue
    const hasActiveSubscriptionsOutsideRange = subscriptions.some(
      (sub) => START_DATE > sub.schedulingPeriodEndsAt,
    );

    if (hasActiveSubscriptionsOutsideRange) {
      console.log("\n⚠️ CRITICAL ISSUE DETECTED:");
      console.log(
        "   Viewing Oct 5-11, 2025 but subscription ends Aug 27, 2025",
      );
      console.log("   All slots should be DISABLED (outside allowed period)");
      console.log(
        "   If slots show as 'Available', this is a BUG in the frontend validation!",
      );
    }
  } catch (error) {
    console.error("❌ Verification failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the verification if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  verifyConsultantSlots()
    .then(() => {
      console.log("\n✅ Verification completed");
      process.exit(0);
    })
    .catch((error) => {
      console.error("\n💥 Verification failed:", error);
      process.exit(1);
    });
}

export { verifyConsultantSlots };
