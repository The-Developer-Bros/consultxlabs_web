/**
 * Shared read for the staff dashboard home stats. #890
 *
 * Extracted from GET /api/staff/stats so the route and the staff home server
 * page's SSR prefetch read through one code path — the SSR cache and the CSR
 * fetch can't drift. Auth stays at the call site: the route runs
 * requirePrivilegedAuth(); the prefetch runs under the dashboard layout's gate.
 *
 * The aggregation itself lives in lib/api/operators/stats.ts
 * (getStaffDashboardStats) and is shared with the admin dashboard. That helper
 * returns recentTickets[].createdAt as a raw Date; this wrapper maps it to an
 * ISO string so the payload is fully JSON-safe (no Date, no bigint) and the
 * SSR-dehydrated cache matches the client fetch verbatim — the route's
 * NextResponse.json already serialized that Date to a string on the wire.
 */

import {
  getStaffDashboardStats,
  type StaffDashboardStats,
} from "@/lib/api/operators";
import { toPlain } from "@/lib/data/serialize";

type RecentTicket = Omit<
  StaffDashboardStats["recentTickets"][number],
  "createdAt"
> & { createdAt: string };

export type StaffStatsPayload = Omit<StaffDashboardStats, "recentTickets"> & {
  recentTickets: RecentTicket[];
};

/**
 * Fetch the staff dashboard home stats as a JSON-safe payload.
 *
 * Single source of truth for both the route and the prefetch — the returned
 * object is the exact shape the client useQuery(["staff-stats"]) caches.
 */
export async function getStaffStats(): Promise<StaffStatsPayload> {
  const stats = await getStaffDashboardStats();
  // toPlain — the spread `...stats`/`...ticket` rows may carry Prisma's
  // inspect symbol from money result extensions (#780/#781), so the payload
  // must be plainified before crossing the RSC→Client HydrationBoundary.
  return toPlain({
    ...stats,
    recentTickets: stats.recentTickets.map((ticket) => ({
      ...ticket,
      createdAt: ticket.createdAt.toISOString(),
    })),
  });
}
