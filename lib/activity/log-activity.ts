import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { ActivityType, Prisma } from "@prisma/client";
import type { ActivityActor } from "@/types/activity";

interface LogActivityParams {
  activityType: ActivityType;
  description: string;
  actorId: string;
  actorName: string;
  actorImage?: string | null;
  consultantProfileId: string;
  metadata?: Prisma.InputJsonValue;
  consultationId?: string;
  subscriptionId?: string;
  webinarId?: string;
  classId?: string;
  trialSessionId?: string;
}

/**
 * Creates an activity log entry for the consultant dashboard
 */
export async function logActivity({
  activityType,
  description,
  actorId,
  actorName,
  actorImage,
  consultantProfileId,
  metadata,
  consultationId,
  subscriptionId,
  webinarId,
  classId,
  trialSessionId,
}: LogActivityParams) {
  try {
    return await prisma.activityLog.create({
      data: {
        activityType,
        description,
        actorId,
        actorName,
        actorImage,
        consultantProfileId,
        metadata: metadata,
        consultationId,
        subscriptionId,
        webinarId,
        classId,
        trialSessionId,
      },
    });
  } catch (error) {
    // Non-fatal — activity logging should not break main flows
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "activity" } });
    console.warn("Failed to log activity:", error);
    return null;
  }
}

/**
 * Log consultation booked activity
 */
export async function logConsultationBooked(
  consultantProfileId: string,
  consultationId: string,
  actor: ActivityActor,
  planTitle: string,
) {
  return logActivity({
    activityType: "CONSULTATION_BOOKED",
    description: `${actor.name} booked a consultation: ${planTitle}`,
    actorId: actor.id,
    actorName: actor.name,
    actorImage: actor.image,
    consultantProfileId,
    consultationId,
    metadata: { planTitle },
  });
}

/**
 * Log consultation completed activity
 */
export async function logConsultationCompleted(
  consultantProfileId: string,
  consultationId: string,
  actor: ActivityActor,
  planTitle: string,
) {
  return logActivity({
    activityType: "CONSULTATION_COMPLETED",
    description: `Completed consultation with ${actor.name}: ${planTitle}`,
    actorId: actor.id,
    actorName: actor.name,
    actorImage: actor.image,
    consultantProfileId,
    consultationId,
    metadata: { planTitle },
  });
}

/**
 * Log consultation cancelled activity
 */
export async function logConsultationCancelled(
  consultantProfileId: string,
  consultationId: string,
  actor: ActivityActor,
  planTitle: string,
  cancelledBy: "consultant" | "consultee" | "system",
) {
  return logActivity({
    activityType: "CONSULTATION_CANCELLED",
    description: `${actor.name} cancelled consultation: ${planTitle}`,
    actorId: actor.id,
    actorName: actor.name,
    actorImage: actor.image,
    consultantProfileId,
    consultationId,
    metadata: { planTitle, cancelledBy },
  });
}

/**
 * Log subscription requested activity
 */
export async function logSubscriptionRequested(
  consultantProfileId: string,
  subscriptionId: string,
  actor: ActivityActor,
  planTitle: string,
) {
  return logActivity({
    activityType: "SUBSCRIPTION_REQUESTED",
    description: `${actor.name} requested subscription: ${planTitle}`,
    actorId: actor.id,
    actorName: actor.name,
    actorImage: actor.image,
    consultantProfileId,
    subscriptionId,
    metadata: { planTitle },
  });
}

/**
 * Log subscription approved activity
 */
export async function logSubscriptionApproved(
  consultantProfileId: string,
  subscriptionId: string,
  actor: ActivityActor,
  planTitle: string,
) {
  return logActivity({
    activityType: "SUBSCRIPTION_APPROVED",
    description: `Subscription approved for ${actor.name}: ${planTitle}`,
    actorId: actor.id,
    actorName: actor.name,
    actorImage: actor.image,
    consultantProfileId,
    subscriptionId,
    metadata: { planTitle },
  });
}

/**
 * Log subscription cancelled activity
 */
