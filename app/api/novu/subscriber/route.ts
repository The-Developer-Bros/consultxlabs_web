import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { syncSubscriber } from "@/lib/novu/subscriber";

import { getSession } from "@/lib/auth-server";
/**
 * POST /api/novu/subscriber
 * Syncs the current authenticated user to Novu as a subscriber.
 * Called by useNovuSubscriberSync hook on dashboard mount.
 */
export async function POST() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        image: true,
        timezone: true,
        // ADR 23 — routing preference for operators who own a workspace.
        orgWorkspaceProfile: { select: { notificationRoutingMode: true } },
      },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const nameParts = (user.name || "User").split(" ");
    await syncSubscriber({
      userId: user.id,
      email: user.email,
      firstName: nameParts[0],
      lastName: nameParts.slice(1).join(" ") || undefined,
      phone: user.phone || undefined,
      avatar: user.image || undefined,
      locale: "en",
      routingMode:
        user.orgWorkspaceProfile?.notificationRoutingMode ?? undefined,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "notifications" } });
    console.error("Failed to sync Novu subscriber:", error);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}
