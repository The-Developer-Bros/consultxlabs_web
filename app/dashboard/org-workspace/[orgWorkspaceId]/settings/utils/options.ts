/**
 * Constant option lists for the settings form.
 *
 * Kept here so the dialog/section components stay declarative and the
 * label copy lives in one place. Locale and currency lists are
 * intentionally short — the form accepts free text for "other" so an
 * operator with an unusual locale isn't blocked by a fixed picklist.
 */

import type { NotificationRoutingMode } from "./types";

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

export const NOTIFICATION_ROUTING_OPTIONS: ReadonlyArray<{
  value: NotificationRoutingMode;
  label: string;
  description: string;
}> = [
  {
    value: "BELL_AND_EMAIL",
    label: "Bell + email digest",
    description:
      "See lifecycle events on the in-app bell AND get the daily email digest.",
  },
  {
    value: "BELL_ONLY",
    label: "Bell only",
    description: "In-app only. No emails for org lifecycle events.",
  },
  {
    value: "EMAIL_ONLY",
    label: "Email only",
    description: "Daily digest only. The bell stream stays empty.",
  },
  {
    value: "NEITHER",
    label: "Neither",
    description:
      "You won’t be paged on lifecycle events. Use sparingly — you may miss invoice or payout updates.",
  },
];

// Short presets — operators usually pick from these. The form also
// accepts free text via the override input.
export const LOCALE_PRESETS: ReadonlyArray<SelectOption> = [
  { value: "en-IN", label: "English (India)" },
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "hi-IN", label: "Hindi (India)" },
];

export const CURRENCY_PRESETS: ReadonlyArray<SelectOption> = [
  { value: "INR", label: "INR — Indian Rupee" },
  { value: "USD", label: "USD — US Dollar" },
  { value: "EUR", label: "EUR — Euro" },
  { value: "GBP", label: "GBP — British Pound" },
];
