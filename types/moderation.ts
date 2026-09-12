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
  // #1300 — #1580 C-P0-4 added these to the write side; the client type never
  // followed, so a ban's collaborator fallout was invisible on this queue.
  collaborationsRemoved?: { planType: string; planId: string }[];
  collaboratorRevocation?: ModerationStepStatus;
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
  // #1300 — who acted and why, so the card's audit line is not just a verb.
  notes: string | null;
  takenBy: { name: string | null } | null;
}

/** What a REVIEW report is about — the review's content and its author. */
export interface ModerationReportReviewSubject {
  id: string;
  rating: number;
  reviewDescription: string | null;
  consultantProfile: { user: { name: string | null } };
}

/** One row of `ModerationReport.actions`, as the detail route returns it. */
export interface ModerationReportAction {
  id: string;
  actionType: string;
  notes: string | null;
  createdAt: string;
  sideEffects: ModerationSideEffects | null;
  // SetNull (#1590): a departed staff account leaves this null, not the row.
  takenBy: { id: string; name: string | null; email: string } | null;
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
  // #1300 — set only for a REVIEW report; the card's title is the review, not the id.
  review: ModerationReportReviewSubject | null;
  assignedToId: string | null;
  actionCount: number;
  latestAction: ModerationLatestAction | null;
  reportedBy: {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
    role: string;
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

/**
 * `GET /api/staff/moderation/reports/[reportId]` — only the field the drawer
 * fetches this route for: the full history, oldest first. Everything else
 * about the report is already on hand from the list row that opened it.
 */
export interface ModerationReportDetail {
  id: string;
  actions: ModerationReportAction[];
}

/** What the viewer is allowed to do, decided server-side (#1270). */
export interface ModerationCapabilities {
  canModerateUsers: boolean;
}

/** Who removed a review or its reply — `lib/moderation/side-effects.ts` writes MODERATION; the author writes their own. */
export type ModerationReviewActor = "AUTHOR" | "MODERATION";

/** One row of `ConsultantReview.moderationActions`, newest first (#1562). */
export interface ModerationReviewAction {
  actionType: string;
  notes: string | null;
  createdAt: string;
  takenBy: { id: string; name: string | null } | null;
}

/**
 * `GET /api/staff/moderation/reviews` — the shape the route actually
 * returns. It used to be read as `consultee`/`consultation.consultant`,
 * fields the route has never sent, so every review card on this tab rendered
 * its "Anonymous" / "Consultant" fallbacks regardless of the real names.
 */
export interface ModerationReview {
  id: string;
  rating: number;
  reviewDescription: string | null;
  consultant: {
    profileId: string;
    name: string | null;
    email: string;
    image: string | null;
  };
  reviewer: {
    profileId: string;
    name: string | null;
    email: string;
    image: string | null;
  };
  createdAt: string;
  deletedAt: string | null;
  removedBy: ModerationReviewActor | null;
  isAnonymous: boolean;
  replyBody: string | null;
  repliedAt: string | null;
  replyDeletedAt: string | null;
  replyRemovedBy: ModerationReviewActor | null;
  editedAt: string | null;
  moderationActions: ModerationReviewAction[];
}

export interface ModerationStats {
  pendingReports: number;
  pendingProfiles: number;
  pendingReviews: number;
  resolvedToday: number;
}
