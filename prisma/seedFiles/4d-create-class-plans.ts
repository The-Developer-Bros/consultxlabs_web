import { faker } from "@faker-js/faker";
import { PlanEmailSupport, PlanLevel } from "@prisma/client";
import prisma from "../../lib/prisma";
import { UserWithProfiles } from "./1a-create-users";
import {
  CLASS_CURRICULUM,
  CLASS_DESCRIPTIONS,
  FAQ_POOL,
  PLAN_SUBTITLES,
  TARGET_AUDIENCE_POOL,
  WHATS_INCLUDED_POOL,
  pick,
} from "./plan-content";

export async function createClassPlans(consultants: UserWithProfiles[]) {
  console.log(`Creating class plans for ${consultants.length} consultants...`);
  for (let i = 0; i < consultants.length; i++) {
    const consultant = consultants[i];
    if (!consultant.consultantProfile) {
      console.warn(`Skipping consultant ${consultant.id} - no profile found`);
      continue;
    }
    try {
      const topics = await prisma.topic.findMany({ take: 5 });

      // Create class plans with proper data structure
      const classPlans = await Promise.all([
        prisma.classPlan.create({
          data: {
            consultantProfileId: consultant.consultantProfile.id,
            title: "Beginner Class",
            description: pick(CLASS_DESCRIPTIONS, i),
            priceCurrency: "INR",
            durationInMonths: 1,
            price: faker.number.int({ min: 1990000, max: 3990000 }), // ₹19900-₹39900 in paise
            sessionsPerWeek: 1,
            sessionDurationInHours: 1.0,
            totalSessions: 4, // 1 × 1 × 4
            totalHours: 4.0, // 4 × 1.0
            emailSupport: PlanEmailSupport.GENERAL,
            maxParticipants: faker.number.int({ min: 5, max: 15 }),
            language: faker.helpers.arrayElement([
              "English",
              "Spanish",
              "French",
              "German",
              "Chinese",
            ]),
            level: PlanLevel.BEGINNER,
            prerequisites: "None",
            materialProvided: "Slides, worked examples and the cohort repo",
            learningOutcomes: faker.helpers.arrayElements(
              [
                "Understand basic concepts",
                "Gain practical skills",
                "Improve problem-solving abilities",
              ],
              { min: 1, max: 3 },
            ),
            certificateProvided: faker.datatype.boolean(),
            topics: {
              connect: faker.helpers
                .arrayElements(topics, { min: 1, max: 3 })
                .map((topic) => ({ id: topic.id })),
            },
            subtitle: pick(PLAN_SUBTITLES, i + 1),
            targetAudience: pick(TARGET_AUDIENCE_POOL, i + 1),
            whatsIncluded: pick(WHATS_INCLUDED_POOL, i + 1),
            faqs: { create: pick(FAQ_POOL, i + 1).map((f, o) => ({ ...f, order: o })) },
            classContents: {
              create: CLASS_CURRICULUM.map((item, index) => ({
                ...item,
                order: index + 1,
                hoursAllotted: 1.5,
              })),
            },
          },
        }),
        prisma.classPlan.create({
          data: {
            consultantProfileId: consultant.consultantProfile.id,
            title: "Intermediate Class",
            description: pick(CLASS_DESCRIPTIONS, i),
            priceCurrency: "INR",
            durationInMonths: 3,
            price: faker.number.int({ min: 3490000, max: 6990000 }), // ₹34900-₹69900 in paise
            sessionsPerWeek: 2,
            sessionDurationInHours: 1.5,
            totalSessions: 24, // 2 × 3 × 4
            totalHours: 36.0, // 24 × 1.5
            emailSupport: PlanEmailSupport.PRIORITY,
            maxParticipants: faker.number.int({ min: 5, max: 12 }),
            language: faker.helpers.arrayElement([
              "English",
              "Spanish",
              "French",
              "German",
              "Chinese",
            ]),
            level: PlanLevel.INTERMEDIATE,
            prerequisites: "Comfortable writing and shipping code on your own",
            materialProvided: "Slides, worked examples and the cohort repo",
            learningOutcomes: faker.helpers.arrayElements(
              [
                "Master advanced techniques",
                "Develop strategic thinking",
                "Enhance decision-making skills",
              ],
              { min: 1, max: 3 },
            ),
            certificateProvided: faker.datatype.boolean(),
            topics: {
              connect: faker.helpers
                .arrayElements(topics, { min: 1, max: 3 })
                .map((topic) => ({ id: topic.id })),
            },
            subtitle: pick(PLAN_SUBTITLES, i + 2),
            targetAudience: pick(TARGET_AUDIENCE_POOL, i + 2),
            whatsIncluded: pick(WHATS_INCLUDED_POOL, i + 2),
            faqs: { create: pick(FAQ_POOL, i + 2).map((f, o) => ({ ...f, order: o })) },
            classContents: {
              create: CLASS_CURRICULUM.map((item, index) => ({
                ...item,
                order: index + 1,
                hoursAllotted: 1.5,
              })),
            },
          },
        }),
        prisma.classPlan.create({
          data: {
            consultantProfileId: consultant.consultantProfile.id,
            title: "Advanced Class",
            description: pick(CLASS_DESCRIPTIONS, i),
            priceCurrency: "INR",
            durationInMonths: 6,
            price: faker.number.int({ min: 4990000, max: 9990000 }), // ₹49900-₹99900 in paise
            sessionsPerWeek: 3,
            sessionDurationInHours: 2.0,
            totalSessions: 72, // 3 × 6 × 4
            totalHours: 144.0, // 72 × 2.0
            emailSupport: PlanEmailSupport.DEDICATED,
            maxParticipants: faker.number.int({ min: 3, max: 10 }),
            language: faker.helpers.arrayElement([
              "English",
              "Spanish",
              "French",
              "German",
              "Chinese",
            ]),
            level: PlanLevel.ADVANCED,
            prerequisites: "Comfortable writing and shipping code on your own",
            materialProvided: "Slides, worked examples and the cohort repo",
            learningOutcomes: faker.helpers.arrayElements(
              [
                "Develop expertise in the field",
                "Create comprehensive strategies",
                "Implement best practices",
              ],
              { min: 1, max: 3 },
            ),
            certificateProvided: faker.datatype.boolean(),
            topics: {
              connect: faker.helpers
                .arrayElements(topics, { min: 1, max: 3 })
                .map((topic) => ({ id: topic.id })),
            },
            subtitle: pick(PLAN_SUBTITLES, i + 3),
            targetAudience: pick(TARGET_AUDIENCE_POOL, i + 3),
            whatsIncluded: pick(WHATS_INCLUDED_POOL, i + 3),
            faqs: { create: pick(FAQ_POOL, i + 3).map((f, o) => ({ ...f, order: o })) },
            classContents: {
              create: CLASS_CURRICULUM.map((item, index) => ({
                ...item,
                order: index + 1,
                hoursAllotted: 1.5,
              })),
            },
          },
        }),
      ]);
    } catch (error) {
      console.error(
        `Failed to create class plans for consultant ${consultant.id}:`,
        error,
      );
    }
    if ((i + 1) % 10 === 0 || i === consultants.length - 1) {
      console.log(`Created class plans for ${i + 1} consultants`);
    }
  }
}
