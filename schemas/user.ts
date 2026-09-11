// schemas/user.ts
import { z } from "zod";
import { UserRole } from "@prisma/client";
import { experienceValidation } from "./shared";
import { DateOfBirthSchema } from "@/lib/compliance/age";

// #region Enums

export const GenderEnum = z.enum([
  "MALE",
  "FEMALE",
  "NON_BINARY",
  "PREFER_NOT_TO_SAY",
]);

export const CareerStageEnum = z.enum([
  "SCHOOL_STUDENT",
  "STUDENT",
  "EARLY_CAREER",
  "MID_CAREER",
  "SENIOR",
  "EXECUTIVE",
]);

export const BudgetPreferenceEnum = z.enum([
  "BUDGET",
  "MODERATE",
  "PREMIUM",
  "FLEXIBLE",
]);

export const SessionTypeEnum = z.enum(["ONE_ON_ONE", "GROUP", "ASYNC_REVIEW"]);

// Derived from Prisma, not hand-listed: this drifted when ORG_WORKSPACE landed,
// which made Partial<OnboardingFormData> unassignable to every step-form prop
// type in app/form/onboarding and forced a chain of casts at the call sites.
export const UserRoleEnum = z.nativeEnum(UserRole);

export const ScheduleTypeEnum = z.enum(["WEEKLY", "CUSTOM"]);

export const DayOfWeekEnum = z.enum([
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
]);

// #endregion

// #region URL Validation Helpers

export const linkedinUrlSchema = z
  .string()
  .url("Please enter a valid URL")
  .refine(
    (url) => url.includes("linkedin.com"),
    "Please enter a valid LinkedIn URL (e.g., linkedin.com/in/yourprofile)",
  )
  .optional()
  .or(z.literal(""));

export const twitterUrlSchema = z
  .string()
  .url("Please enter a valid URL")
  .refine(
    (url) => url.includes("twitter.com") || url.includes("x.com"),
    "Please enter a valid Twitter/X URL",
  )
  .optional()
  .or(z.literal(""));

export const githubUrlSchema = z
  .string()
  .url("Please enter a valid URL")
  .refine(
    (url) => url.includes("github.com"),
    "Please enter a valid GitHub URL",
  )
  .optional()
  .or(z.literal(""));

export const websiteUrlSchema = z
  .string()
  .url("Please enter a valid website URL")
  .optional()
  .or(z.literal(""));

// #endregion

// #region Base User Schema

export const PersonalInfoAndRoleSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  emailVerified: z.date().optional(),
  image: z.string().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  onlineStatus: z.boolean().optional().default(false),
  timezone: z.string().optional(),
  onboardingCompleted: z.boolean().optional().default(false),
  role: UserRoleEnum,
  // New fields
  dateOfBirth: DateOfBirthSchema,
  gender: GenderEnum.optional().nullable(),
  city: z.string().optional(),
  country: z.string().optional(),
  linkedinUrl: linkedinUrlSchema,
  bio: z.string().max(160, "Bio must be 160 characters or less").optional(),
});

export type PersonalInfoAndRole = z.infer<typeof PersonalInfoAndRoleSchema>;

// #endregion

// #region Slot Schemas

export const WeeklySlotSchema = z.object({
  startDay: DayOfWeekEnum,
  startTimeUtc: z.number().int().min(0).max(1439),
  endDay: DayOfWeekEnum,
  endTimeUtc: z.number().int().min(0).max(1439),
});

export const CustomSlotSchema = z.object({
  startsAt: z.string(),
  endsAt: z.string(),
});

// #endregion

// #region Professional Background Schemas

/**
 * Ceilings for the free-text fields a user can paste into.
 *
 * These are the fields with no natural length: a pasted résumé section, a job
 * description copied out of an offer letter. They are also the ONLY realistic
 * way an onboarding draft reaches the 64KB payload cap, after which autosave
 * silently stops (#onboarding-ux). Every cap here is paired with a `maxLength`
 * on the input that writes it, so the browser refuses the paste rather than
 * letting Zod reject the whole step afterwards.
 *
 * Sized against the fields that were already capped — `bio` at 160 for a
 * one-liner, verification notes at 500 for a paragraph — so 2000 is "several
 * paragraphs" and 500 is "a line or two".
 */
export const LONG_FORM_TEXT_MAX = 2000;
export const SHORT_FORM_TEXT_MAX = 500;

