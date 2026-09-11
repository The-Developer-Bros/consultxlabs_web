/**
 * Stream Debug API Route
 *
 * Provides diagnostic information about Stream Chat state for a user.
 * SECURED: Requires authentication and only available in development mode by default.
 *
 * Usage: GET /api/stream/debug?userId=USER_ID&secret=YOUR_SECRET
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { getStreamChatClient, isStreamConfigured } from "@/lib/stream-client";
import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
import { streamLogger } from "@/lib/stream-logger";
import prisma from "@/lib/prisma";

// Only allow in development or with explicit production flag
const ALLOW_IN_PRODUCTION = process.env.ALLOW_DEBUG_IN_PRODUCTION === "true";
const DEBUG_SECRET = process.env.STREAM_DEBUG_SECRET;

export async function GET(req: NextRequest) {
  // Security checks
  const isDev = process.env.NODE_ENV === "development";

  // #1134 P1-12 — this route had NO session check at all. Its only production
  // gate was a shared secret in the query string — which lands in access logs,
  // browser history and any Referer header — and it dumps an arbitrary user's
  // full Stream channel list. A session is now required everywhere, and staff
  // or admin on top of that, so the secret is defence in depth rather than the
  // whole defence.
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isPrivileged(session.user.role)) {
    streamLogger.warn("Non-privileged Stream debug attempt", {
      userId: session.user.id,
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!isDev && !ALLOW_IN_PRODUCTION) {
    return NextResponse.json(
      { error: "Debug endpoint not available in production" },
      { status: 403 },
    );
  }

  // Require secret in production
  if (!isDev) {
    const url = new URL(req.url);
    const secret = url.searchParams.get("secret");

    // A missing STREAM_DEBUG_SECRET must fail closed. `secret !== undefined`
    // would have compared two undefineds and passed.
    if (!DEBUG_SECRET || !secret || secret !== DEBUG_SECRET) {
      streamLogger.warn("Unauthorized debug attempt", {
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    if (!isStreamConfigured()) {
      return NextResponse.json(
        { error: "Stream API keys not configured" },
        { status: 500 },
      );
    }

    const url = new URL(req.url);
    const userId = url.searchParams.get("userId");

    if (!userId) {
      return NextResponse.json(
        { error: "userId query parameter is required" },
        { status: 400 },
      );
    }

    // Get user details from database
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: isDev, // Only include email in dev
        role: true,
        consultantProfileId: true,
        consulteeProfileId: true,
      },
    });

    if (!user) {
      return NextResponse.json(
        { error: "User not found in database" },
        { status: 404 },
      );
    }

    const serverClient = getStreamChatClient();

    // Get channels for the user
    const channels = await serverClient.queryChannels(
      { members: { $in: [userId] } },
      { last_message_at: -1 },
      { limit: 30 },
    );

    // Get event counts (simplified queries for performance)
    const eventCounts = await Promise.all([
      user.consultantProfileId
        ? prisma.consultation.count({
            where: {
              consultationPlan: {
                consultantProfileId: user.consultantProfileId,
              },
              status: "APPROVED",
            },
          })
        : user.consulteeProfileId
          ? prisma.consultation.count({
              where: {
                requestedById: user.consulteeProfileId,
                status: "APPROVED",
              },
            })
          : 0,
      user.consultantProfileId
        ? prisma.subscription.count({
            where: {
              subscriptionPlan: {
                consultantProfileId: user.consultantProfileId,
              },
              status: "APPROVED",
            },
          })
        : user.consulteeProfileId
          ? prisma.subscription.count({
              where: {
                requestedById: user.consulteeProfileId,
                status: "APPROVED",
              },
            })
          : 0,
      user.consultantProfileId
        ? prisma.webinar.count({
            where: {
              webinarPlan: { consultantProfileId: user.consultantProfileId },
            },
          })
        : prisma.webinar.count({
            where: {
              appointment: {
                slotsOfAppointment: {
                  some: { user: { some: { id: userId } } },
                },
              },
            },
          }),
      user.consultantProfileId
        ? prisma.class.count({
            where: {
              classPlan: { consultantProfileId: user.consultantProfileId },
            },
          })
        : prisma.class.count({
            where: {
              appointments: {
                some: {
                  slotsOfAppointment: {
                    some: { user: { some: { id: userId } } },
                  },
                },
              },
            },
          }),
    ]);

    return NextResponse.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        isConsultant: !!user.consultantProfileId,
        isConsultee: !!user.consulteeProfileId,
      },
      stream: {
        channelCount: channels.length,
        channels: channels.map((channel) => ({
          id: channel.id,
          type: channel.type,
          name: channel.data?.name,
          memberCount: Object.keys(channel.state.members || {}).length,
          messageCount: channel.state.messages.length,
        })),
      },
      database: {
        consultations: eventCounts[0],
        subscriptions: eventCounts[1],
        webinars: eventCounts[2],
        classes: eventCounts[3],
      },
      // Include additional details only in development
      ...(isDev && {
        debug: {
          timestamp: new Date().toISOString(),
          nodeEnv: process.env.NODE_ENV,
        },
      }),
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Debug endpoint error", error);
    return NextResponse.json(
      {
        error: "Debug request failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
