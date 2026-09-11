import { faker } from "@faker-js/faker";
import { WaitlistSource, WaitlistStatus } from "@prisma/client";
import prisma from "../../lib/prisma";
import { config } from "./config";

const NUM_SUBSCRIBERS = config.volumes.waitlistSubscribers;

// Roughly what a real list looks like: mostly confirmed, a tail of people who
// never clicked the confirmation link, a few opt-outs, the occasional bounce.
const STATUS_WEIGHTS: Array<[WaitlistStatus, number]> = [
  [WaitlistStatus.SUBSCRIBED, 70],
  [WaitlistStatus.PENDING, 18],
  [WaitlistStatus.UNSUBSCRIBED, 10],
  [WaitlistStatus.BOUNCED, 2],
];

function pickStatus(): WaitlistStatus {
  const roll = faker.number.int({ min: 1, max: 100 });
  let cumulative = 0;
  for (const [status, weight] of STATUS_WEIGHTS) {
    cumulative += weight;
    if (roll <= cumulative) return status;
  }
  return WaitlistStatus.SUBSCRIBED;
}

export async function createWaitlistSubscribers() {
  console.log(`Creating ${NUM_SUBSCRIBERS} waitlist subscribers...`);

  const sources = Object.values(WaitlistSource);

  for (let i = 0; i < NUM_SUBSCRIBERS; i++) {
    const status = pickStatus();
    const createdAt = faker.date.recent({ days: 180 });

    try {
      await prisma.waitlist.create({
        data: {
          email: faker.internet.email().toLowerCase(),
          name: faker.datatype.boolean() ? faker.person.fullName() : null,
          status,
          source: faker.helpers.arrayElement(sources),
          tags: faker.helpers.arrayElements(
            ["founder", "student", "enterprise", "india", "beta"],
            { min: 0, max: 2 },
          ),
          createdAt,
          confirmedAt:
            status === WaitlistStatus.SUBSCRIBED ||
            status === WaitlistStatus.UNSUBSCRIBED
              ? faker.date.between({ from: createdAt, to: new Date() })
              : null,
          unsubscribedAt:
            status === WaitlistStatus.UNSUBSCRIBED
              ? faker.date.between({ from: createdAt, to: new Date() })
              : null,
        },
      });
    } catch (error) {
      // Duplicate faker emails are expected at higher volumes; skip and move on.
      console.error("Failed to create waitlist subscriber:", error);
    }

    if ((i + 1) % 20 === 0 || i === NUM_SUBSCRIBERS - 1) {
      console.log(`Created ${i + 1} waitlist subscribers`);
    }
  }
}
