/**
 * Type definitions for Planner Service API request payloads
 *
 * NOTE: Response types should use Prisma types directly:
 * - TWebinar, TClass from @/types/appointment.ts
 * - ConsultationPlan, SubscriptionPlan from @/schemas/plans.ts (Zod-inferred)
 *
 * These payload types are for API requests only.
 */

import { PlanEmailSupport } from "@prisma/client";

// Request payload types for creating/updating entities

/** Buyer-facing FAQ entry, mirroring PlanFaqSchema's input shape. */
export interface PlanFaqPayload {
  id?: string;
  question: string;
  answer: string;
  order?: number;
}

export interface CreateWebinarPayload {
  title: string;
  description?: string;
  price: number;
  priceCurrency?: string;
  durationInHours: number;
  maxParticipants: number;
  certificateProvided?: boolean;
  recordingEnabled?: boolean;
  recordingStoragePolicy?: "STREAM_ONLY" | "PERMANENT";
  language?: string;
  level?: string;
  prerequisites?: string;
  materialProvided?: string;
  learningOutcomes?: string[];
  topics?: string[];
  subtitle?: string | null;
  targetAudience?: string[];
  whatsIncluded?: string[];
  faqs?: PlanFaqPayload[];
  consultantProfileId: string;
  scheduledAt?: Date | string | null;
}

export interface CreateClassPayload {
  title: string;
  description: string;
  price: number;
  priceCurrency?: string;
  durationInMonths: number;
  sessionsPerWeek: number;
  maxParticipants: number;
  certificateProvided?: boolean;
  recordingEnabled?: boolean;
  recordingStoragePolicy?: "STREAM_ONLY" | "PERMANENT";
  emailSupport?: PlanEmailSupport;
  language?: string;
  level?: string;
  prerequisites?: string;
  materialProvided?: string;
  learningOutcomes?: string[];
  topics?: string[];
  subtitle?: string | null;
  targetAudience?: string[];
  whatsIncluded?: string[];
  faqs?: PlanFaqPayload[];
  classContents?: ClassContentInput[];
  consultantProfileId: string;
  /** ISO string to set; `null` clears; omit to leave unchanged on PATCH. */
  startDate?: string | null;
}

export interface ClassContentInput {
  id?: string;
  title: string;
  description: string;
  contentType?: string | null;
  contentUrl?: string | null;
  order: number;
  hoursAllotted: number;
}

// Update payload types extend create types with optional id fields
export interface UpdateClassPayload extends CreateClassPayload {
  id: string;
  classId?: string;
}

export interface UpdateWebinarPayload extends CreateWebinarPayload {
  id: string;
  webinarId?: string;
}

// Union types for request bodies
export type ClassRequestBody = CreateClassPayload | UpdateClassPayload;
export type WebinarRequestBody = CreateWebinarPayload | UpdateWebinarPayload;
