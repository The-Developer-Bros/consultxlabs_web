/**
 * User-facing Content Report API
 * Allows users to report inappropriate content
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { ModerationReportType, type Prisma } from "@prisma/client";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";
import {
  assertBodySize,
  MAX_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
} from "@/lib/validation/limits";
import { z } from "zod";

import { getSession } from "@/lib/auth-server";
import { getStreamChatClient } from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";

// #831 — raw destructuring accepted unbounded strings; every user-typed
// field now carries a .max()
const CreateReportSchema = z.object({
  type: z.nativeEnum(ModerationReportType),
  reason: z.string().min(1).max(MAX_TITLE_LENGTH),
  description: z.string().max(MAX_TEXT_LENGTH).optional(),
  targetUserId: z.string().min(1).max(MAX_TITLE_LENGTH),
  contentText: z.string().max(MAX_TEXT_LENGTH).optional(),
  contentUrl: z.string().max(MAX_TITLE_LENGTH).optional(),
  reviewId: z.string().max(MAX_TITLE_LENGTH).optional(),
  // #1270 — the message identity a MESSAGE report is about. Without it
  // CONTENT_REMOVED has nothing to delete and dedup cannot tell two messages
  // from the same author apart.
  streamMessageId: z.string().max(MAX_TITLE_LENGTH).optional(),
  streamChannelCid: z.string().max(MAX_TITLE_LENGTH).optional(),
});

/**
 * #1270 — what "the same content" means for aggregation.
 *
 * A MESSAGE report always has a null `reviewId`, so the old `(targetUserId,
 * type, reviewId)` key folded every message ever reported against one user
 * into a single row: the second report only incremented a counter and its
 * excerpt was thrown away, leaving moderators looking at the first message
 * anyone ever complained about. Scoping on the message id fixes that.
 *
 * Reports that arrive without a message id — an older client, or a surface
 * that has no message to point at — deliberately keep the previous per-user
 * collapse (`streamMessageId IS NULL`) rather than splitting into one row per
 * reporter, which would flood the queue.
 */
function contentScopeFor(
  type: ModerationReportType,
  reviewId: string | undefined,
  streamMessageId: string | undefined,
): Prisma.ModerationReportWhereInput {
  if (type === ModerationReportType.MESSAGE) {
    return { streamMessageId: streamMessageId ?? null };
  }
  return reviewId ? { reviewId } : {};
}

/**
 * POST /api/report
 * Submit a content report
 */

/**
 * Resolve a reported Stream message with SERVER credentials, and only accept it
 * when its author really is the person being reported.
 *
 * #1270 review — the ids arrived from the browser. `CONTENT_REMOVED` later
 * forwards the stored `streamMessageId` to Stream's server-side delete, so a
 * caller who reported user X while supplying a message authored by someone else
 * could get an arbitrary message deleted, using a staff moderator as the
 * instrument. The channel cid was caller-supplied too, so the staff deep-link
 * pointed wherever the reporter chose.
 *
 * Both now come from Stream's own answer, or the report is stored with no
 * message identity at all — which degrades to the pre-#1270 behaviour (a report
 * a human reads) rather than refusing the report outright. A reporter should
 * not be blocked because Stream is briefly unavailable.
 */
