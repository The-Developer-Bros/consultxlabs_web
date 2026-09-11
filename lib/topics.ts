/**
 * Topic utilities for API routes
 *
 * Centralizes topic handling logic:
 * - Finding/creating topics by name
 * - Transforming topic objects to strings for API responses
 */

import prisma, { type Tx } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

/**
 * Find existing topics or create new ones by name
 * Returns array of topic IDs for Prisma connect
 */
export async function findOrCreateTopics(
  topicNames: string[],
  db: Tx | typeof prisma = prisma,
): Promise<string[]> {
  if (!topicNames || topicNames.length === 0) {
    return [];
  }

  // Find existing topics
  const existingTopics = await db.topic.findMany({
    where: {
      name: { in: topicNames },
    },
    select: { id: true, name: true },
  });

  const existingNames = new Set(existingTopics.map((t) => t.name));
  const newNames = topicNames.filter((name) => !existingNames.has(name));

  // Create new topics
  let newTopicIds: string[] = [];
  if (newNames.length > 0) {
    // Use createMany for efficiency, then fetch the created IDs
    await db.topic.createMany({
      data: newNames.map((name) => ({ name })),
      skipDuplicates: true,
    });

    const newTopics = await db.topic.findMany({
      where: { name: { in: newNames } },
      select: { id: true },
    });
    newTopicIds = newTopics.map((t) => t.id);
  }

  return [...existingTopics.map((t) => t.id), ...newTopicIds];
}

/**
 * Build Prisma connect clause for topics
 * Use this when creating/updating entities with topics
 */
export function buildTopicsConnect(
  topicIds: string[],
): Prisma.TopicUpdateManyWithoutWebinarPlansNestedInput {
  if (!topicIds || topicIds.length === 0) {
    return { set: [] };
  }
  return {
    set: topicIds.map((id) => ({ id })),
  };
}

/**
 * Transform topic objects to strings for API response
 * Call this before returning data from API routes
 */
export function transformTopicsToStrings<
  T extends { topics?: { name: string }[] },
>(data: T): Omit<T, "topics"> & { topics: string[] } {
  const { topics, ...rest } = data;
  return {
    ...rest,
    topics: topics?.map((t) => t.name) ?? [],
  } as Omit<T, "topics"> & { topics: string[] };
}

/**
 * Transform nested plan with topics (e.g., classPlan, webinarPlan)
 * Use planKey as string to handle dynamic property access
 */
export function transformNestedPlanTopics<T extends Record<string, unknown>>(
  data: T,
  planKey: string,
): T {
  const plan = data[planKey] as { topics?: { name: string }[] } | undefined;
  if (!plan || !plan.topics) {
    return data;
  }

  return {
    ...data,
    [planKey]: {
      ...plan,
      topics: plan.topics.map((t: { name: string }) => t.name),
    },
  };
}

/**
 * Transform an array of items with nested plan topics
 */
export function transformArrayWithPlanTopics<T extends Record<string, unknown>>(
  items: T[],
  planKey: string,
): T[] {
  return items.map((item) => transformNestedPlanTopics(item, planKey));
}