export const WorkExperienceSchema = z.object({
  id: z.string().optional(),
  company: z.string().min(1, "Company name is required"),
  companyDomain: z.string().optional(),
  title: z.string().min(1, "Job title is required"),
  location: z.string().optional(),
  startDate: z.coerce.date({ required_error: "Start date is required" }),
  endDate: z.coerce.date().optional().nullable(),
  isCurrent: z.boolean().default(false),
  description: z
    .string()
    .max(
      LONG_FORM_TEXT_MAX,
      `Description must be ${LONG_FORM_TEXT_MAX} characters or less`,
    )
    .optional(),
});

export type WorkExperience = z.infer<typeof WorkExperienceSchema>;

export const CertificationSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, "Certification name is required"),
  issuingOrganization: z.string().min(1, "Issuing organization is required"),
  issueDate: z.coerce.date({ required_error: "Issue date is required" }),
  expiryDate: z.coerce.date().optional().nullable(),
  credentialId: z.string().optional(),
  credentialUrl: websiteUrlSchema,
});

export type Certification = z.infer<typeof CertificationSchema>;

export const EducationSchema = z.object({
  id: z.string().optional(),
  institution: z.string().min(1, "Institution name is required"),
  institutionDomain: z.string().optional(),
  degree: z.string().min(1, "Degree is required"),
  fieldOfStudy: z.string().optional(),
  startYear: z.number().min(1900).max(2100).optional().nullable(),
  endYear: z.number().min(1900).max(2100).optional().nullable(),
  grade: z.string().optional(),
  activities: z
    .string()
    .max(
      SHORT_FORM_TEXT_MAX,
      `Activities must be ${SHORT_FORM_TEXT_MAX} characters or less`,
    )
    .optional(),
  description: z
    .string()
    .max(
      LONG_FORM_TEXT_MAX,
      `Description must be ${LONG_FORM_TEXT_MAX} characters or less`,
    )
    .optional(),
});

export type Education = z.infer<typeof EducationSchema>;

// #endregion

// #region Consultant Profile Schema

export const ConsultantProfileSchema = z.object({
  description: z
    .string()
    .max(
      LONG_FORM_TEXT_MAX,
      `Description must be ${LONG_FORM_TEXT_MAX} characters or less`,
    )
    .optional(),
  experience: experienceValidation,
  rating: z.number().default(0),

  // New fields
  headline: z
    .string()
    .max(120, "Headline must be 120 characters or less")
    .optional(),
  websiteUrl: websiteUrlSchema,
  twitterUrl: twitterUrlSchema,
  githubUrl: githubUrlSchema,
  videoIntroUrl: websiteUrlSchema,
  languages: z.array(z.string()).default([]),
  toolsAndTechnologies: z.array(z.string()).default([]),
  mentoringStyle: z
    .string()
    .max(
      SHORT_FORM_TEXT_MAX,
      `Mentoring style must be ${SHORT_FORM_TEXT_MAX} characters or less`,
    )
    .optional(),
  sessionTypes: z.array(SessionTypeEnum).default([]),
  profileCompletionPercentage: z.number().min(0).max(100).default(0),
  isVerified: z.boolean().default(false),
  totalMenteesHelped: z.number().default(0),

  // Deprecated fields (kept for backward compatibility)
  qualifications: z.string().optional(),
  specialization: z.string().optional(),

  // Domain and expertise
  domain: z.object({
    id: z.string(),
    name: z.string(),
  }),
  subDomains: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      domainId: z.string(),
    }),
  ),
  tags: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      domainId: z.string(),
    }),
  ),

  // Scheduling
  scheduleType: ScheduleTypeEnum,
  weeklySlots: z.array(WeeklySlotSchema).optional(),
  customSlots: z.array(CustomSlotSchema).optional(),

  // Professional background (new nested models)
  workExperiences: z.array(WorkExperienceSchema).optional(),
  certifications: z.array(CertificationSchema).optional(),
  education: z.array(EducationSchema).optional(),
});

// #endregion

// #region Consultee Profile Schema

export const ConsulteeProfileSchema = z.object({
  aboutMe: z.string().optional(),
  preferredLanguage: z.string().optional(),
  goals: z.string().optional(),

  careerStage: CareerStageEnum.optional().nullable(),
  skillsToDevelop: z.array(z.string()).default([]),
  budgetPreference: BudgetPreferenceEnum.optional().nullable(),
});

