/**
 * Segment-aware active-route check shared by the dashboard shells
 * (CollapsibleSidebar nav items + PersonalDashboardShell mobile tabs).
 *
 * `pathname.includes(...)` was used before, which marked a tab active for
 * any route that merely CONTAINED the target as a substring — e.g.
 * `path="sessions"` also matched `/sessions-archive`, and a short path
 * matched every deeper sibling. Exact-or-child matching respects path
 * segment boundaries.
 */
export function isActiveRoute(
  pathname: string,
  basePath: string,
  path: string,
): boolean {
  const target = path ? `${basePath}/${path}` : basePath;
  return pathname === target || pathname.startsWith(`${target}/`);
}
