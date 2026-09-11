import "server-only";

import { format, startOfMonth, subMonths } from "date-fns";
import type { EarningStatus } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  getConsultantEarningsSummary,
  getConsultantEarnings,
  checkPayoutEligibility,
} from "@/lib/payments/payouts";

export interface MonthlyEarning {
  /** Calendar month bucket, "YYYY-MM". */
  month: string;
  /** Sum of consultantSharePaise accrued in the month. */
  totalPaise: number;
  /** Number of earning records (≈ paid sessions) in the month. */
  count: number;
}

/**
 * Trailing per-month earnings buckets for the consultant analytics chart.
 * Aggregates ALL rows in the window (not the paginated history slice —
 * a `limit`-truncated reduce would undercount every month but the newest).
 * Empty months are zero-filled so the chart never has gaps.
 *
 * `organizationId` is an OPTIONAL view-scope filter (#org-appts #1024):
 * omitted (`undefined`) = no filter, identical to pre-#1024 behavior, for
 * any caller outside the earnings-view path. `null` scopes to personal
 * (B2C) earnings; a string scopes to that org's earnings.
 */
export async function getConsultantMonthlyEarnings(
  consultantProfileId: string,
  months = 6,
  organizationId?: string | null,
): Promise<MonthlyEarning[]> {
  // One clock read for the whole computation — repeated new Date() calls
  // could straddle a month rollover and misalign the buckets vs the query
  // window.
  const now = new Date();
  const since = startOfMonth(subMonths(now, months - 1));
  const rows = await prisma.consultantEarnings.findMany({
    where: {
      consultantProfileId,
      createdAt: { gte: since },
      ...(organizationId !== undefined ? { payment: { organizationId } } : {}),
    },
    select: { createdAt: true, consultantSharePaise: true },
  });

  const buckets = new Map<string, { totalPaise: number; count: number }>();
  for (let i = months - 1; i >= 0; i--) {
    buckets.set(format(subMonths(now, i), "yyyy-MM"), {
      totalPaise: 0,
      count: 0,
    });
  }
  for (const row of rows) {
    const bucket = buckets.get(format(row.createdAt, "yyyy-MM"));
    if (!bucket) continue;
    // consultantSharePaise is BigInt — convert before JSON serialization.
    // BigInt fallback keeps the ?? branch type-consistent (0n literal needs
    // ES2020 target, which this tsconfig doesn't set).
    bucket.totalPaise += Number(row.consultantSharePaise ?? BigInt(0));
    bucket.count += 1;
  }

  return Array.from(buckets, ([month, v]) => ({ month, ...v }));
}

export interface ConsultantEarningsPayloadOptions {
  status?: EarningStatus;
  limit?: number;
  offset?: number;
  includeMonthly?: boolean;
  /**
   * #org-appts (#1024) — VIEW scope. `null` (default, including when the
   * key is omitted entirely) = personal/B2C-only, matching the personal
   * dashboard's Earnings view. A string scopes to that org's earnings.
   * `undefined` means "no filter" (admin `?orgScope=all`) — passed
   * explicitly, since an omitted key defaults to personal instead.
   */
  organizationId?: string | null;
}

/**
 * Single assembler for the GET /api/consultant/earnings response body,
 * shared by the route handler and the analytics page's SSR prefetch so the
 * dehydrated cache and the client refetch can never drift apart.
 */
export async function buildConsultantEarningsPayload(
  consultantProfileId: string,
  options: ConsultantEarningsPayloadOptions = {},
) {
  const { status, limit = 20, offset = 0, includeMonthly = false } = options;
  // Explicit key check (not a destructuring default): an admin's
  // `?orgScope=all` resolves to organizationId === undefined (no filter),
  // which a destructuring default would silently collapse back to `null`
  // (personal). Omitting the key entirely still defaults to personal —
  // #org-appts (#1024): VIEW splits by org-ness; payout eligibility stays
  // whole (shared instrument), so it's never scoped below.
  const organizationId: string | null | undefined =
    "organizationId" in options ? options.organizationId : null;

  const [summary, eligibility, history, monthlyEarnings] = await Promise.all([
    getConsultantEarningsSummary(consultantProfileId, organizationId),
    // #org-appts (#1024) — VIEW splits by org-ness; payout eligibility
    // stays whole (shared instrument).
    checkPayoutEligibility(consultantProfileId),
    getConsultantEarnings(consultantProfileId, {
      status,
      limit,
      offset,
      organizationId,
    }),
    includeMonthly
      ? getConsultantMonthlyEarnings(consultantProfileId, 6, organizationId)
      : Promise.resolve(undefined),
  ]);

  return {
    summary,
    eligibility,
    earnings: history.earnings,
    pagination: {
      total: history.total,
      limit,
      offset,
      hasMore: history.hasMore,
    },
    ...(monthlyEarnings ? { monthlyEarnings } : {}),
  };
}
