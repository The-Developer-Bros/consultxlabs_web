import type {
  TConsultationWithPlan,
  TSubscriptionWithPlan,
  TWebinarWithPlan,
  TClassWithPlan,
  TTrialWithPlan,
} from "@/hooks/useEvents";

/**
 * Types for the consultee events API response
 * Matches the Prisma queries in /api/dashboard/consultee/[consulteeId]/events/route.ts
 *
 * Extends base types from hooks/useEvents with collaborator data
 * that the events API returns but the base types don't include.
 */

// Collaborator shape returned by the events API
interface ConsulteeCollaborator {
  consultantProfile: {
    user: { id: string; name: string; image: string | null };
  } | null;
  role: string;
}

// Extended webinar type with collaborators from the events API
export type TConsulteeWebinar = TWebinarWithPlan & {
  webinarPlan: {
    collaborators?: ConsulteeCollaborator[];
  };
};

// Extended class type with collaborators from the events API
export type TConsulteeClass = TClassWithPlan & {
  classPlan: {
    collaborators?: ConsulteeCollaborator[];
  };
};

// Full API response type
export interface TConsulteeEventsResponse {
  consultations: TConsultationWithPlan[];
  subscriptions: TSubscriptionWithPlan[];
  webinars: TConsulteeWebinar[];
  classes: TConsulteeClass[];
  trials: TTrialWithPlan[];
}
