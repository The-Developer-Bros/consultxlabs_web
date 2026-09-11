import { faker } from "@faker-js/faker";
import prisma from "../../lib/prisma";

/**
 * Creates collaborators for some webinar and class plans.
 */
export async function createCollaborators() {
  console.log("Creating collaborators...");

  const consultantProfiles = await prisma.consultantProfile.findMany({
    select: { id: true },
    take: 30,
  });

  if (consultantProfiles.length < 3) {
    console.log("Not enough consultant profiles. Skipping collaborators.");
    return;
  }

  let webinarCollabsCreated = 0;
  let classCollabsCreated = 0;

  // Get webinar plans with their owners
  const webinarPlans = await prisma.webinarPlan.findMany({
    select: { id: true, consultantProfileId: true },
    take: 10,
  });

  // Get class plans with their owners
  const classPlans = await prisma.classPlan.findMany({
    select: { id: true, consultantProfileId: true },
    take: 10,
  });

  const webinarRoles = [
    "CO_HOST",
    "MODERATOR",
    "GUEST_SPEAKER",
    "TECHNICAL_SUPPORT",
  ] as const;

  const classRoles = [
    "CO_INSTRUCTOR",
    "TEACHING_ASSISTANT",
    "GUEST_LECTURER",
    "CONTENT_CREATOR",
  ] as const;

  const statuses = ["PENDING", "ACCEPTED", "DECLINED"] as const;

  // Add collaborators to ~50% of webinar plans
  for (const plan of webinarPlans.slice(
    0,
    Math.ceil(webinarPlans.length * 0.5),
  )) {
    // Pick 1-2 collaborators (not the owner)
    const availableCollaborators = consultantProfiles.filter(
      (cp) => cp.id !== plan.consultantProfileId,
    );

    const numCollabs = faker.number.int({ min: 1, max: 2 });
    const selectedCollabs = faker.helpers
      .shuffle(availableCollaborators)
      .slice(0, numCollabs);

    for (const collab of selectedCollabs) {
      try {
        const status = faker.helpers.arrayElement(statuses);
        await prisma.collaborator.create({
          data: {
            consultantProfileId: collab.id,
            collaboratorType: "WEBINAR",
            webinarPlanId: plan.id,
            role: faker.helpers.arrayElement(webinarRoles),
            revenueShareBps: faker.helpers.arrayElement([
              1000, 1500, 2000, 2500, 3000,
            ]),
            status,
            invitedById: plan.consultantProfileId!,
            ...(status === "ACCEPTED" || status === "DECLINED"
              ? { respondedAt: faker.date.recent({ days: 7 }) }
              : {}),
          },
        });
        webinarCollabsCreated++;
      } catch {
        // Skip unique constraint violations
      }
    }
  }

  // Add collaborators to ~50% of class plans
  for (const plan of classPlans.slice(0, Math.ceil(classPlans.length * 0.5))) {
    const availableCollaborators = consultantProfiles.filter(
      (cp) => cp.id !== plan.consultantProfileId,
    );

    const numCollabs = faker.number.int({ min: 1, max: 2 });
    const selectedCollabs = faker.helpers
      .shuffle(availableCollaborators)
      .slice(0, numCollabs);

    for (const collab of selectedCollabs) {
      try {
        const status = faker.helpers.arrayElement(statuses);
        await prisma.collaborator.create({
          data: {
            consultantProfileId: collab.id,
            collaboratorType: "CLASS",
            classPlanId: plan.id,
            role: faker.helpers.arrayElement(classRoles),
            revenueShareBps: faker.helpers.arrayElement([
              1000, 1500, 2000, 2500, 3000,
            ]),
            status,
            invitedById: plan.consultantProfileId!,
            ...(status === "ACCEPTED" || status === "DECLINED"
              ? { respondedAt: faker.date.recent({ days: 7 }) }
              : {}),
          },
        });
        classCollabsCreated++;
      } catch {
        // Skip unique constraint violations
      }
    }
  }

  console.log(
    `Created ${webinarCollabsCreated} webinar collaborators, ${classCollabsCreated} class collaborators`,
  );
}
