import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { DocumentReviewStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { getSession } from "@/lib/auth-server";
import { applyRateLimit, documentReviewLimiter } from "@/lib/rate-limit";

/**
 * PATCH /api/documents/bulk-review — #347 bulk document review.
 *
 * Reviews many documents in ONE transactional updateMany, replacing the client's
 * N-PATCH fan-out (one HTTP request + DB write per document). The consultant is
 * derived from the session and the update is scoped to documents whose
 * appointment plan belongs to them, so it is inherently IDOR-safe regardless of
 * which ids are passed.
 */

const MAX_BULK = 100;
const MAX_NOTES = 2000;

const BulkReviewSchema = z.object({
  documentIds: z.array(z.string().min(1)).min(1).max(MAX_BULK),
  reviewStatus: z.nativeEnum(DocumentReviewStatus),
  // Shared note for the whole batch; trimmed, optional.
  reviewNotes: z.string().trim().max(MAX_NOTES).nullish(),
});

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required", code: "UNAUTHORIZED" },
        { status: 401 },
      );
    }

    const limited = await applyRateLimit(
      documentReviewLimiter,
      session.user.id,
    );
    if (limited) return limited;

    // A malformed body throws here, before Zod — that's a bad client payload
    // (400), not a server failure (which the outer catch would mislabel 500).
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body", code: "INVALID_INPUT" },
        { status: 400 },
      );
    }

    const parsed = BulkReviewSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid input",
          details: parsed.error.issues,
          code: "INVALID_INPUT",
        },
        { status: 400 },
      );
    }
    const { documentIds, reviewStatus, reviewNotes } = parsed.data;

    // Scope the write to documents the requesting consultant owns (the
    // consultant side of the document's consultation/subscription). Documents
    // belonging to anyone else are silently excluded rather than updated.
    const ownedByConsultant: Prisma.AppointmentWhereInput = {
      OR: [
        {
          consultation: {
            consultationPlan: {
              consultantProfile: { user: { id: session.user.id } },
            },
          },
        },
        {
          subscription: {
            subscriptionPlan: {
              consultantProfile: { user: { id: session.user.id } },
            },
          },
        },
      ],
    };

    // Same transition contract as the single-document PATCH: terminal states
    // (APPROVED/REJECTED) and soft-deleted rows are skipped, not overwritten.
    const result = await prisma.appointmentDocument.updateMany({
      where: {
        id: { in: documentIds },
        deletedAt: null,
        reviewStatus: {
          in: [
            DocumentReviewStatus.PENDING,
            DocumentReviewStatus.IN_REVIEW,
            DocumentReviewStatus.NEEDS_REVISION,
          ],
        },
        appointment: ownedByConsultant,
      },
      data: {
        reviewStatus,
        // Apply the shared note only when one was provided; an empty note leaves
        // existing per-document notes untouched (mirrors the per-document PATCH).
        ...(reviewNotes ? { reviewNotes } : {}),
        reviewedAt: new Date(),
        reviewedById: session.user.id,
      },
    });

    return NextResponse.json({
      data: { updated: result.count, requested: documentIds.length },
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "documents" } });
    console.error("Error in bulk document review:", error);
    return NextResponse.json(
      { error: "Failed to review documents", code: "SERVER_ERROR" },
      { status: 500 },
    );
  }
}
