import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma, RefundStatus, PaymentGateway } from "@prisma/client";
import {
  requirePrivilegedAuth,
  requireBackofficeSurface,
} from "@/lib/auth-helpers";
import {
  RefundValidationError,
  RefundGatewayError,
} from "@/lib/payments/operations/refund";
import { refundBookingPayment } from "@/lib/payments/operations/booking-refund";
import { refundWholeEventPayments } from "@/lib/payments/operations/event-refunds";
import { withIdempotency } from "@/lib/api/idempotency";
import { applyRateLimit, moneyOpsLimiter } from "@/lib/rate-limit";

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    // Parse query parameters
    const searchParams = req.nextUrl.searchParams;
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "20");
    const status = searchParams.get("status") as RefundStatus | null;
    const gateway = searchParams.get("gateway") as PaymentGateway | null;
    const search = searchParams.get("search");

    // Build where clause
    const where: Prisma.RefundWhereInput = {};

    if (status) {
      where.status = status;
    }

    if (gateway) {
      where.paymentGateway = gateway;
    }

    if (search) {
      where.refundId = {
        contains: search,
        mode: "insensitive",
      };
    }

    // Fetch refunds with pagination. pending/succeeded/failed counts are
    // dashboard-wide (unfiltered by search/gateway) — #997 secondary
    // findings: the stat cards used to `.filter()` the current page's
    // `refunds` array, so they silently showed ≤`limit` (20) instead of the
    // true platform-wide count.
    const [refunds, total, pendingCount, succeededCount, failedCount] =
      await Promise.all([
        prisma.refund.findMany({
          where,
          skip: (page - 1) * limit,
          take: limit,
          orderBy: { createdAt: "desc" },
          include: {
            payment: {
              select: {
                id: true,
                paymentIntent: true,
              },
            },
          },
        }),
        prisma.refund.count({ where }),
        prisma.refund.count({ where: { status: "PENDING" } }),
        prisma.refund.count({ where: { status: "SUCCEEDED" } }),
        prisma.refund.count({ where: { status: "FAILED" } }),
      ]);

    return NextResponse.json({
      refunds,
      total,
      stats: { pendingCount, succeededCount, failedCount },
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "admin" } },
    );
    console.error("Admin refunds list error:", error);
    return NextResponse.json(
      { error: "Failed to fetch refunds" },
      { status: 500 },
    );
  }
}

// Admin-initiated refund (#776 §C). Exactly one target: a single payment, or a
// whole class/webinar (every attendee). Both go through the refund front doors
// (#1319): a single payment via refundBookingPayment, which splits gateway,
// org-funded (in-ledger) and credit rails — a raw refundPayment on an org_
// intent died on UNKNOWN_GATEWAY; events fan out through the reversal engine.
const RefundBodySchema = z
  .object({
    paymentId: z.string().min(1).optional(),
    classId: z.string().min(1).optional(),
    webinarId: z.string().min(1).optional(),
    amountPaise: z.number().int().positive().optional(),
    reason: z.string().min(1).max(500),
  })
  .refine(
    (b) => [b.paymentId, b.classId, b.webinarId].filter(Boolean).length === 1,
    { message: "Provide exactly one of paymentId, classId, webinarId" },
  )
  .refine((b) => !(b.amountPaise && (b.classId || b.webinarId)), {
    message: "amountPaise applies only to a single paymentId refund",
  });

export async function POST(req: NextRequest) {
  try {
    // Executing a refund moves real money and is ADMIN-only per
    // BACKOFFICE_PERMISSIONS. This was `requirePrivilegedAuth`, which admits
    // STAFF — the dashboard only ever hid the button, so a staff member could
    // still issue a refund by calling this route directly. GET stays
    // privileged: staff read every money surface for ticket context.
    const auth = await requireBackofficeSurface("refunds.manage");
    if (auth.error) return auth.error;

    // #677/PM-36 — throttle the most dangerous button in the app. Keyed per
    // admin user; 10/min is far above legitimate ops cadence.
    const limited = await applyRateLimit(moneyOpsLimiter, auth.session.user.id);
    if (limited) return limited;

    const initiatedByUserId = auth.session?.user?.id ?? null;

    // A double-clicked "Refund" button used to issue two real refunds. The
    // gateway's X-Refund-Idempotency header does not help here: it is keyed off
    // the Refund row we create first, so a second request simply mints a second
    // row with a second key and the gateway honours both. Dedupe one layer up.
    // Callers without the header behave exactly as before.
    //
    // The `await` is load-bearing, not style: `return somePromise` inside a
    // `try` returns before the promise settles, so its rejection is adopted by
    // this function's own promise and NEVER reaches the catch below. Without
    // it, every typed refund failure — REFUND_BLOCKED_BY_DISPUTE,
    // ALREADY_FULLY_REFUNDED, AMOUNT_EXCEEDS_REFUNDABLE — escaped to Next's
    // framework boundary, which answers a production route handler with a bare
    // 500 and an empty body. The operator lost the reason and Sentry lost the
    // event.
    return await withIdempotency(
      req,
      { scope: "admin.refund", userId: initiatedByUserId ?? "anonymous" },
      async (payload) => {
        const parsed = RefundBodySchema.safeParse(payload);
        if (!parsed.success) {
          return NextResponse.json(
            { error: parsed.error.issues[0]?.message ?? "Invalid request" },
            { status: 400 },
          );
        }
        const body = parsed.data;

        if (body.paymentId) {
          const result = await refundBookingPayment({
            paymentId: body.paymentId,
            amountPaise: body.amountPaise,
            reason: `admin refund: ${body.reason}`,
            initiatedByUserId,
          });
          return NextResponse.json({ kind: "payment", result });
        }

        const eventKind = body.classId ? "class" : "webinar";
        const eventId = (body.classId ?? body.webinarId)!;
        const summary = await refundWholeEventPayments(
          eventKind,
          eventId,
          `admin whole-event refund: ${body.reason}`,
          initiatedByUserId,
        );
        return NextResponse.json({ kind: eventKind, summary });
      },
    );
  } catch (error) {
    // Validation / gateway errors carry a caller-actionable message + code.
    if (
      error instanceof RefundValidationError ||
      error instanceof RefundGatewayError
    ) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error instanceof RefundValidationError ? 400 : 502 },
      );
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "admin" } },
    );
    console.error("Admin refund error:", error);
    return NextResponse.json({ error: "Refund failed" }, { status: 500 });
  }
}