async function resolveReportedMessage(
  streamMessageId: string | undefined,
  targetUserId: string,
): Promise<{ streamMessageId: string | null; streamChannelCid: string | null }> {
  const none = { streamMessageId: null, streamChannelCid: null };
  if (!streamMessageId) return none;

  try {
    const { message } = await getStreamChatClient().getMessage(streamMessageId);
    if (!message?.user?.id || message.user.id !== targetUserId) {
      streamLogger.warn("Report named a message the reported user did not send", {
        streamMessageId,
        targetUserId,
        actualAuthor: message?.user?.id ?? null,
      });
      return none;
    }
    return {
      streamMessageId: message.id,
      // Canonical, from Stream — never the caller's.
      streamChannelCid: message.cid ?? null,
    };
  } catch (error) {
    streamLogger.warn("Could not resolve a reported Stream message", {
      streamMessageId,
      error: String(error),
    });
    return none;
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Rate limit: 5 reports per hour per user
    const rl = await applyRateLimit(spamLimiter, `report:${session.user.id}`);
    if (rl) return rl;

    const tooLarge = assertBodySize(req);
    if (tooLarge) return tooLarge;

    const body = await req.json();
    const parsed = CreateReportSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.issues },
        { status: 400 },
      );
    }
    const {
      type,
      reason,
      description,
      targetUserId,
      contentText,
      contentUrl,
      reviewId,
      streamMessageId,
      // NB: `streamChannelCid` is accepted by the schema and deliberately NOT
      // read. The cid stored comes from Stream's own answer — see
      // resolveReportedMessage — because a caller-supplied one pointed the
      // staff deep-link wherever the reporter chose.
    } = parsed.data;

    // Validate required fields
    if (!type || !reason || !targetUserId) {
      return NextResponse.json(
        { error: "Type, reason, and targetUserId are required" },
        { status: 400 },
      );
    }

    // Validate type
    const validTypes: ModerationReportType[] = [
      "REVIEW",
      "PROFILE",
      "MESSAGE",
      "DOCUMENT",
      "OTHER",
    ];
    if (!validTypes.includes(type)) {
      return NextResponse.json(
        { error: "Invalid report type" },
        { status: 400 },
      );
    }

    // Prevent self-reporting
    if (targetUserId === session.user.id) {
      return NextResponse.json(
        { error: "You cannot report yourself" },
        { status: 400 },
      );
    }

    // Check if target user exists
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
    });

    if (!targetUser) {
      return NextResponse.json(
        { error: "Target user not found" },
        { status: 404 },
      );
    }

    const contentScope = contentScopeFor(type, reviewId, streamMessageId);

    // Check for existing report from same user for same content
    const existingReport = await prisma.moderationReport.findFirst({
      where: {
        reportedById: session.user.id,
        targetUserId,
        type,
        ...contentScope,
        status: { in: ["PENDING", "UNDER_REVIEW"] },
      },
    });

    if (existingReport) {
      return NextResponse.json(
        { error: "You have already reported this content" },
        { status: 400 },
      );
    }

    // Check if there's an existing report for same content from others
    // If so, increment reportCount instead of creating new
    const similarReport = await prisma.moderationReport.findFirst({
      where: {
        targetUserId,
        type,
        ...contentScope,
        status: { in: ["PENDING", "UNDER_REVIEW"] },
      },
    });

    if (similarReport) {
      // Increment report count on existing report
      const updatedReport = await prisma.moderationReport.update({
        where: { id: similarReport.id },
        data: {
          reportCount: { increment: 1 },
          // #1270 — the first reporter may have had no excerpt to send (a
          // profile report, an attachment-only message). Fill the gap rather
          // than leave the moderator deciding a ban with nothing to read; a
          // row that already has an excerpt keeps it, because within one
          // content scope every reporter is describing the same content.
          ...(similarReport.contentText === null && contentText
            ? { contentText }
            : {}),
        },
      });

      return NextResponse.json({
        message: "Report submitted successfully",
        reportId: updatedReport.id,
        aggregated: true,
      });
    }

    // Verified against Stream, not trusted from the caller — see
    // resolveReportedMessage.
    const verifiedMessage = await resolveReportedMessage(
      streamMessageId,
      targetUserId,
    );

    // Create new report
    const report = await prisma.moderationReport.create({
      data: {
        type,
        reason,
        description,
        reportedById: session.user.id,
        targetUserId,
        contentText,
        contentUrl,
        reviewId,
        ...verifiedMessage,
      },
    });

    return NextResponse.json(
      {
        message: "Report submitted successfully",
        reportId: report.id,
      },
      { status: 201 },
    );
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "report" } });
    console.error("Error submitting report:", error);
    return NextResponse.json(
      { error: "Failed to submit report" },
      { status: 500 },
    );
  }
}
