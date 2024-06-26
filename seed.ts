import prisma from './lib/prisma';
import { faker } from '@faker-js/faker';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env' });

async function main() {

  // Generate Users
  try {
    for (let i = 0; i < 40; i++) {
      const userRole = faker.helpers.arrayElement(['CONSULTANT', 'CONSULTEE', 'ADMIN', 'STAFF'] as const);
      console.log('Creating user with role:', userRole);
      await prisma.user.create({
        data: {
          name: faker.person.fullName(),
          email: faker.internet.email(),
          emailVerified: faker.date.past(),
          image: faker.image.avatar(),
          onboardingCompleted: faker.datatype.boolean(),
          role: userRole,
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
    }
  } catch (error) {
    console.error('Failed to create users:', error);
  }

  // Generate Consultations
  const consultants = await prisma.consultantProfile.findMany();
  const consultees = await prisma.consulteeProfile.findMany();

  // Shuffle and select a subset of consultees
  const selectedConsultees = consultees
    .toSorted(() => 0.5 - Math.random())
    .slice(0, Math.min(30, consultees.length));

  for (const consultee of selectedConsultees) {
    try {
      console.log('Creating consultation for consultee:', consultee.id);
      await prisma.consultation.create({
        data: {
          price: faker.number.int({ min: 50, max: 500 }),
          consultantProfileId: faker.helpers.arrayElement(consultants).id,
          consulteeProfileId: consultee.id,
          slotOfAppointment: {
            create: {
              appointmentSlots: {
                create: {
                  day: faker.helpers.arrayElement(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']),
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
      // Optionally, you can break the loop here if you want to stop on first error
      // break;
    }
  }

  // Generate Subscriptions
  for (let i = 0; i < 30; i++) {
    await prisma.subscription.create({
      data: {
        expiryDate: faker.date.future(),
        price: faker.number.int({ min: 100, max: 1000 }),
        consultantProfileId: faker.helpers.arrayElement(consultants).id,
        consulteeProfileId: faker.helpers.arrayElement(consultees).id,
      }
    });
  }

  // Generate Webinars
  try {
    for (let i = 0; i < 30; i++) {
      await prisma.webinar.create({
        data: {
          price: faker.number.int({ min: 20, max: 200 }),
          consultantProfileId: faker.helpers.arrayElement(consultants).id,
          consultees: {
            connect: faker.helpers.arrayElements(consultees, { min: 1, max: 5 }).map(c => ({ id: c.id }))
          },
          slotOfAppointment: {
            create: {
              appointmentSlots: {
                create: {
                  day: faker.helpers.arrayElement(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']),
                  startTime: faker.date.future(),
                  endTime: faker.date.future(),
                }
              }
            }
          }
        }
      });
    }
  } catch (error) {
    console.error('Failed to create webinars:', error);
  }

  // Generate Classes
  for (let i = 0; i < 30; i++) {
    try {
      await prisma.class.create({
        data: {
          consultantId: faker.string.uuid(),
          expiryDate: faker.date.future(),
          price: faker.number.int({ min: 50, max: 300 }),
          consultantProfileId: faker.helpers.arrayElement(consultants).id,
          consultees: {
            connect: faker.helpers.arrayElements(consultees, { min: 1, max: 10 }).map(c => ({ id: c.id }))
          },
        }
      });
    } catch (error) {
      console.error('Failed to create class:', error);
    }
  }

  // Generate Newsletters
  for (let i = 0; i < 40; i++) {
    try {
      await prisma.newsletter.create({
        data: {
          email: faker.internet.email(),
        }
      });
    } catch (error) {
      console.error('Failed to create newsletter:', error);
    }
  }

  // Generate SlotsOfAvailability
  for (let i = 0; i < 30; i++) {
    try {
      await prisma.slotsOfAvailability.create({
        data: {
          consultantProfileId: faker.helpers.arrayElement(consultants).id,
          availabilitySlots: {
            create: Array.from({ length: faker.number.int({ min: 1, max: 5 }) }, () => ({
              day: faker.helpers.arrayElement(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']),
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

  console.log('Seed data inserted successfully.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });