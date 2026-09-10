/**
 * Shared types for Staff Moderation API responses.
 * Used by both the API route and the frontend page.
 */

interface VerificationWorkExperience {
  id: string;
  company: string;
  title: string;
  startDate: string;
  endDate: string | null;
  current: boolean;
}

interface VerificationEducation {
  id: string;
  institution: string;
  degree: string;
  field: string;
  startYear: number;
  endYear: number | null;
}

interface VerificationCertification {
  id: string;
  name: string;
  issuer: string;
  issueDate: string;
}

interface VerificationConsultant {
  profileId: string;
  userId: string;
  name: string | null;
  email: string;
  image: string | null;
  linkedinUrl: string | null;
  bio: string | null;
  domain: string;
  subDomains: { id: string; name: string }[];
  experience: number | null;
  headline: string | null;
  description: string | null;
  isVerified: boolean;
  verificationStatus: string;
  workExperiences: VerificationWorkExperience[];
  education: VerificationEducation[];
  certifications: VerificationCertification[];
}

interface VerificationDocument {
  id: string;
  fileName: string;
  originalName: string;
  fileSize: number;
  mimeType: string;
  fileUrl: string;
  description: string | null;
}

export interface ProfileVerification {
  id: string;
  status: string;
  submittedAt: string;
  notes: string | null;
  rejectionReason?: string | null;
  feedbackDetails?: string | null;
  consultant: VerificationConsultant;
  documents: VerificationDocument[];
  reviewedAt: string | null;
  reviewedById: string | null;
  reviewNotes: string | null;
}

/** How far each best-effort step of a moderation action actually got. */
export type ModerationStepStatus = "ok" | "failed" | "skipped" | "gave_up";

/**
 * The persisted outcome of an action's side-effects, written by
 * `lib/moderation/side-effects.ts`. Until #1270 the client type omitted
 * `stream` and `errors`, so a ban whose Stream revocation failed was reported
 * to the moderator as a clean success.
 */
export interface ModerationSideEffects {
  sessionsRevoked?: number;
  earningsHeld?: number;
  profilesUnverified?: number;
  reviewRemoved?: boolean;
  banExpires?: string | null;
  cancellations?: {
    engagementsCancelled?: number;
    refundsIssued?: number;
  };
  stream?: ModerationStepStatus;
  streamAttempts?: number;
  notification?: ModerationStepStatus;
  errors?: string[];
}

export interface ModerationLatestAction {
  id: string;
  actionType: string;
  createdAt: string;
  sideEffects: ModerationSideEffects | null;
}

/**
 * The report shape `GET /api/staff/moderation/reports` actually returns.
 *
 * It used to name the two user relations `reporter` and `reportedUser`, which
 * the route has never sent — every card and the whole review modal threw on the
 * first report that reached them, and the queue only looked healthy because it
 * is usually empty.
 */
export interface ModerationReport {
  id: string;
  type: string;
  reason: string;
  description: string | null;
  contentText: string | null;
  contentUrl: string | null;
  streamMessageId: string | null;
  streamChannelCid: string | null;
  reportCount: number;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  reviewId: string | null;
  assignedToId: string | null;
  actionCount: number;
  latestAction: ModerationLatestAction | null;
  reportedBy: {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
  };
  targetUser: {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
    role: string;
    banned: boolean | null;
    banExpires: string | null;
  };
}

/** What the viewer is allowed to do, decided server-side (#1270). */
export interface ModerationCapabilities {
  canModerateUsers: boolean;
}

export interface ModerationReview {
  id: string;
  rating: number;
  comment: string | null;
  createdAt: string;
  consultee: {
    id: string;
    name: string | null;
    image: string | null;
  } | null;
  consultation: {
    consultant: {
      user: {
        id: string;
        name: string | null;
        image: string | null;
      } | null;
    } | null;
  } | null;
}

export interface ModerationStats {
  pendingReports: number;
  pendingProfiles: number;
  pendingReviews: number;
  resolvedToday: number;
}
