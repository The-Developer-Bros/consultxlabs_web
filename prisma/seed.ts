import { faker } from '@faker-js/faker';
import { UserRole, RequestStatus, ScheduleType, DayOfWeek } from '@prisma/client';
import * as dotenv from 'dotenv';
import prisma from '../lib/prisma';
dotenv.config({ path: ".env" });

async function createUsers() {
  for (let i = 0; i < 40; i++) {
    const userRole = faker.helpers.arrayElement(['CONSULTANT', 'CONSULTEE', 'ADMIN', 'STAFF']);
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
          ...(userRole === 'CONSULTANT' && {
            consultantProfile: {
              create: {
                rating: faker.number.float({ min: 1, max: 5, multipleOf: 0.1 }),
                specialization: faker.person.jobArea(),
                experience: faker.helpers.arrayElement(['1-3 years', '3-5 years', '5-10 years', '10+ years']),
                location: faker.location.city(),
                onlineStatus: faker.datatype.boolean(),
                domain: faker.person.jobType(),
                subDomains: faker.helpers.arrayElements([
                  'Risk Management', 'Training', 'Digital Marketing', 'Data Analysis', 'Supply Chain'
                ], { min: 1, max: 3 }),
                scheduleType: faker.helpers.arrayElement(['WEEKLY', 'CUSTOM']) as ScheduleType,
              }
            }
          }),
          ...(userRole === 'CONSULTEE' && {
            consulteeProfile: {
              create: {
                location: faker.location.city(),
                onlineStatus: faker.datatype.boolean(),
              }
            }
          }),
          cookiePreferences: {
            create: {
              essential: true,
              analytics: faker.datatype.boolean(),
              marketing: faker.datatype.boolean(),
            }
          },
          notificationPreferences: {
            create: {
              allNotifications: true,
              mentions: faker.datatype.boolean(),
              directMessages: faker.datatype.boolean(),
              updates: faker.datatype.boolean(),
            }
          },
        }
      });
    } catch (error) {
      console.error('Failed to create user:', error);
    }
  }
}

async function createConsultations() {
  const consultants = await prisma.consultantProfile.findMany();
  const consultees = await prisma.consulteeProfile.findMany();

  const selectedConsultees = consultees.sort(() => 0.5 - Math.random()).slice(0, Math.min(30, consultees.length));

  for (const consultee of selectedConsultees) {
    try {
      console.log(`Creating consultation for consultee: ${consultee.id}`);
      const startTime = faker.date.between({ from: '2024-07-01T08:00:00Z', to: '2030-07-01T17:00:00Z' });
      const endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // 1 hour later
      await prisma.consultation.create({
        data: {
          price: faker.number.int({ min: 50, max: 500 }),
          consultantProfileId: faker.helpers.arrayElement(consultants).id,
          consulteeProfileId: consultee.id,
          slotOfAppointment: {
            create: {
              appointmentSlots: {
                create: {
                  dateInISO: startTime.toISOString(),
                  timeTzStart: startTime,
                  timeTzEnd: endTime,
                }
              }
            }
          }
        }
      });
    } catch (error) {
      console.error(`Failed to create consultation for consultee ${consultee.id}:`, error);
    }
  }
}

async function createSubscriptions() {
  const consultants = await prisma.consultantProfile.findMany();
  const consultees = await prisma.consulteeProfile.findMany();

  for (let i = 0; i < 30; i++) {
    try {
      console.log('Creating subscription');
      await prisma.subscription.create({
        data: {
          expiryDate: faker.date.future(),
          price: faker.number.int({ min: 100, max: 1000 }),
          consultantProfileId: faker.helpers.arrayElement(consultants).id,
          consulteeProfileId: faker.helpers.arrayElement(consultees).id,
        }
      });
    } catch (error) {
      console.error('Failed to create subscription:', error);
    }
  }
}

async function createWebinars() {
  const consultants = await prisma.consultantProfile.findMany();
  const consultees = await prisma.consulteeProfile.findMany();

  for (let i = 0; i < 30; i++) {
    try {
      console.log('Creating webinar');
      const startTime = faker.date.between({ from: '2024-07-01T08:00:00Z', to: '2030-07-01T17:00:00Z' });
      const endTime = new Date(startTime.getTime() + 2 * 60 * 60 * 1000); // 2 hours later
      await prisma.webinar.create({
        data: {
          price: faker.number.int({ min: 20, max: 200 }),
          consultantProfileId: faker.helpers.arrayElement(consultants).id,
          consulteeProfiles: {
            connect: faker.helpers.arrayElements(consultees, { min: 1, max: 5 }).map(c => ({ id: c.id }))
          },
          slotOfAppointment: {
            create: {
              appointmentSlots: {
                create: {
                  dateInISO: startTime.toISOString(),
                  timeTzStart: startTime,
                  timeTzEnd: endTime,
                }
              }
            }
          }
        }
      });
    } catch (error) {
      console.error('Failed to create webinar:', error);
    }
  }
}

