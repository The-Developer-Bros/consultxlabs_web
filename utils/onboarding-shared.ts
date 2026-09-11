import { z } from "zod";
import type {
  ConsultantProfileCreateData,
  ConsulteeProfileCreateData,
  StaffProfileCreateData,
  AdminProfileCreateData,
} from "./onboarding";
import type { OnboardingData } from "./onboarding";
import {
  WorkExperienceSchema,
  EducationSchema,
  CertificationSchema,
} from "@/schemas/user";
import { AchievementCreateInputSchema } from "./onboarding";

// ============================================================================
// USER FIELD EXTRACTION
// ============================================================================

/** Extract user-level fields from validated onboarding data for Prisma update */
export function buildUserUpdateData(data: OnboardingData) {
  return {
    name: data.name,
    email: data.email,
    phone: data.phone || null,
    address: data.address,
    role: data.role,
    onboardingCompleted: true,
    timezone: data.timezone,
    dateOfBirth: data.dateOfBirth ?? null,
    gender: data.gender ?? null,
    city: data.city ?? null,
    country: data.country ?? null,
    linkedinUrl: data.linkedinUrl || null,
    bio: data.bio ?? null,
    ...(data.termsAcceptedAt ? { termsAcceptedAt: data.termsAcceptedAt } : {}),
    ...(data.privacyAcceptedAt ? { privacyAcceptedAt: data.privacyAcceptedAt } : {}),
  };
}

// ============================================================================
// PROFILE DATA BUILDERS (shared between create & update)
// ============================================================================

/** Build the scalar (non-relational) data for a consultant profile upsert */
export function buildConsultantScalarData(data: ConsultantProfileCreateData) {
  return {
    description: data.description ?? "",
    experience: data.experience ?? null,
    scheduleType: data.scheduleType,
    headline: data.headline ?? null,
    websiteUrl: data.websiteUrl || null,
    twitterUrl: data.twitterUrl || null,
    githubUrl: data.githubUrl || null,
    videoIntroUrl: data.videoIntroUrl || null,
    languages: data.languages ?? [],
    toolsAndTechnologies: data.toolsAndTechnologies ?? [],
    mentoringStyle: data.mentoringStyle ?? null,
    sessionTypes: data.sessionTypes ?? [],
  };
}

/** Build the scalar data for a consultee profile upsert */
export function buildConsulteeScalarData(data: ConsulteeProfileCreateData) {
  // Defensive: goals is typed as string after Zod validation, but older clients
  // may send string[] — the Array.isArray guard handles that safely at runtime.
  const goals = Array.isArray(data.goals)
    ? (data.goals as string[]).join(", ")
    : (data.goals ?? "");

  return {
    aboutMe: data.aboutMe ?? "",
    preferredLanguage: data.preferredLanguage ?? "",
    goals,
    careerStage: data.careerStage ?? null,
    skillsToDevelop: data.skillsToDevelop ?? [],
    budgetPreference: data.budgetPreference ?? null,
  };
}

/** Build the scalar data for a staff profile upsert */
export function buildStaffScalarData(data: StaffProfileCreateData) {
  return {
    department: data.department ?? "",
    position: data.position ?? "",
  };
}

/** Build the scalar data for an admin profile upsert */
export function buildAdminScalarData(data: AdminProfileCreateData) {
  return {
    notes: data.notes ?? null,
  };
}

// ============================================================================
// VERIFICATION POLICY (pure)
// ============================================================================

/** Minimal shape of the verification-related fields on an onboarding body.
 *  Structural typing keeps this importable from both the server pipeline and
 *  tests without touching the "server-only" module graph. */
export interface VerificationSignals {
  verificationLinkedinUrl?: string;
  verificationDocuments?: unknown[];
}

/**
 * Does this entry carry enough data for submitVerificationRequest to actually
 * persist or link it? Pure and structural so the deferral policy below and
 * the server-side persistence filters can never disagree on what counts as a
 * real document — mirrors exactly the two branches that create/link rows:
 *   - an existing record uploaded earlier via /api/verification/documents
 *   - an onboarding upload carrying its storage URL
 * An empty object like `{}` satisfies neither, so it must not start a review.
 */
export function isPersistableVerificationDoc(doc: unknown): boolean {
  if (typeof doc !== "object" || doc === null) return false;
  const d = doc as Record<string, unknown>;
  return Boolean(
    (d.id && !d.isOnboardingUpload) ||
      d.isOnboardingUpload ||
      (!d.id && d.fileUrl),
  );
}

/**
 * Decide whether a consultant submission carries everything the verification
 * review needs. Both signals are required for an immediate review; anything
 * less defers to the dashboard's VerificationSection, which already owns the
 * post-onboarding submit/resubmit loop (#onboarding-ux).
 */
export function shouldSubmitVerification(body: VerificationSignals): {
  hasDocuments: boolean;
  hasLinkedin: boolean;
} {
  return {
    hasDocuments:
      Array.isArray(body.verificationDocuments) &&
      body.verificationDocuments.some(isPersistableVerificationDoc),
    hasLinkedin: Boolean(body.verificationLinkedinUrl?.trim()),
  };
}

// ============================================================================
// PROFESSIONAL BACKGROUND VALIDATION
// ============================================================================

/** Validates and parses professional background arrays from raw body using Zod schemas.
 *  Returns validated data or null if input is missing/invalid. */
export function validateProfessionalBackground(body: Record<string, unknown>) {
  const workExperiences = Array.isArray(body.workExperiences)
    ? z.array(WorkExperienceSchema).safeParse(body.workExperiences)
    : null;

  const educationHistory = Array.isArray(body.educationHistory)
    ? z.array(EducationSchema).safeParse(body.educationHistory)
    : null;

  const certificationsList = Array.isArray(body.certificationsList)
    ? z.array(CertificationSchema).safeParse(body.certificationsList)
    : null;

  const achievements = Array.isArray(body.achievements)
    ? z.array(AchievementCreateInputSchema).safeParse(body.achievements)
    : null;

  return {
    workExperiences:
      workExperiences?.success ? workExperiences.data : null,
    educationHistory:
      educationHistory?.success ? educationHistory.data : null,
    certificationsList:
      certificationsList?.success ? certificationsList.data : null,
    achievements: achievements?.success ? achievements.data : null,
  };
}
