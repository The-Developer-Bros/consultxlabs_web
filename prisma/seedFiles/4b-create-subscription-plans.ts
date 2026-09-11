import { faker } from "@faker-js/faker";
import { PlanEmailSupport, PlanLevel } from "@prisma/client";
import prisma from "../../lib/prisma";
import { UserWithProfiles } from "./1a-create-users";
import {
  FAQ_POOL,
  PLAN_SUBTITLES,
  SUBSCRIPTION_ROADMAP,
  TARGET_AUDIENCE_POOL,
  WHATS_INCLUDED_POOL,
  pick,
} from "./plan-content";

export async function createSubscriptionPlans(consultants: UserWithProfiles[]) {
  console.log(
    `Creating subscription plans for ${consultants.length} consultants...`,
  );
  for (let i = 0; i < consultants.length; i++) {
    const consultant = consultants[i];
    if (!consultant.consultantProfile) {
      console.warn(`Skipping consultant ${consultant.id} - no profile found`);
      continue;
    }
    // Trials are paid by default (₹100–₹200); the first couple of
    // consultants keep a free basic trial to exercise the ₹0 path.
    const basicTrialPriceInPaise =
      i < 2 ? 0 : faker.number.int({ min: 100, max: 150 }) * 100;
    const extendedTrialPriceInPaise =
      faker.number.int({ min: 150, max: 200 }) * 100;
    try {
      await prisma.subscriptionPlan.createMany({
        data: [
          {
            consultantProfileId: consultant.consultantProfile.id,
            title: "Basic Subscription",
            description:
              "Perfect for beginners. Get 1 call per week for 1 month to establish foundational knowledge and skills.",
            durationInMonths: 1,
            price: faker.number.int({ min: 990000, max: 1990000 }), // ₹9900-₹19900 in paise
            priceCurrency: "INR",
            sessionsPerWeek: 1,
            sessionDurationInHours: 1.0,
            totalSessions: 4, // 1 × 1 × 4
            totalHours: 4.0, // 4 × 1.0
            emailSupport: PlanEmailSupport.GENERAL,
            language: faker.helpers.arrayElement([
              "English",
              "Spanish",
              "French",
              "German",
              "Chinese",
            ]),
            level: PlanLevel.BEGINNER,
            subtitle: pick(PLAN_SUBTITLES, i),
            targetAudience: pick(TARGET_AUDIENCE_POOL, i),
            whatsIncluded: pick(WHATS_INCLUDED_POOL, i),
            prerequisites: "None",
            materialProvided: "Basic learning materials and resources",
            learningOutcomes: [
              "Understand basic concepts",
              "Gain practical skills",
              "Improve problem-solving abilities",
            ],
            trialEnabled: true,
            trialDurationMinutes: 30,
            trialPriceInPaise: basicTrialPriceInPaise,
          },
          {
            consultantProfileId: consultant.consultantProfile.id,
            title: "Extended Subscription",
            description:
              "Comprehensive learning program with 2 calls per week for 6 months. Ideal for intermediate learners seeking deeper expertise.",
            durationInMonths: 6,
            price: faker.number.int({ min: 3990000, max: 7990000 }), // ₹39900-₹79900 in paise
            priceCurrency: "INR",
            sessionsPerWeek: 2,
            sessionDurationInHours: 1.0,
            totalSessions: 48, // 2 × 6 × 4
            totalHours: 48.0, // 48 × 1.0
            emailSupport: PlanEmailSupport.PRIORITY,
            language: faker.helpers.arrayElement([
              "English",
              "Spanish",
              "French",
              "German",
              "Chinese",
            ]),
            level: PlanLevel.INTERMEDIATE,
            subtitle: pick(PLAN_SUBTITLES, i),
            targetAudience: pick(TARGET_AUDIENCE_POOL, i),
            whatsIncluded: pick(WHATS_INCLUDED_POOL, i),
            prerequisites: "Basic understanding of the subject area",
            materialProvided:
              "Comprehensive learning materials, templates, and resources",
            learningOutcomes: [
              "Master advanced techniques",
              "Develop strategic thinking",
              "Enhance decision-making skills",
              "Build practical expertise",
            ],
            trialEnabled: true,
            trialDurationMinutes: 45,
            trialPriceInPaise: extendedTrialPriceInPaise,
          },
          {
            consultantProfileId: consultant.consultantProfile.id,
            title: "Comprehensive Subscription",
            description:
              "Intensive program with 3 calls per week for 12 months. Designed for advanced learners and professionals seeking mastery.",
            durationInMonths: 12,
            price: faker.number.int({ min: 5990000, max: 9990000 }), // ₹59900-₹99900 in paise
            priceCurrency: "INR",
            sessionsPerWeek: 3,
            sessionDurationInHours: 1.0,
            totalSessions: 144, // 3 × 12 × 4
            totalHours: 144.0, // 144 × 1.0
            emailSupport: PlanEmailSupport.DEDICATED,
            language: faker.helpers.arrayElement([
              "English",
              "Spanish",
              "French",
              "German",
              "Chinese",
            ]),
            level: PlanLevel.ADVANCED,
            subtitle: pick(PLAN_SUBTITLES, i),
            targetAudience: pick(TARGET_AUDIENCE_POOL, i),
            whatsIncluded: pick(WHATS_INCLUDED_POOL, i),
            prerequisites: "Intermediate to advanced knowledge in the field",
            materialProvided:
              "Premium learning materials, exclusive templates, and personalized resources",
            learningOutcomes: [
              "Develop expertise in the field",
              "Create comprehensive strategies",
              "Implement best practices",
              "Achieve mastery level skills",
              "Build professional portfolio",
            ],
            trialEnabled: true,
            trialDurationMinutes: 60,
            trialPriceInPaise: 20000, // ₹200 — premium plan, premium trial
          },
        ],
      });

      // createMany cannot write nested relations, so the roadmap and FAQ are
      // attached in a second pass. Without this the week-by-week outline the
      // profile page already renders is empty in every local database.
      const created = await prisma.subscriptionPlan.findMany({
        where: { consultantProfileId: consultant.consultantProfile.id },
        select: { id: true, durationInMonths: true },
      });
      for (const [planIndex, plan] of created.entries()) {
        // Roughly four sessions a month, capped by the pool length.
        const sessionCount = Math.min(
          plan.durationInMonths * 4,
          SUBSCRIPTION_ROADMAP.length,
        );
        await prisma.subscriptionPlan.update({
          where: { id: plan.id },
          data: {
            subscriptionContents: {
              create: SUBSCRIPTION_ROADMAP.slice(0, sessionCount).map(
                (item, index) => ({ ...item, order: index + 1, hoursAllotted: 1 }),
              ),
            },
            faqs: {
              create: pick(FAQ_POOL, i + planIndex).map((faq, order) => ({
                ...faq,
                order,
              })),
            },
          },
        });
      }
    } catch (error) {
      console.error(
        `Failed to create subscription plans for consultant ${consultant.id}:`,
        error,
      );
    }
    if ((i + 1) % 10 === 0 || i === consultants.length - 1) {
      console.log(`Created subscription plans for ${i + 1} consultants`);
    }
  }
}
