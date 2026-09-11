import * as Sentry from "@sentry/nextjs";

/**
 * Onboarding funnel instrumentation.
 *
 * Deliberately breadcrumb-based: the funnel events land on every Sentry error
 * and are queryable in Performance traces without adding a third-party
 * analytics dependency or a network call per step. When a real product
 * analytics provider lands, this is the single file to swap.
 *
 * Never log field values — only step labels and outcome codes.
 */
export function trackOnboardingEvent(
  event:
    | "wizard_start"
    | "draft_restored"
    | "step_advance"
    | "step_back"
    | "draft_save_failed"
    | "draft_save_skipped"
    | "draft_load_failed"
    | "draft_quarantined"
    | "submit_success"
    | "submit_error"
    | "verification_deferred",
  data?: Record<string, string | number | boolean | null>,
): void {
  try {
    Sentry.addBreadcrumb({
      category: "onboarding",
      message: event,
      level: "info",
      data,
    });
  } catch {
    // Telemetry must never break the wizard; swallow transport failures.
  }
}
