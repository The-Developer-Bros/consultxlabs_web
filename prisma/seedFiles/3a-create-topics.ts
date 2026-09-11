import { Topic } from "@prisma/client";
import prisma from "../../lib/prisma";
import { config } from "./config";

// Topic volume - configurable via SEED_MODE environment variable
const NUM_TOPICS = config.volumes.topics;

/**
 * Real topic names, not `faker.lorem.words(3)`.
 *
 * Topic is the only user-visible taxonomy on a plan and it drives the explore
 * topic facet. Seeding it with lorem made every facet, chip and "Topics
 * Covered" badge read as gibberish, which made the whole discovery surface look
 * broken locally regardless of what the code did.
 *
 * The pool is deliberately longer than any SEED_MODE volume so `large` still
 * gets distinct names; `Topic.name` is @unique, so we slice rather than sample
 * with replacement.
 */
const TOPIC_POOL = [
  "System Design",
  "Data Structures & Algorithms",
  "Behavioural Interviews",
  "Resume Review",
  "Career Transition",
  "Salary Negotiation",
  "Engineering Management",
  "Tech Lead Readiness",
  "Product Management",
  "Product Analytics",
  "Machine Learning",
  "Deep Learning",
  "MLOps",
  "Data Engineering",
  "SQL & Data Modelling",
  "Backend Engineering",
  "Frontend Engineering",
  "React & Next.js",
  "Mobile Development",
  "DevOps & CI/CD",
  "Cloud Architecture",
  "Kubernetes",
  "Site Reliability Engineering",
  "Security Engineering",
  "Distributed Systems",
  "Database Internals",
  "Startup Fundraising",
  "Go-to-Market Strategy",
  "UX Research",
  "UI Design Systems",
  "Technical Writing",
  "Public Speaking",
  "Study Abroad Applications",
  "MBA Admissions",
  "Campus Placements",
  "Freelancing & Consulting",
  "Personal Branding",
  "Time Management",
  "Leadership Coaching",
  "Performance Reviews",
];

export async function createTopics() {
  const names = TOPIC_POOL.slice(0, NUM_TOPICS);
  if (NUM_TOPICS > TOPIC_POOL.length) {
    console.warn(
      `Requested ${NUM_TOPICS} topics but the pool holds ${TOPIC_POOL.length}; seeding ${names.length}.`,
    );
  }
  console.log(`Creating ${names.length} topics...`);

  const topics: Topic[] = [];
  for (const name of names) {
    try {
      // Upsert rather than create: re-running the seed against a database that
      // already holds these names would otherwise fail the unique constraint.
      const topic = await prisma.topic.upsert({
        where: { name },
        update: {},
        create: { name },
      });
      topics.push(topic);
    } catch (error) {
      console.error(`Failed to create topic "${name}":`, error);
    }
  }
  console.log(`Created ${topics.length} topics`);
  return topics;
}
