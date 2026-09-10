import { DocumentReviewStatus } from "@prisma/client";

/**
 * Server-side document review invariants: per-appointment count caps,
 * upload gates, and the review status transition guard. DB access is
 * deliberately not parameterized here — the $extends-wrapped client and a
 * transaction client are not mutually assignable at the type level, so each
 * route inlines its own reads against whichever handle it holds.
 */

/** Hard ceiling on live (non-deleted) documents per appointment, both roles. */
export const MAX_DOCS_PER_APPOINTMENT = 20;

/** Grace window before the nightly cleanup job purges soft-deleted rows. */
export const DOCUMENT_DELETE_GRACE_DAYS = 7;

/** Shared upload gates — one definition so both roles can't drift apart. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // 10MB

const ALLOWED_DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "text/plain",
] as const;

export type DocumentUploadValidation =
  | { ok: true }
  | {
      ok: false;
      code: "FILE_TOO_LARGE" | "UNSUPPORTED_FILE_TYPE";
      message: string;
    };

/**
 * Size + MIME gate shared by the consultee and consultant upload routes.
 * Keeping it here (not inline) is what stopped the two routes' limits from
 * drifting apart historically — and keeps the handlers themselves lean
 * enough for Sonar's complexity budget.
 */
export function validateDocumentUpload(file: {
  size: number;
  type: string;
}): DocumentUploadValidation {
  if (file.size === 0 || file.size > MAX_DOCUMENT_BYTES) {
    return {
      ok: false,
      code: "FILE_TOO_LARGE",
      message: `Please select a file larger than 0 bytes and smaller than ${Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024)}MB.`,
    };
  }
  if (!ALLOWED_DOCUMENT_MIME_TYPES.includes(file.type as never)) {
    return {
      ok: false,
      code: "UNSUPPORTED_FILE_TYPE",
      message:
        'The file type "' +
        file.type +
        '" is not supported. Please upload a PDF, Word document, image (JPG, PNG, GIF), or text file.',
    };
  }
  return { ok: true };
}

/**
 * Derived from the GENERATED enum so a new DocumentReviewStatus is a
 * compile error here (the transitions map below must decide its fate), not a
 * silently-unhandled string.
 */
export type ReviewStatus = keyof typeof DocumentReviewStatus;

/**
 * Allowed transitions of `DocumentReviewStatus`. APPROVED and REJECTED are
 * terminal — reopening a decided review would silently rewrite history that
 * notifications and the consultee already acted on; the correct move for a
 * mistake is a threaded follow-up upload or a new submission.
 */
const REVIEW_TRANSITIONS: Record<ReviewStatus, readonly ReviewStatus[]> = {
  PENDING: ["IN_REVIEW", "APPROVED", "REJECTED", "NEEDS_REVISION"],
  IN_REVIEW: ["PENDING", "APPROVED", "REJECTED", "NEEDS_REVISION"],
  NEEDS_REVISION: ["PENDING", "IN_REVIEW", "APPROVED", "REJECTED"],
  APPROVED: [],
  REJECTED: [],
};

export function isReviewTransitionAllowed(
  from: ReviewStatus,
  to: ReviewStatus,
): boolean {
  return REVIEW_TRANSITIONS[from].includes(to);
}

/**
 * Retry helper for the threaded-create transactions: two concurrent uploads
 * can compute the same next versionNo; the sidecar unique index turns the
 * loser into P2002, which re-runs the whole resolve-and-insert.
 */
export async function withVersionConflictRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (
        attempt < 2 &&
        typeof error === "object" &&
        error !== null &&
        (error as { code?: string }).code === "P2002"
      ) {
        attempt += 1;
        continue;
      }
      throw error;
    }
  }
}
