import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { updateSubscriberPreferences } from "@/lib/novu/subscriber";
import { NotificationPreferenceUpdateSchema } from "@/schemas/user";

import { getSession } from "@/lib/auth-server";
/**
 * GET /api/novu/preferences
 * Returns the current user's notification preferences.
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const preferences = await prisma.notificationPreference.findUnique({
      where: { userId: session.user.id },
    });

    // Return defaults if no preferences exist yet
    if (!preferences) {
      return NextResponse.json({
        allNotifications: true,
        inAppEnabled: true,
        emailEnabled: true,
        pushEnabled: false,
        mentions: false,
        directMessages: false,
        updates: false,
        appointmentReminders: true,
        paymentNotifications: true,
        supportUpdates: true,
        feedbackAlerts: true,
        trialNotifications: true,
        subscriptionAlerts: true,
        marketingEmails: false,
        orgBillingAlerts: true,
        orgMembershipAlerts: true,
        orgProgramAlerts: true,
        quietHoursEnabled: false,
        quietHoursStart: null,
        quietHoursEnd: null,
        quietHoursTimezone: null,
      });
    }

    return NextResponse.json(preferences);
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "notifications" } });
    console.error("Failed to fetch notification preferences:", error);
    return NextResponse.json(
      { error: "Failed to fetch preferences" },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/novu/preferences
 * Updates the current user's notification preferences.
 */
export async function PUT(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const result = NotificationPreferenceUpdateSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { error: "Validation failed", details: result.error.issues },
        { status: 400 },
      );
    }

    const validatedData = result.data;

    const updated = await prisma.notificationPreference.upsert({
      where: { userId: session.user.id },
      update: validatedData,
      create: {
        userId: session.user.id,
        ...validatedData,
      },
    });

    // Sync channel + category preferences to Novu subscriber data
    await updateSubscriberPreferences(session.user.id, {
      // Channel preferences
      inApp: updated.inAppEnabled,
      email: updated.emailEnabled,
      push: updated.pushEnabled,
      // Category preferences
      appointmentReminders: updated.appointmentReminders,
      paymentNotifications: updated.paymentNotifications,
      supportUpdates: updated.supportUpdates,
      feedbackAlerts: updated.feedbackAlerts,
      trialNotifications: updated.trialNotifications,
      subscriptionAlerts: updated.subscriptionAlerts,
      marketingEmails: updated.marketingEmails,
      // ADR 23 — org categories
      orgBillingAlerts: updated.orgBillingAlerts,
      orgMembershipAlerts: updated.orgMembershipAlerts,
      orgProgramAlerts: updated.orgProgramAlerts,
    });

    return NextResponse.json(updated);
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "notifications" } });
    console.error("Failed to update notification preferences:", error);
    return NextResponse.json(
      { error: "Failed to update preferences" },
      { status: 500 },
    );
  }
}
