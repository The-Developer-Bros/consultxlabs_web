import { getAppUrl } from "@/lib/url";

/**
 * Where a notification should land.
 *
 * ADR 19 puts org-hosted work in the organization dashboard and B2C work in the
 * personal ones. Notification deep-links did not follow: booking requests
 * hardcoded `/dashboard/consultant/<id>/requests` even for org-hosted plans, and
 * everything else sent a bare `/dashboard`, which the router bounces to the
 * recipient's personal tree regardless of who owns the session. A member
 * clicking an org-session notification was dropped into their personal
 * dashboard, where the item is filtered out by design.
 *
 * There is a constraint that shapes all of this: several workflows trigger once
 * for MANY recipients with a single payload, so one href has to be right for
 * every one of them.
 *
 *   - Org-hosted work → the org route. Correct for every participant, because
 *     the LEARNER who attended and the EXPERT who delivered both reach the same
 *     `/dashboard/organization/<id>/…` page.
 *   - B2C work → a bare `/dashboard`. Deliberately NOT a guessed personal
 *     route: the consultant and the consultee have different dashboards, and
 *     the capability router already resolves the right one per viewer. The old
 *     bare `/dashboard` was only wrong because it was used for org work too.
 *
 * Use {@link personalHref} instead when a trigger has exactly one recipient and
 * their side is known — a precise link beats a router bounce.
 */

type Surface =
  | "appointments"
  | "requests"
  | "recordings"
  | "earnings"
  | "documents";

/**
 * Multi-recipient safe. `organizationId` null means B2C.
 */
export function notificationHref(
  organizationId: string | null | undefined,
  surface: Surface,
): string {
  const base = getAppUrl();
  if (!organizationId) {
    // The router picks the viewer's own dashboard. One payload, N recipients,
    // possibly on different sides — nothing more specific is correct here.
    return `${base}/dashboard`;
  }
  return `${base}/dashboard/organization/${organizationId}/${surface}`;
}

/**
 * Single-recipient variant: when the trigger targets exactly one person and we
 * know which personal dashboard is theirs, link straight to it.
 */
export function personalHref(
  kind: "consultant" | "consultee",
  profileId: string,
  surface: Surface,
): string {
  return `${getAppUrl()}/dashboard/${kind}/${profileId}/${surface}`;
}

/**
 * Convenience for the common case: one recipient whose side is known, but the
 * work may be org-hosted. Falls back to the org route when it is.
 */
export function scopedHref(args: {
  organizationId: string | null | undefined;
  surface: Surface;
  personal?: { kind: "consultant" | "consultee"; profileId: string };
}): string {
  if (args.organizationId) {
    return notificationHref(args.organizationId, args.surface);
  }
  if (args.personal) {
    return personalHref(args.personal.kind, args.personal.profileId, args.surface);
  }
  return notificationHref(null, args.surface);
}
