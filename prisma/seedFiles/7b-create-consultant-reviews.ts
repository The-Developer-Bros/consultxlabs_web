import { faker } from "@faker-js/faker";
import { Prisma } from "@prisma/client";
import prisma from "../../lib/prisma";
import { UserWithProfiles } from "./1a-create-users";

type CompletedAppointment = Prisma.AppointmentGetPayload<{
  include: {
    slotsOfAppointment: {
      include: {
        user: {
          include: {
            consulteeProfile: true;
          };
        };
      };
    };
  };
}>;

export async function createConsultantReviews(
  consultants: UserWithProfiles[],
  consultees: UserWithProfiles[],
) {
  console.log(`Creating consultant reviews...`);
  let totalReviews = 0;

  for (const consultant of consultants) {
    if (!consultant.consultantProfile) {
      console.warn(`Skipping consultant ${consultant.id} - no profile found`);
      continue;
    }

    try {
      // Get completed appointments for this consultant
      const completedAppointments = await prisma.appointment.findMany({
        where: {
          OR: [
            {
              consultation: {
                consultationPlan: {
                  consultantProfile: { id: consultant.consultantProfile.id },
                },
                status: "APPROVED",
              },
            },
            {
              subscription: {
                subscriptionPlan: {
                  consultantProfile: { id: consultant.consultantProfile.id },
                },
                status: "APPROVED",
              },
            },
            {
              webinar: {
                webinarPlan: {
                  consultantProfile: { id: consultant.consultantProfile.id },
                },
                status: "COMPLETED",
              },
            },
            {
              class: {
                classPlan: {
                  consultantProfile: { id: consultant.consultantProfile.id },
                },
                status: "COMPLETED",
              },
            },
          ],
        },
        include: {
          slotsOfAppointment: {
            include: {
              user: {
                include: {
                  consulteeProfile: true,
                },
              },
            },
          },
        },
      });

      if (completedAppointments.length === 0) {
        console.log(
          `No completed appointments found for consultant ${consultant.id}`,
        );
        continue;
      }

      // Create reviews for a random subset of completed appointments
      const numReviews = faker.number.int({
        min: 1,
        max: Math.max(1, Math.min(5, completedAppointments.length)),
      });
      const appointmentsToReview =
        faker.helpers.arrayElements<CompletedAppointment>(
          completedAppointments,
          numReviews,
        );

      for (const appointment of appointmentsToReview) {
        const consulteeProfile =
          appointment.slotsOfAppointment[0]?.user[0]?.consulteeProfile;
        if (!consulteeProfile) {
          console.warn(
            `Skipping review - no consultee profile found for appointment ${appointment.id}`,
          );
          continue;
        }

        const rating = faker.number.int({ min: 1, max: 5 });

        await prisma.consultantReview.create({
          data: {
            rating: rating,
            reviewDescription: faker.lorem.paragraph(),
            consultantProfile: {
              connect: { id: consultant.consultantProfile.id },
            },
            consulteeProfile: { connect: { id: consulteeProfile.id } },
          },
        });

        // Update consultant's average rating
        const allReviews = await prisma.consultantReview.findMany({
          where: { consultantProfileId: consultant.consultantProfile.id },
          select: { rating: true },
        });

        if (allReviews.length > 0) {
          const totalRating = allReviews.reduce<number>(
            (acc, review) => acc + review.rating,
            0,
          );
          const averageRating = Number(
            (totalRating / allReviews.length).toFixed(2),
          );

          await prisma.consultantProfile.update({
            where: { id: consultant.consultantProfile.id },
            data: { rating: averageRating },
          });
        }

        totalReviews++;
        if (totalReviews % 10 === 0) {
          console.log(`Created ${totalReviews} reviews so far...`);
        }
      }
    } catch (error) {
      console.error(
        `Failed to create reviews for consultant ${consultant.id}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  console.log(`Created ${totalReviews} consultant reviews`);
}