export async function logSubscriptionCancelled(
  consultantProfileId: string,
  subscriptionId: string,
  actor: ActivityActor,
  planTitle: string,
  cancelledBy: "consultant" | "consultee" | "system",
) {
  return logActivity({
    activityType: "SUBSCRIPTION_CANCELLED",
    description: `${actor.name} cancelled subscription: ${planTitle}`,
    actorId: actor.id,
    actorName: actor.name,
    actorImage: actor.image,
    consultantProfileId,
    subscriptionId,
    metadata: { planTitle, cancelledBy },
  });
}

/**
 * Log webinar registration activity
 */
export async function logWebinarRegistered(
  consultantProfileId: string,
  webinarId: string,
  actor: ActivityActor,
  webinarTitle: string,
) {
  return logActivity({
    activityType: "WEBINAR_REGISTERED",
    description: `${actor.name} registered for webinar: ${webinarTitle}`,
    actorId: actor.id,
    actorName: actor.name,
    actorImage: actor.image,
    consultantProfileId,
    webinarId,
    metadata: { webinarTitle },
  });
}

/**
 * Log class enrollment activity
 */
export async function logClassEnrolled(
  consultantProfileId: string,
  classId: string,
  actor: ActivityActor,
  classTitle: string,
) {
  return logActivity({
    activityType: "CLASS_ENROLLED",
    description: `${actor.name} enrolled in class: ${classTitle}`,
    actorId: actor.id,
    actorName: actor.name,
    actorImage: actor.image,
    consultantProfileId,
    classId,
    metadata: { classTitle },
  });
}

/**
 * Log trial session requested activity
 */
export async function logTrialRequested(
  consultantProfileId: string,
  trialSessionId: string,
  actor: ActivityActor,
  planTitle: string,
) {
  return logActivity({
    activityType: "TRIAL_REQUESTED",
    description: `${actor.name} requested a trial: ${planTitle}`,
    actorId: actor.id,
    actorName: actor.name,
    actorImage: actor.image,
    consultantProfileId,
    trialSessionId,
    metadata: { planTitle },
  });
}

/**
 * Log trial session scheduled activity
 */
export async function logTrialScheduled(
  consultantProfileId: string,
  trialSessionId: string,
  actor: ActivityActor,
  planTitle: string,
  scheduledTime: Date,
) {
  return logActivity({
    activityType: "TRIAL_SCHEDULED",
    description: `Scheduled trial session with ${actor.name}: ${planTitle}`,
    actorId: actor.id,
    actorName: actor.name,
    actorImage: actor.image,
    consultantProfileId,
    trialSessionId,
    metadata: { planTitle, scheduledTime: scheduledTime.toISOString() },
  });
}

/**
 * Log trial session completed activity
 */
export async function logTrialCompleted(
  consultantProfileId: string,
  trialSessionId: string,
  actor: ActivityActor,
  planTitle: string,
) {
  return logActivity({
    activityType: "TRIAL_COMPLETED",
    description: `Completed trial session with ${actor.name}: ${planTitle}`,
    actorId: actor.id,
    actorName: actor.name,
    actorImage: actor.image,
    consultantProfileId,
    trialSessionId,
    metadata: { planTitle },
  });
}

/**
 * Log trial converted to subscription activity
 */
export async function logTrialConverted(
  consultantProfileId: string,
  trialSessionId: string,
  subscriptionId: string,
  actor: ActivityActor,
  planTitle: string,
) {
  return logActivity({
    activityType: "TRIAL_CONVERTED",
    description: `${actor.name} subscribed after trial: ${planTitle}`,
    actorId: actor.id,
    actorName: actor.name,
    actorImage: actor.image,
    consultantProfileId,
    trialSessionId,
    subscriptionId,
    metadata: { planTitle },
  });
}

/**
 * Log review submitted activity
 */
export async function logReviewSubmitted(
  consultantProfileId: string,
  actor: ActivityActor,
  rating: number,
) {
  return logActivity({
    activityType: "REVIEW_SUBMITTED",
    description: `${actor.name} left a ${rating}-star review`,
    actorId: actor.id,
    actorName: actor.name,
    actorImage: actor.image,
    consultantProfileId,
    metadata: { rating },
  });
}

/**
 * Get recent activities for a consultant
 */
export async function getRecentActivities(
  consultantProfileId: string,
  limit: number = 10,
) {
  return prisma.activityLog.findMany({
    where: { consultantProfileId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
