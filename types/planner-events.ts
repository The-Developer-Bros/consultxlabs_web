/**
 * Planner event types.
 *
 * Moved out of `app/dashboard/consultant/[consultantId]/(features)/planner/`
 * because `lib/dashboard-queries.ts` consumes them, and a non-route layer
 * importing through a dynamic route segment inverts the dependency direction:
 * `app/` is the routing layer and should depend on `lib`, `components` and
 * `hooks`, never the reverse.
 */
import {
  TWebinar,
  TClass,
  TConsultation,
  TSubscription,
} from "@/types/appointment";
import { PlanEmailSupport, PlanLevel } from "@prisma/client";
import { ConsultationPlan, SubscriptionPlan } from "@/schemas/plans";

/**
 * Uploaded handout attached to a plan. Followed the planner components out of
 * the consultant route folder for the reason in the header above — the only
 * consumers are `components/planner/**`, and a shared component importing a
 * type through `app/dashboard/consultant/[consultantId]/` would invert the
 * dependency the same way.
 */
export interface IPlanMaterial {
  id: string;
  fileName: string;
  originalName: string;
  fileSize: number;
  mimeType: string;
  fileUrl: string;
  storagePath: string;
  description: string | null;
  order: number;
  // Plan references (one will be set)
  consultationPlanId?: string | null;
  subscriptionPlanId?: string | null;
  webinarPlanId?: string | null;
  classPlanId?: string | null;
  uploadedAt: Date;
  updatedAt?: Date;
}

// UI-focused event types with topics as string[] (transformed at service boundary)
// Services convert Topic[] from Prisma to string[] before passing to components

// `faqs` is augmented on here rather than added to the T* appointment payloads
// in types/appointment.ts: those describe a BOOKED appointment, where buyer-
// facing sales copy is irrelevant, and widening them would force a `faqs`
// include onto every appointment query in the codebase. The planner and the
// public detail pages are the only readers.
export type WebinarEvent = Omit<TWebinar, "webinarPlan"> & {
  type: "webinar";
  scheduledAt?: Date;
  // price is number at runtime via the extended client (#780)
  webinarPlan: Omit<TWebinar["webinarPlan"], "topics" | "price"> & {
    topics: string[];
    price: number;
    faqs?: PlanFaqInput[];
  };
};

export type ClassEvent = Omit<TClass, "classPlan"> & {
  type: "class";
  // price is number at runtime via the extended client (#780)
  classPlan: Omit<TClass["classPlan"], "topics" | "price"> & {
    topics: string[];
    price: number;
    faqs?: PlanFaqInput[];
  };
  // #1346 — the planner route's slot include is windowed to ±24h of now, so
  // the card's date reads this separately-fetched, unwindowed field instead.
  firstSessionAt?: string | null;
};

// Consultant profile summary type for plan events
type ConsultantProfileSummary = {
  id: string;
  userId: string;
  user: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string;
    imageUrl: string | null;
  };
};

// Plan-level event types for consultation and subscription
export type ConsultationPlanEvent = {
  type: "consultation";
  id?: string;
  consultationPlan: ConsultationPlan & {
    id?: string;
    consultantProfileId: string;
    consultantProfile?: ConsultantProfileSummary | null;
    consultations?: TConsultation[];
    // #1494 — sole-owner archive/restore toggle.
    archivedAt?: Date | null;
    createdAt?: Date;
    updatedAt?: Date;
  };
};

export type SubscriptionPlanEvent = {
  type: "subscription";
  id?: string;
  subscriptionPlan: SubscriptionPlan & {
    id?: string;
    consultantProfileId: string;
    consultantProfile?: ConsultantProfileSummary | null;
    subscriptions?: TSubscription[];
    sessionDurationInHours?: number;
    // trialEnabled/trialDurationMinutes/trialPriceInPaise come from
    // SubscriptionPlanSchema
    subscriptionContents?: SubscriptionContentInput[];
    // #1494 — sole-owner archive/restore toggle.
    archivedAt?: Date | null;
    createdAt?: Date;
    updatedAt?: Date;
  };
};

// Planner-specific event types with role annotations
export type PlannerWebinarEvent = WebinarEvent & {
  collaboratorRole: string;
  isCollaborated: boolean;
};

export type PlannerClassEvent = ClassEvent & {
  collaboratorRole: string;
  isCollaborated: boolean;
};

// Update base Event type to be a union
export type Event =
  | WebinarEvent
  | ClassEvent
  | ConsultationPlanEvent
  | SubscriptionPlanEvent;

export type EventPlannerProps = {
  isOpen: boolean;
  onClose: () => void;
  eventType: "webinar" | "class" | "consultation" | "subscription";
  initialData?: Event;
  onSave?: (
    event:
      | Partial<WebinarEvent>
      | Partial<ClassEvent>
      | Partial<ConsultationPlanEvent>
      | Partial<SubscriptionPlanEvent>,
  ) => void;
  isSaving?: boolean;
};

