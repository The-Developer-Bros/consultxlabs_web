import { faker } from "@faker-js/faker";
import {
  UserRole,
  RequestStatus,
  ScheduleType,
  SlotType,
  DayOfWeek,
} from "@prisma/client";
import * as dotenv from "dotenv";
import prisma from "../lib/prisma";
dotenv.config({ path: ".env" });

async function createUsers() {
  for (let i = 0; i < 40; i++) {
    const userRole = faker.helpers.arrayElement([
      "CONSULTANT",
      "CONSULTEE",
      "ADMIN",
      "STAFF",
    ]);
    console.log(`Creating user with role: ${userRole}`);
    try {
      await prisma.user.create({
        data: {
          name: faker.person.fullName(),
          email: faker.internet.email(),
          emailVerified: faker.date.past(),
          image: faker.image.avatar(),
          phone: faker.phone.number(),
          address: faker.location.streetAddress(),
          onboardingCompleted: faker.datatype.boolean(),
          role: userRole as UserRole,
          ...(userRole === "CONSULTANT" && {
            consultantProfile: {
              create: {
                rating: faker.number.float({ min: 1, max: 5, multipleOf: 0.1 }),
                specialization: faker.person.jobArea(),
                experience: faker.helpers.arrayElement([
                  "1-3 years",
                  "3-5 years",
                  "5-10 years",
                  "10+ years",
                ]),
                location: faker.location.city(),
                onlineStatus: faker.datatype.boolean(),
                domain: faker.person.jobType(),
                subDomains: faker.helpers.arrayElements(
                  [
                    "Risk Management",
                    "Training",
                    "Digital Marketing",
                    "Data Analysis",
                    "Supply Chain",
                  ],
                  { min: 1, max: 3 }
                ),
                scheduleType: faker.helpers.arrayElement([
                  "WEEKLY",
                  "CUSTOM",
                ]) as ScheduleType,
              },
            },
          }),
          ...(userRole === "CONSULTEE" && {
            consulteeProfile: {
              create: {
                location: faker.location.city(),
                onlineStatus: faker.datatype.boolean(),
              },
            },
          }),
          cookiePreferences: {
            create: {
              essential: true,
              analytics: faker.datatype.boolean(),
              marketing: faker.datatype.boolean(),
            },
          },
          notificationPreferences: {
            create: {
              allNotifications: true,
              mentions: faker.datatype.boolean(),
              directMessages: faker.datatype.boolean(),
              updates: faker.datatype.boolean(),
            },
          },
        },
      });
    } catch (error) {
      console.error("Failed to create user:", error);
    }
  }
}

async function createConsultations() {
  const consultants = await prisma.consultantProfile.findMany();
  const consultees = await prisma.consulteeProfile.findMany();

  for (const consultee of consultees) {
    try {
      console.log(`Creating consultation for consultee: ${consultee.id}`);
      const startTime = faker.date.soon({ days: 30 });
      const endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // 1 hour later
      await prisma.consultation.create({
        data: {
          price: faker.number.int({ min: 50, max: 500 }),
          slotAppointments: {
            create: {
              status: RequestStatus.PENDING,
              appointmentsType: "CONSULTATION",
              slotRequest: {
                create: {
                  status: RequestStatus.PENDING,
                  slot: {
                    create: {
                      date: startTime,
                      slotStartTimeInUTC: startTime,
                      slotEndTimeInUTC: endTime,
                      slotType: SlotType.CUSTOM,
                      consultantProfileId:
                        faker.helpers.arrayElement(consultants).id,
                    },
                  },
                  consulteeProfile: {
                    connect: {
                      id: consultee.id,
                    },
                  },
                },
              },
            },
          },
        },
      });
    } catch (error) {
      console.error(
        `Failed to create consultation for consultee ${consultee.id}:`,
        error
      );
    }
  }
}

async function createSubscriptions() {
  const consultants = await prisma.consultantProfile.findMany();
  const consultees = await prisma.consulteeProfile.findMany();

  for (let i = 0; i < 30; i++) {
    try {
      console.log("Creating subscription");
      await prisma.subscription.create({
        data: {
          expiryDate: faker.date.future(),
          price: faker.number.int({ min: 100, max: 1000 }),
          slotAppointments: {
            create: {
              status: RequestStatus.PENDING,
              appointmentsType: "SUBSCRIPTION",
              slotRequest: {
                create: {
                  status: RequestStatus.PENDING,
                  slot: {
                    create: {
                      date: faker.date.future(),
                      slotStartTimeInUTC: faker.date.recent(),
                      slotEndTimeInUTC: faker.date.soon(),
                      slotType: SlotType.CUSTOM,
                      consultantProfileId:
                        faker.helpers.arrayElement(consultants).id,
                    },
                  },
                  consulteeProfile: {
                    connect: {
                      id: faker.helpers.arrayElement(consultees).id,
                    },
                  },
                },
              },
            },
          },
        },
      });
    } catch (error) {
      console.error("Failed to create subscription:", error);
    }
  }
}

