import { faker } from '@faker-js/faker';
import { UserRole } from '@prisma/client';
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

  const selectedConsultees = consultees.toSorted(() => 0.5 - Math.random()).slice(0, Math.min(30, consultees.length));

  for (const consultee of selectedConsultees) {
    try {
      console.log(`Creating consultation for consultee: ${consultee.id}`);
      await prisma.consultation.create({
        data: {
          price: faker.number.int({ min: 50, max: 500 }),
          consultantProfileId: faker.helpers.arrayElement(consultants).id,
          consulteeProfileId: consultee.id,
          slotOfAppointment: {
            create: {
              appointmentSlots: {
                create: {
                  dateInISO: faker.date.future().toISOString(),
                  startTime: faker.date.future(),
                  endTime: faker.date.future(),
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
                  dateInISO: faker.date.future().toISOString(),
                  startTime: faker.date.future(),
                  endTime: faker.date.future(),
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
      await prisma.class.create({
        data: {
          consultantId: faker.string.uuid(),
          expiryDate: faker.date.future(),
          price: faker.number.int({ min: 50, max: 300 }),
          consultantProfileId: faker.helpers.arrayElement(consultants).id,
          consulteeProfiles: {
            connect: faker.helpers.arrayElements(consultees, { min: 1, max: 10 }).map(c => ({ id: c.id }))
          },
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

async function createSlotsOfAvailability() {
  const consultants = await prisma.consultantProfile.findMany();

  for (let i = 0; i < 30; i++) {
    try {
      console.log('Creating slots of availability');
      await prisma.slotsOfAvailability.create({
        data: {
          consultantProfileId: faker.helpers.arrayElement(consultants).id,
          availabilitySlots: {
            create: Array.from({ length: faker.number.int({ min: 1, max: 5 }) }, () => ({
              dateInISO: faker.date.future().toISOString(),
              startTime: faker.date.future(),
              endTime: faker.date.future(),
            }))
          }
        }
      });
    } catch (error) {
      console.error('Failed to create slots of availability:', error);
    }
  }
}

async function createSlotRequests() {
  const slotTimings = await prisma.slotTiming.findMany();
  const consultees = await prisma.consulteeProfile.findMany();

  for (const consultee of consultees) {
    try {
      console.log(`Creating slot request for consultee: ${consultee.id}`);
      await prisma.slotRequest.create({
        data: {
          consulteeProfileId: consultee.id,
          slotTimingId: faker.helpers.arrayElement(slotTimings).slotId,
          status: 'PENDING',
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
  await createSlotsOfAvailability();
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
