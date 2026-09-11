"use client";

import { NotificationPreferencesPanel } from "@/components/notifications";

/**
 * Notifications tab of the consultant settings page. The panel manages its
 * own load/save cycle; this wrapper only exists so every settings tab is a
 * section module with the same shape.
 */
export function NotificationsSection() {
  return <NotificationPreferencesPanel />;
}