async function createWebinars() {
  const consultants = await prisma.consultantProfile.findMany();
  const consultees = await prisma.consulteeProfile.findMany();

  for (let i = 0; i < 30; i++) {
    try {
      console.log("Creating webinar");
      const startTime = faker.date.soon({ days: 30 });
      const endTime = new Date(startTime.getTime() + 2 * 60 * 60 * 1000); // 2 hours later
      await prisma.webinar.create({
        data: {
          price: faker.number.int({ min: 20, max: 200 }),
          slotAppointments: {
            create: {
              status: RequestStatus.PENDING,
              appointmentsType: "WEBINAR",
              slotRequest: {
                create: {
                  status: RequestStatus.PENDING,
                  slot: {
                    create: {
                      date: startTime,
                      slotStartTimeInUTC: startTime,
                      slotEndTimeInUTC: endTime,
                      slotType: SlotType.CUSTOM,
                      consultantProfileId:
                        faker.helpers.arrayElement(consultants).id,
                    },
                  },
                  consulteeProfile: {
                    connect: {
                      id: faker.helpers.arrayElement(consultees).id,
                    },
                  },
                },
              },
            },
          },
        },
      });
    } catch (error) {
      console.error("Failed to create webinar:", error);
    }
  }
}

async function createClasses() {
  const consultants = await prisma.consultantProfile.findMany();
  const consultees = await prisma.consulteeProfile.findMany();

  for (let i = 0; i < 30; i++) {
    try {
      console.log("Creating class");
      const startTime = faker.date.soon({ days: 30 });
      const endTime = new Date(startTime.getTime() + 3 * 60 * 60 * 1000); // 3 hours later
      await prisma.class.create({
        data: {
          expiryDate: faker.date.future(),
          price: faker.number.int({ min: 50, max: 300 }),
          slotAppointments: {
            create: {
              status: RequestStatus.PENDING,
              appointmentsType: "CLASS",
              slotRequest: {
                create: {
                  status: RequestStatus.PENDING,
                  slot: {
                    create: {
                      date: startTime,
                      slotStartTimeInUTC: startTime,
                      slotEndTimeInUTC: endTime,
                      slotType: SlotType.CUSTOM,
                      consultantProfileId:
                        faker.helpers.arrayElement(consultants).id,
                    },
                  },
                  consulteeProfile: {
                    connect: {
                      id: faker.helpers.arrayElement(consultees).id,
                    },
                  },
                },
              },
            },
          },
        },
      });
    } catch (error) {
      console.error("Failed to create class:", error);
    }
  }
}

async function createNewsletters() {
  for (let i = 0; i < 40; i++) {
    try {
      console.log("Creating newsletter");
      await prisma.newsletter.create({
        data: {
          email: faker.internet.email(),
        },
      });
    } catch (error) {
      console.error("Failed to create newsletter:", error);
    }
  }
}

async function createSlots() {
  const consultants = await prisma.consultantProfile.findMany();

  for (const consultant of consultants) {
    const slotType =
      consultant.scheduleType === ScheduleType.WEEKLY
        ? SlotType.WEEKLY
        : SlotType.CUSTOM;

    try {
      console.log(`Creating slot for consultant: ${consultant.id}`);
      await prisma.slot.create({
        data: {
          date: slotType === SlotType.CUSTOM ? faker.date.future() : null,
          dayOfWeek:
            slotType === SlotType.WEEKLY
              ? faker.helpers.arrayElement(Object.values(DayOfWeek))
              : null,
          slotStartTimeInUTC: faker.date.recent(),
          slotEndTimeInUTC: faker.date.soon(),
          slotType,
          consultantProfileId: consultant.id,
        },
      });
    } catch (error) {
      console.error(
        `Failed to create slot for consultant ${consultant.id}:`,
        error
      );
    }
  }
}

async function createSlotRequests() {
  const slots = await prisma.slot.findMany();
  const consultees = await prisma.consulteeProfile.findMany();

  for (const consultee of consultees) {
    try {
      console.log(`Creating slot request for consultee: ${consultee.id}`);
      const slot = faker.helpers.arrayElement(slots);

      const existingRequest = await prisma.slotRequest.findFirst({
        where: {
          consulteeProfileId: consultee.id,
          slotId: slot.id,
        },
      });

      if (!existingRequest) {
        await prisma.slotRequest.create({
          data: {
            consulteeProfileId: consultee.id,
            slotId: slot.id,
            status: RequestStatus.PENDING,
          },
        });
      } else {
        console.warn(
          `SlotRequest already exists for consultee: ${consultee.id} and slot: ${slot.id}`
        );
      }
    } catch (error) {
      console.error(
        `Failed to create slot request for consultee ${consultee.id}:`,
        error
      );
    }
  }
}

async function seed() {
  await createUsers();
  await createConsultations();
  await createSubscriptions();
  await createWebinars();
  await createClasses();
  await createNewsletters();
  await createSlots();
  await createSlotRequests();

  console.log("Seed data inserted successfully.");
}

seed()
  .catch((e) => {
    console.error("Error in seed function:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
