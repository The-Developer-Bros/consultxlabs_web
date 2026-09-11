/**
 * Novu Subscriber Management
 * Syncs user data to Novu as subscribers using User.id as subscriberId.
 */
import * as Sentry from "@sentry/nextjs";
import { getNovuClient, isNovuConfigured } from "./client";

interface SubscriberData {
  userId: string;
  email: string;
  firstName: string;
  lastName?: string;
  phone?: string;
  avatar?: string;
  locale?: string;
  /**
   * ADR 23 — `OrgWorkspaceProfile.notificationRoutingMode` for operators who
   * own a workspace. Written onto subscriber data so the Novu workflow
   * conditions can honour it, which is the same mechanism the category flags
   * below use. Before this it was written by the UI, displayed back, and read
   * by nothing: an operator who chose EMAIL_ONLY still got bell notifications
   * and was told the setting had saved.
   */
  routingMode?: "BELL_AND_EMAIL" | "BELL_ONLY" | "EMAIL_ONLY" | "NEITHER";
}

/**
 * Sync a user to Novu as a subscriber.
 * The Novu `create` method automatically updates if the subscriber already exists.
 * Called on: registration, login (via API route), profile update.
 */
export async function syncSubscriber(data: SubscriberData): Promise<void> {
  if (!isNovuConfigured()) {
    console.warn("[Novu] Not configured, skipping subscriber sync");
    return;
  }

  try {
    const novu = getNovuClient();
    // create() will update an existing subscriber if the subscriberId matches
    await novu.subscribers.create({
      subscriberId: data.userId,
      firstName: data.firstName,
      lastName: data.lastName || "",
      email: data.email,
      phone: data.phone || undefined,
      avatar: data.avatar || undefined,
      locale: data.locale || "en",
      data: {
        routingMode: data.routingMode ?? "BELL_AND_EMAIL",
        routingBell:
          data.routingMode === "BELL_AND_EMAIL" ||
          data.routingMode === "BELL_ONLY" ||
          data.routingMode === undefined,
        routingEmail:
          data.routingMode === "BELL_AND_EMAIL" ||
          data.routingMode === "EMAIL_ONLY" ||
          data.routingMode === undefined,
      },
    });
    console.log(`[Novu] Subscriber synced: ${data.userId}`);
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "novu" } });
    console.error("[Novu] Failed to sync subscriber:", error);
  }
}

/**
 * Update subscriber notification channel and category preferences in Novu.
 * Channel prefs control which channels deliver notifications (email, in-app, push).
 * Category prefs control which types of notifications are sent at all.
 *
 * Category prefs are stored as subscriber custom data so Novu Dashboard
 * workflows can use them in conditional steps (e.g., skip email step if
 * subscriber.data.categoryAppointments === false).
 */
export async function updateSubscriberPreferences(
  userId: string,
  preferences: {
    // Channel preferences
    inApp?: boolean;
    email?: boolean;
    push?: boolean;
    // Category preferences (from NotificationPreference model)
    appointmentReminders?: boolean;
    paymentNotifications?: boolean;
    supportUpdates?: boolean;
    feedbackAlerts?: boolean;
    trialNotifications?: boolean;
    subscriptionAlerts?: boolean;
    marketingEmails?: boolean;
    // Org category preferences (ADR 23)
    orgBillingAlerts?: boolean;
    orgMembershipAlerts?: boolean;
    orgProgramAlerts?: boolean;
  },
): Promise<void> {
  if (!isNovuConfigured()) return;

  try {
    const novu = getNovuClient();
    await novu.subscribers.patch(
      {
        data: {
          // Channel preferences
          preferInApp: preferences.inApp ?? true,
          preferEmail: preferences.email ?? true,
          preferPush: preferences.push ?? false,
          // Category preferences — used in Novu Dashboard workflow conditions
          categoryAppointments: preferences.appointmentReminders ?? true,
          categoryPayments: preferences.paymentNotifications ?? true,
          categorySupport: preferences.supportUpdates ?? true,
          categoryFeedback: preferences.feedbackAlerts ?? true,
          categoryTrials: preferences.trialNotifications ?? true,
          categorySubscriptions: preferences.subscriptionAlerts ?? true,
          categoryMarketing: preferences.marketingEmails ?? false,
          // ADR 23 — the ORG_* workflow family was unmutable before these.
          categoryOrgBilling: preferences.orgBillingAlerts ?? true,
          categoryOrgMembership: preferences.orgMembershipAlerts ?? true,
          categoryOrgProgram: preferences.orgProgramAlerts ?? true,
        },
      },
      userId,
    );
    console.log(`[Novu] Preferences updated for subscriber: ${userId}`);
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "novu" } });
    console.error("[Novu] Failed to update subscriber preferences:", error);
  }
}

/**
 * Delete a subscriber from Novu (e.g. on account deletion).
 */
export async function deleteSubscriber(userId: string): Promise<void> {
  if (!isNovuConfigured()) return;

  try {
    const novu = getNovuClient();
    await novu.subscribers.delete(userId);
    console.log(`[Novu] Subscriber deleted: ${userId}`);
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "novu" } });
    console.error("[Novu] Failed to delete subscriber:", error);
  }
}
