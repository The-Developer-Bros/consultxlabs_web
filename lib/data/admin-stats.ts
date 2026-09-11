/**
 * Shared read for the admin dashboard home stats. #890
 *
 * Single entry point behind GET /api/admin/stats AND the admin home server
 * page's SSR prefetch so the SSR-hydrated cache and the client useQuery
 * (queryKey ["admin-stats"]) resolve byte-identical payloads — both paths
 * funnel through here, so they can't drift.
 *
 * The aggregation itself stays in getOperatorDashboardStats (shared with the
 * staff dashboard); this layer is a thin JSON-safety normalizer. The ONLY
 * transform is Date→ISO string on the recentPayments/recentRefunds
 * `createdAt` fields, which is exactly what the route's NextResponse.json did
 * before — so the wire payload is unchanged, it's just now also safe to
 * dehydrate into the React Query cache verbatim.
 *
 * Money fields already cross as number via the prisma result extension
 * (#780: payment.amount / refund.amountPaise pass through f(...)), so no
 * bigint leaks. The payload shape is preserved as-is, including
 * recentRefunds[].amountPaise (the client's RecentRefund type names this
 * `amount` — pre-existing mismatch, intentionally NOT changed here to keep
 * this a pure hydration refactor; see report).
 */

import { getOperatorDashboardStats } from "@/lib/api/operators";
import { toPlain } from "@/lib/data/serialize";

/**
 * Admin stats with `createdAt` Date fields normalized to ISO strings — the
 * exact payload GET /api/admin/stats has always returned over the wire.
 */
export type AdminStatsPayload = Omit<
  Awaited<ReturnType<typeof getOperatorDashboardStats>>,
  "recentPayments" | "recentRefunds"
> & {
  recentPayments: Array<
    Omit<
      Awaited<
        ReturnType<typeof getOperatorDashboardStats>
      >["recentPayments"][number],
      "createdAt"
    > & { createdAt: string }
  >;
  recentRefunds: Array<
    Omit<
      Awaited<
        ReturnType<typeof getOperatorDashboardStats>
      >["recentRefunds"][number],
      "createdAt"
    > & { createdAt: string }
  >;
};

export async function getAdminStats(): Promise<AdminStatsPayload> {
  const stats = await getOperatorDashboardStats();

  // toPlain — recentPayments spreads money-extended payment rows (#780/#781
  // result extension) that carry Prisma's inspect symbol, so the payload must
  // be plainified before crossing the RSC→Client HydrationBoundary.
  return toPlain({
    ...stats,
    recentPayments: stats.recentPayments.map((p) => ({
      ...p,
      createdAt: p.createdAt.toISOString(),
    })),
    recentRefunds: stats.recentRefunds.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
    })),
  });
}
