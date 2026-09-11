#!/usr/bin/env node

/**
 * Investigate Sunday Slots Issue
 *
 * Checks why Sunday slots appear in the calendar when consultant has no Sunday availability
 */

import "dotenv/config";
import { DayOfWeek } from "@prisma/client";
import prisma from "@/lib/prisma";
import { minutesToTimeString } from "@/utils/slotAllocation/slotTimeUtils";

const CONSULTANT_ID = "31e2e9f4-c9d5-4c4c-b281-e8531da623dd";
const SUBSCRIPTION_ID = "cmgflwuvk03nymf4gysztdb19"; // Extended subscription with Aug dates

async function investigateSundaySlots() {
  console.log("🔍 Investigating Sunday Slots Issue...\n");

  try {
    // 1. Check for any Sunday slots for this consultant
    const sundaySlots = await prisma.slotOfAvailabilityWeekly.findMany({
      where: {
        consultantProfileId: CONSULTANT_ID,
        startDay: DayOfWeek.SUNDAY,
      },
    });

    console.log("=== SUNDAY SLOTS IN DATABASE ===");
    console.log(`Total Sunday slots found: ${sundaySlots.length}`);
    if (sundaySlots.length > 0) {
      console.log("❌ ERROR: Consultant should NOT have Sunday slots!");
      sundaySlots.forEach((slot, idx) => {
        console.log(`\nSlot ${idx + 1}:`);
        console.log(
          `  Start: ${slot.startDay} @ ${minutesToTimeString(slot.startTimeUtc)}`,
        );
        console.log(
          `  End: ${slot.endDay} @ ${minutesToTimeString(slot.endTimeUtc)}`,
        );
      });
    } else {
      console.log("✅ Correct: No Sunday slots in database");
    }
    console.log("\n");

    // 2. Get the specific subscription details
    const subscription = await prisma.subscription.findUnique({
      where: { id: SUBSCRIPTION_ID },
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
              orderBy: { startsAt: "asc" },
            },
          },
        },
      },
    });

    if (!subscription) {
      console.log("❌ Subscription not found!");
      return;
    }

    console.log("=== SUBSCRIPTION DETAILS ===");
    console.log(`ID: ${subscription.id}`);
    console.log(`Plan: ${subscription.subscriptionPlan.title}`);
    console.log(`Status: ${subscription.status}`);
    console.log(`Client: ${subscription.requestedBy.user.name}`);
    console.log(
      `Start: ${subscription.schedulingPeriodStartsAt.toISOString()}`,
    );
    console.log(`End: ${subscription.schedulingPeriodEndsAt.toISOString()}`);
    console.log(`\nIn IST (UTC+5:30):`);
    console.log(
      `Start: ${new Date(subscription.schedulingPeriodStartsAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`,
    );
    console.log(
      `End: ${new Date(subscription.schedulingPeriodEndsAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`,
    );
    console.log("\n");

    // 3. Check all appointment slots for this subscription
    console.log("=== ALL APPOINTMENT SLOTS FOR THIS SUBSCRIPTION ===");
    console.log(`Total Appointments: ${subscription.appointments.length}\n`);

    subscription.appointments.forEach((appt, idx) => {
      console.log(`Appointment ${idx + 1} (${appt.id}):`);
      console.log(`  Total slots: ${appt.slotsOfAppointment.length}`);

      appt.slotsOfAppointment.forEach((slot) => {
        const startDate = new Date(slot.startsAt);
        const dayOfWeek = startDate.toLocaleDateString("en-US", {
          weekday: "long",
        });
        const istTime = startDate.toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
        });

        // Check if slot is outside subscription period
        const isBeforeStart = startDate < subscription.schedulingPeriodStartsAt;
        const isAfterEnd = startDate > subscription.schedulingPeriodEndsAt;
        const isOutside = isBeforeStart || isAfterEnd;

        console.log(`    📅 ${slot.startsAt.toISOString()}`);
        console.log(`       Day: ${dayOfWeek}`);
        console.log(`       IST: ${istTime}`);
        console.log(`       Tentative: ${slot.isTentative}`);

        if (isOutside) {
          console.log(`       ⚠️  WARNING: OUTSIDE SUBSCRIPTION PERIOD!`);
          if (isBeforeStart) {
            console.log(
              `           ${((subscription.schedulingPeriodStartsAt.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)).toFixed(1)} days before start`,
            );
          } else {
            console.log(
              `           ${((startDate.getTime() - subscription.schedulingPeriodEndsAt.getTime()) / (1000 * 60 * 60 * 24)).toFixed(1)} days after end`,
            );
          }
        }

        // Check if it's a Sunday
        if (dayOfWeek === "Sunday") {
          console.log(
            `       🔴 CRITICAL: This is a SUNDAY slot! Should not exist!`,
          );
        }
      });
      console.log();
    });

    // 4. Check if there are other subscriptions with appointments in August for this consultant
    const augustStart = new Date("2025-08-01T00:00:00Z");
    const augustEnd = new Date("2025-08-31T23:59:59Z");

    const augustAppointments = await prisma.appointment.findMany({
      where: {
        subscription: {
          subscriptionPlan: {
            consultantProfileId: CONSULTANT_ID,
          },
        },
        slotsOfAppointment: {
          some: {
            startsAt: {
              gte: augustStart,
              lte: augustEnd,
            },
          },
        },
      },
      include: {
        subscription: {
          include: {
            subscriptionPlan: true,
            requestedBy: {
              include: {
                user: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },
        },
        slotsOfAppointment: {
          where: {
            startsAt: {
              gte: augustStart,
              lte: augustEnd,
            },
          },
          orderBy: { startsAt: "asc" },
        },
      },
    });

    console.log("=== OTHER APPOINTMENTS IN AUGUST 2025 ===");
    console.log(
      `Total appointments with August slots: ${augustAppointments.length}\n`,
    );

    augustAppointments.forEach((appt, idx) => {
      if (appt.subscription) {
        console.log(`Appointment ${idx + 1}:`);
        console.log(`  Subscription ID: ${appt.subscription.id}`);
        console.log(`  Plan: ${appt.subscription.subscriptionPlan.title}`);
        console.log(`  Client: ${appt.subscription.requestedBy.user.name}`);
        console.log(
          `  Subscription Period: ${appt.subscription.schedulingPeriodStartsAt.toISOString()} to ${appt.subscription.schedulingPeriodEndsAt.toISOString()}`,
        );
        console.log(`  August Slots: ${appt.slotsOfAppointment.length}`);

        appt.slotsOfAppointment.forEach((slot) => {
          const dayOfWeek = new Date(slot.startsAt).toLocaleDateString(
            "en-US",
            { weekday: "short" },
          );
          const istTime = new Date(slot.startsAt).toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          });
          console.log(
            `    ${dayOfWeek} ${istTime} ${slot.isTentative ? "(TENTATIVE)" : "(CONFIRMED)"}`,
          );
        });
        console.log();
      }
    });
  } catch (error) {
    console.error("❌ Investigation failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the investigation if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  investigateSundaySlots()
    .then(() => {
      console.log("\n✅ Investigation completed");
      process.exit(0);
    })
    .catch((error) => {
      console.error("\n💥 Investigation failed:", error);
      process.exit(1);
    });
}

export { investigateSundaySlots };
