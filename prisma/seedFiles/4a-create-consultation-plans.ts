import { UserWithProfiles } from "./1a-create-users";
import prisma from "../../lib/prisma";
import { faker } from "@faker-js/faker";
import { PlanLevel } from "@prisma/client";
import {
  FAQ_POOL,
  PLAN_SUBTITLES,
  TARGET_AUDIENCE_POOL,
  WHATS_INCLUDED_POOL,
  pick,
} from "./plan-content";

export async function createConsultationPlans(consultants: UserWithProfiles[]) {
  console.log(
    `Creating consultation plans for ${consultants.length} consultants...`,
  );
  for (let i = 0; i < consultants.length; i++) {
    const consultant = consultants[i];
    if (!consultant.consultantProfile) {
      console.warn(`Skipping consultant ${consultant.id} - no profile found`);
      continue;
    }
    try {
      await prisma.consultationPlan.createMany({
        data: [
          {
            consultantProfileId: consultant.consultantProfile.id,
            title: "Basic Consultation",
            description:
              "A focused one-hour session designed to address your immediate questions and provide actionable guidance. Ideal for first-time clients looking for expert advice on a specific topic.",
            durationInHours: 1,
            price: faker.number.int({ min: 200000, max: 500000 }), // ₹2000-₹5000 in paise
            priceCurrency: "INR",
            language: "English",
            level: faker.helpers.arrayElement([
              PlanLevel.BEGINNER,
              PlanLevel.INTERMEDIATE,
              PlanLevel.ADVANCED,
            ]),
            subtitle: pick(PLAN_SUBTITLES, i),
            targetAudience: pick(TARGET_AUDIENCE_POOL, i),
            whatsIncluded: pick(WHATS_INCLUDED_POOL, i),
            prerequisites: "No prior experience required",
            materialProvided: "Session summary and recommended resources",
            learningOutcomes: faker.helpers.arrayElements(
              [
                "Understand basic concepts",
                "Gain practical skills",
                "Improve problem-solving abilities",
              ],
              { min: 1, max: 3 },
            ),
          },
          {
            consultantProfileId: consultant.consultantProfile.id,
            title: "Extended Consultation",
            description:
              "An in-depth two-hour session for clients who need a thorough review of their goals and a detailed action plan. Includes follow-up notes and personalised recommendations.",
            durationInHours: 2,
            price: faker.number.int({ min: 400000, max: 1000000 }), // ₹4000-₹10000 in paise
            priceCurrency: "INR",
            language: "English",
            level: faker.helpers.arrayElement([
              PlanLevel.BEGINNER,
              PlanLevel.INTERMEDIATE,
              PlanLevel.ADVANCED,
            ]),
            subtitle: pick(PLAN_SUBTITLES, i),
            targetAudience: pick(TARGET_AUDIENCE_POOL, i),
            whatsIncluded: pick(WHATS_INCLUDED_POOL, i),
            prerequisites: "Basic familiarity with the subject area",
            materialProvided: "Detailed action plan, session recording, and curated reading list",
            learningOutcomes: faker.helpers.arrayElements(
              [
                "Master advanced techniques",
                "Develop strategic thinking",
                "Enhance decision-making skills",
              ],
              { min: 1, max: 3 },
            ),
          },
          {
            consultantProfileId: consultant.consultantProfile.id,
            title: "Comprehensive Consultation",
            description:
              "A half-day deep-dive session covering strategy, implementation, and review. Best suited for clients ready to commit to significant progress and needing hands-on expert guidance.",
            durationInHours: 4,
            price: faker.number.int({ min: 750000, max: 2000000 }), // ₹7500-₹20000 in paise
            priceCurrency: "INR",
            language: "English",
            level: faker.helpers.arrayElement([PlanLevel.INTERMEDIATE, PlanLevel.ADVANCED]),
            subtitle: pick(PLAN_SUBTITLES, i),
            targetAudience: pick(TARGET_AUDIENCE_POOL, i),
            whatsIncluded: pick(WHATS_INCLUDED_POOL, i),
            prerequisites: "Prior consultation or intermediate-level knowledge recommended",
            materialProvided: "Comprehensive strategy document, session recording, templates, and 7-day email follow-up",
            learningOutcomes: faker.helpers.arrayElements(
              [
                "Develop expertise in the field",
                "Create comprehensive strategies",
                "Implement best practices",
              ],
              { min: 1, max: 3 },
            ),
          },
        ],
      });

      // createMany cannot write nested relations; attach the FAQ separately.
      const created = await prisma.consultationPlan.findMany({
        where: { consultantProfileId: consultant.consultantProfile.id },
        select: { id: true },
      });
      for (const [planIndex, plan] of created.entries()) {
        await prisma.consultationPlan.update({
          where: { id: plan.id },
          data: {
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
        `Failed to create consultation plans for consultant ${consultant.id}:`,
        error,
      );
    }
    if ((i + 1) % 10 === 0 || i === consultants.length - 1) {
      console.log(`Created consultation plans for ${i + 1} consultants`);
    }
  }
}