export type ConsulteeProfile = z.infer<typeof ConsulteeProfileSchema>;

export const ConsulteePreferencesSchema = z.object({
  preferredLanguage: z.string().optional(),
  budgetPreference: BudgetPreferenceEnum.optional().nullable(),
  // Deprecated
  specialRequirements: z.string().optional(),
  interests: z.array(z.string()).optional(),
  goals: z.string().optional(),
});

export type ConsulteePreferences = z.infer<typeof ConsulteePreferencesSchema>;

// #endregion

// #region Staff Profile Schema

export const StaffProfileSchema = z.object({
  department: z.string().optional(),
  position: z.string().optional(),
});

export type StaffProfile = z.infer<typeof StaffProfileSchema>;

// #endregion

// #region Admin Profile Schema

export const AdminProfileSchema = z.object({
  notes: z.string().optional(),
});

// #endregion

// #region Schedule Schemas

export const PreferredScheduleSchema = z.object({
  scheduleType: ScheduleTypeEnum,
  weeklySlots: z.array(WeeklySlotSchema).optional(),
  customSlots: z.array(CustomSlotSchema).optional(),
});

export type PreferredSchedule = z.infer<typeof PreferredScheduleSchema>;

// #endregion

// #region Preferences Schemas

export const CookiePreferenceSchema = z.object({
  // Essential: Required for core functionality - authentication, security, CSRF tokens
  // Cannot be disabled by users. Examples: BetterAuth session, security tokens
  essential: z.boolean().default(true),

  // Analytics: Usage tracking and performance measurement
  // Examples: Google Analytics (GA4), Hotjar, Mixpanel, PostHog, Amplitude
  analytics: z.boolean().default(false),

  // Marketing: Advertising and retargeting
  // Examples: Facebook Pixel, Google Ads, LinkedIn Insight Tag, TikTok Pixel
  marketing: z.boolean().default(false),

  // Functional: Enhanced features and third-party integrations
  // Examples: Live chat (Intercom, Crisp), video embeds, social sharing, personalization
  functional: z.boolean().default(false),
});

export const NotificationPreferenceSchema = z.object({
  allNotifications: z.boolean().default(true),

  // Channel preferences
  inAppEnabled: z.boolean().default(true),
  emailEnabled: z.boolean().default(true),
  pushEnabled: z.boolean().default(false),

  // Legacy category preferences (kept for backward compatibility)
  mentions: z.boolean().default(false),
  directMessages: z.boolean().default(false),
  updates: z.boolean().default(false),

  // Category preferences
  appointmentReminders: z.boolean().default(true),
  paymentNotifications: z.boolean().default(true),
  supportUpdates: z.boolean().default(true),
  feedbackAlerts: z.boolean().default(true),
  trialNotifications: z.boolean().default(true),
  subscriptionAlerts: z.boolean().default(true),
  marketingEmails: z.boolean().default(false),

  // Org category preferences (ADR 23) — the categories above are all
  // B2C-shaped, which left the ORG_* workflow family unmutable.
  orgBillingAlerts: z.boolean().default(true),
  orgMembershipAlerts: z.boolean().default(true),
  orgProgramAlerts: z.boolean().default(true),

  // Quiet hours
  quietHoursEnabled: z.boolean().default(false),
  quietHoursStart: z.string().nullable().default(null),
  quietHoursEnd: z.string().nullable().default(null),
  quietHoursTimezone: z.string().nullable().default(null),
});

export type NotificationPreference = z.infer<
  typeof NotificationPreferenceSchema
>;

/** Schema for partial updates to notification preferences (PUT endpoint). */
export const NotificationPreferenceUpdateSchema =
  NotificationPreferenceSchema.partial();

// #endregion

// #region Combined/Full User Schema

export const FullUserSchema = z.object({
  id: z.string(),
  ...PersonalInfoAndRoleSchema.shape,
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
  consultantProfile: ConsultantProfileSchema.optional().nullable(),
  consulteeProfile: ConsulteeProfileSchema.optional().nullable(),
  staffProfile: StaffProfileSchema.optional().nullable(),
  adminProfile: AdminProfileSchema.optional().nullable(),
  cookiePreferences: CookiePreferenceSchema.optional().nullable(),
  notificationPreferences: NotificationPreferenceSchema.optional().nullable(),
});

// #endregion