async function createClasses() {
  const consultants = await prisma.consultantProfile.findMany();
  const consultees = await prisma.consulteeProfile.findMany();

  for (let i = 0; i < 30; i++) {
    try {
      console.log('Creating class');
      const startTime = faker.date.between({ from: '2024-07-01T08:00:00Z', to: '2030-07-01T17:00:00Z' });
      const endTime = new Date(startTime.getTime() + 3 * 60 * 60 * 1000); // 3 hours later
      await prisma.class.create({
        data: {
          consultantId: faker.string.uuid(),
          expiryDate: faker.date.future(),
          price: faker.number.int({ min: 50, max: 300 }),
          consultantProfileId: faker.helpers.arrayElement(consultants).id,
          consulteeProfiles: {
            connect: faker.helpers.arrayElements(consultees, { min: 1, max: 10 }).map(c => ({ id: c.id }))
          },
          slotOfAppointment: {
            create: {
              appointmentSlots: {
                create: {
                  dateInISO: startTime.toISOString(),
                  timeTzStart: startTime,
                  timeTzEnd: endTime,
                }
              }
            }
          }
        }
      });
    } catch (error) {
      console.error('Failed to create class:', error);
    }
  }
}

async function createNewsletters() {
  for (let i = 0; i < 40; i++) {
    try {
      console.log('Creating newsletter');
      await prisma.newsletter.create({
        data: {
          email: faker.internet.email(),
        }
      });
    } catch (error) {
      console.error('Failed to create newsletter:', error);
    }
  }
}

async function createSlotsOfAvailabilityWeekly() {
  const consultants = await prisma.consultantProfile.findMany();

  for (const consultant of consultants) {
    if (consultant.scheduleType === 'WEEKLY') {
      try {
        console.log('Creating weekly slots of availability');
        await prisma.slotsOfAvailabilityWeekly.create({
          data: {
            consultantProfileId: consultant.id,
            dayOfWeek: faker.helpers.arrayElement(Object.values(DayOfWeek)),
            slotTimings: {
              create: Array.from({ length: faker.number.int({ min: 1, max: 5 }) }, () => {
                const startTime = faker.date.between({ from: '2024-07-01T08:00:00Z', to: '2030-07-01T17:00:00Z' });
                const endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // 1 hour later
                return {
                  dateInISO: startTime.toISOString(),
                  timeTzStart: startTime,
                  timeTzEnd: endTime,
                };
              })
            }
          }
        });
      } catch (error) {
        console.error('Failed to create weekly slots of availability:', error);
      }
    }
  }
}

async function createSlotsOfAvailabilityCustom() {
  const consultants = await prisma.consultantProfile.findMany();

  for (const consultant of consultants) {
    if (consultant.scheduleType === 'CUSTOM') {
      try {
        console.log('Creating custom slots of availability');
        await prisma.slotsOfAvailabilityCustom.create({
          data: {
            consultantProfileId: consultant.id,
            dateInISO: faker.date.future().toISOString(),
            slotTimings: {
              create: Array.from({ length: faker.number.int({ min: 1, max: 5 }) }, () => {
                const startTime = faker.date.between({ from: '2024-07-01T08:00:00Z', to: '2030-07-01T17:00:00Z' });
                const endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // 1 hour later
                return {
                  dateInISO: startTime.toISOString(),
                  timeTzStart: startTime,
                  timeTzEnd: endTime,
                };
              })
            }
          }
        });
      } catch (error) {
        console.error('Failed to create custom slots of availability:', error);
      }
    }
  }
}

async function createSlotRequests() {
  const slotTimings = await prisma.slotTiming.findMany({
    include: {
      slotsOfAvailabilityWeekly: {
        select: {
          consultantProfileId: true
        }
      },
      slotsOfAvailabilityCustom: {
        select: {
          consultantProfileId: true
        }
      }
    }
  });
  const consultees = await prisma.consulteeProfile.findMany();

  for (const consultee of consultees) {
    try {
      console.log(`Creating slot request for consultee: ${consultee.id}`);
      const slotTiming = faker.helpers.arrayElement(slotTimings);
      const consultantProfileId = slotTiming.slotsOfAvailabilityWeekly?.consultantProfileId || slotTiming.slotsOfAvailabilityCustom?.consultantProfileId;

      if (!consultantProfileId) {
        console.error(`No consultantProfileId found for slotTiming: ${slotTiming.slotId}`);
        continue;
      }

      await prisma.slotRequest.create({
        data: {
          consultantProfileId: consultantProfileId,
          consulteeProfileId: consultee.id,
          slotTimingId: slotTiming.slotId,
          status: RequestStatus.PENDING,
        }
      });
    } catch (error) {
      console.error(`Failed to create slot request for consultee ${consultee.id}:`, error);
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
  await createSlotsOfAvailabilityWeekly();
  await createSlotsOfAvailabilityCustom();
  await createSlotRequests();

  console.log('Seed data inserted successfully.');
}

seed()
  .catch((e) => {
    console.error('Error in seed function:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