export type FormData = {
  title: string;
  subtitle?: string | null;
  description: string;
  price: number;
  maxParticipants: number;
  language: string;
  level: PlanLevel;
  prerequisites: string | null;
  materialProvided: string | null;
  learningOutcomes: string[];
  targetAudience?: string[];
  whatsIncluded?: string[];
  faqs?: PlanFaqInput[];
  topics: string[];
  consultantProfileId?: string | null;
  durationInHours?: number;
  durationInMonths?: number;
  sessionsPerWeek?: number;
  emailSupport?: PlanEmailSupport;
  certificateProvided?: boolean;
  recordingEnabled?: boolean;
  classContents?: ClassContentInput[];
  scheduledAt?: string | Date | null;
  priceCurrency?: string;
} & (
  | {
      durationInHours: number;
    }
  | {
      durationInMonths: number;
      sessionsPerWeek: number;
      emailSupport: "GENERAL" | "PRIORITY" | "DEDICATED";
      certificateProvided: boolean;
      classContents: ClassContentInput[];
    }
);

export type PlanFaqInput = {
  id?: string;
  question: string;
  answer: string;
  order: number;
};

interface BasePlannerProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * The consultant profile that DELIVERS the session. On the personal planner
   * this is the signed-in consultant; on the org catalog it is the EXPERT the
   * operator picked, which is why it stays a plain id rather than being read
   * from the session inside the form.
   */
  consultantId: string;
  isSaving?: boolean;
  /**
   * Org that OWNS the plan. Absent or null means a personal B2C plan, which is
   * the default and what the consultant planner passes. Only Webinar and Class
   * accept a non-null value — `ConsultationPlan`/`SubscriptionPlan` require a
   * `consultantProfileId` in the schema and so can never be solely org-owned.
   */
  organizationId?: string | null;
}

export interface WebinarPlannerProps extends BasePlannerProps {
  initialData?: WebinarEvent;
  onSave: (data: Partial<WebinarEvent>, scheduledAt?: string | Date) => void;
}

export interface ClassPlannerProps extends BasePlannerProps {
  initialData?: ClassEvent;
  onSave: (data: Partial<ClassEvent>, startDate?: string) => void;
}

export interface ConsultationPlannerProps extends BasePlannerProps {
  initialData?: ConsultationPlanEvent;
  onSave: (data: Partial<ConsultationPlanEvent>) => void | Promise<void>;
}

export interface SubscriptionPlannerProps extends BasePlannerProps {
  initialData?: SubscriptionPlanEvent;
  onSave: (data: Partial<SubscriptionPlanEvent>) => void | Promise<void>;
}

// Fields shared by both curriculum tables. They are separate models by
// design, but their authoring payload is identical apart from the owning FK.
type CurriculumItemInputBase = {
  id?: string; // Optional for new content
  title: string;
  description: string;
  contentType?: string | null;
  contentUrl?: string | null;
  order: number;
  hoursAllotted: number;
  sectionLabel?: string | null;
  outcomes?: string[];
  createdAt?: string | Date;
  updatedAt?: string | Date;
};

// Define input type for ClassContent based on usage
export type ClassContentInput = CurriculumItemInputBase & {
  classPlanId?: string;
};

// Define input type for SubscriptionContent (session roadmap)
type SubscriptionContentInput = CurriculumItemInputBase & {
  subscriptionPlanId?: string;
};

// Form-to-Event input types - used when building event data from form submissions
// These are partial/input versions that don't require all Prisma fields

export type WebinarFormInput = {
  id?: string;
  webinarPlan: {
    id?: string;
    title: string;
    description?: string | null;
    price: number;
    priceCurrency: string;
    durationInHours: number;
    maxParticipants: number;
    certificateProvided: boolean;
    language?: string | null;
    level?: string | null;
    prerequisites?: string | null;
    materialProvided?: string | null;
    learningOutcomes: string[];
    topics: string[];
    consultantProfileId: string;
  };
};

export type ClassFormInput = {
  id?: string;
  classPlan: {
    id?: string;
    title: string;
    description?: string | null;
    price: number;
    priceCurrency: string;
    durationInMonths: number;
    sessionsPerWeek: number;
    maxParticipants: number;
    certificateProvided: boolean;
    recordingEnabled: boolean;
    emailSupport: string;
    language?: string | null;
    level?: string | null;
    prerequisites?: string | null;
    materialProvided?: string | null;
    learningOutcomes: string[];
    topics: string[];
    classContents: ClassContentInput[];
    consultantProfileId: string;
  };
};
