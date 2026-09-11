import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import {
  createWebinarChannel,
  createClassChannel,
  createConsultationChannel,
  createSubscriptionChannel,
  createChannel,
} from "@/actions/stream/chat/channel.action";
import { getSession } from "@/lib/auth-server";
import { streamLogger } from "@/lib/stream-logger";

export async function POST(req: NextRequest) {
  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const body = await req.json();
    const {
      channelType,
      eventId,
      eventType,
      channelName,
      members,
      createdById,
    } = body;

    // Validate required fields
    if (!channelType || !createdById) {
      return NextResponse.json(
        { success: false, error: "channelType and createdById are required" },
        { status: 400 },
      );
    }

    const isPrivileged =
      session.user.role === "ADMIN" || session.user.role === "STAFF";
    if (!isPrivileged && createdById !== session.user.id) {
      return NextResponse.json(
        { success: false, error: "Forbidden" },
        { status: 403 },
      );
    }

    let result;

    if (eventType && eventId) {
      // Event-linked channel creation - use our improved functions with full participant lists
      streamLogger.info("Creating event channel", {
        eventType,
        eventId,
        createdById,
      });

      try {
        switch (eventType) {
          case "webinar":
            result = await createWebinarChannel(eventId);
            break;
          case "class":
            result = await createClassChannel(eventId);
            break;
          case "consultation":
            result = await createConsultationChannel(eventId);
            break;
          case "subscription":
            result = await createSubscriptionChannel(eventId);
            break;
          default:
            return NextResponse.json(
              { success: false, error: `Unknown event type: ${eventType}` },
              { status: 400 },
            );
        }

        streamLogger.info("Event channel created", { eventType, eventId });
      } catch (eventError) {
        streamLogger.error("Event channel creation failed", eventError, {
          eventType,
          eventId,
        });
        throw eventError; // Re-throw to be caught by outer catch block
      }
    } else {
      // Custom channel creation - restricted to admin/staff to prevent
      // arbitrary member inclusion by unprivileged users
      if (!isPrivileged) {
        return NextResponse.json(
          {
            success: false,
            error: "Custom channel creation requires admin privileges",
          },
          { status: 403 },
        );
      }

      if (!channelName) {
        return NextResponse.json(
          {
            success: false,
            error: "channelName is required for custom channels",
          },
          { status: 400 },
        );
      }

      const channelId = crypto.randomUUID();
      streamLogger.info("Creating custom channel", {
        channelId,
        channelType,
        channelName,
      });

      // #B2 Stream.io org tagging — generic admin-created custom channels
    // are not bound to an org event; pass `null` explicitly so the new
    // param is unambiguous (vs. forgotten).
    result = await createChannel({
        channelType: channelType as "messaging" | "team",
        channelId,
        channelName,
        members: members || [createdById],
        createdById,
        additionalData: { custom: true },
        organizationId: null,
      });
    }

    return NextResponse.json({
      success: true,
      data: result,
      message: eventType
        ? `${eventType.charAt(0).toUpperCase() + eventType.slice(1)} channel created successfully`
        : "Custom channel created successfully",
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "stream" } });
    streamLogger.error("Channel creation API error", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to create channel",
      },
      { status: 500 },
    );
  }
}
