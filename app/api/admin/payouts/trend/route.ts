/**
 * GET /api/admin/payouts/trend
 *
 * #997 secondary findings — the "Payouts - Last 7 Days" chart used to fetch
 * `/api/admin/payouts?limit=100` and bucket the raw rows into days in the
 * browser (a TODO in the client flagged `limit=100` as not 7-day-safe at
 * scale). This endpoint bounds the query to the actual 7-day window and does
 * the bucketing server-side.
 *
 * Prisma's `groupBy` can't truncate a timestamp to a calendar day (no
 * expression support without raw SQL, which this repo avoids), so we select
 * only `{createdAt, amount}` inside the window — far narrower than the old
 * ≤100-row/all-columns fetch — and bucket in JS.
 */
import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";

const TREND_DAYS = 7;

function dayKey(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dayLabel(d: Date): string {
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export async function GET() {
  try {
    const auth = await requireBackofficeSurface("payouts.read");
    if (auth.error) return auth.error;

    const now = new Date();
    const todayUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const since = new Date(todayUtc);
    since.setUTCDate(since.getUTCDate() - (TREND_DAYS - 1));

    const rows = await prisma.consultantPayout.findMany({
      where: { createdAt: { gte: since } },
      select: { createdAt: true, amount: true },
    });

    const buckets = new Map<string, { label: string; totalPaise: number }>();
    for (let i = 0; i < TREND_DAYS; i++) {
      const d = new Date(since);
      d.setUTCDate(d.getUTCDate() + i);
      buckets.set(dayKey(d), { label: dayLabel(d), totalPaise: 0 });
    }

    for (const row of rows) {
      const bucket = buckets.get(dayKey(row.createdAt));
      if (bucket) bucket.totalPaise += row.amount;
    }

    const series = Array.from(buckets.entries()).map(([day, v]) => ({
      day,
      label: v.label,
      totalPaise: v.totalPaise,
    }));

    return NextResponse.json({ series });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "admin" } },
    );
    console.error("Error fetching payout trend:", error);
    return NextResponse.json(
      { error: "Failed to fetch payout trend" },
      { status: 500 },
    );
  }
}
