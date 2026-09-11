/**
 * Shared operator invoice listing.
 *
 * Used by `app/api/admin/invoices/route.ts`, which both back-office trees now
 * call. This util was extracted when there were two routes duplicating the
 * query/response shape line-for-line; the staff route has since been deleted
 * rather than kept in sync, since `requirePrivilegedAuth` already admits both
 * roles and nothing about the listing differed between them.
 *
 * "Invoices" are surfaced as Payment rows whose status is SUCCEEDED (or any
 * status the caller passes via `status`). The shared util takes the parsed
 * filter values from the route handler — auth, query parsing and error
 * shaping remain in the route file.
 */

import prisma from "@/lib/prisma";
import { PaymentStatus, Prisma } from "@prisma/client";

export type OperatorInvoiceFilters = {
  status?: PaymentStatus | null;
  search?: string | null;
  limit?: number;
  offset?: number;
  /**
   * #674 comment 7 — optional org-scope filter. When set, restricts the
   * invoice list to Payments tagged with `Payment.organizationId = orgId`.
   * Does not require additional auth (the route is already privileged
   * via `requirePrivilegedAuth`).
   */
  orgId?: string | null;
};

export type OperatorInvoice = {
  id: string;
  invoiceNumber: string;
  paymentIntent: string | null;
  amount: number;
  currency: string;
  status: PaymentStatus;
  gateway: string;
  userName: string;
  userEmail: string;
  appointmentType: string | undefined;
  consultantName: string | undefined;
  createdAt: Date;
};

export type OperatorInvoiceResult = {
  invoices: OperatorInvoice[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
};

/**
 * Fetch the operator invoice list for admin/staff dashboards.
 *
 * Single source of truth — call from any privileged-role route after running
 * `requirePrivilegedAuth()`. Do not re-implement these queries inside route
 * files.
 */
/**
 * Clamp and finite-check a pagination value. Guards against `NaN` from
 * `parseInt("abc")` propagating into Prisma `take` / `skip`.
 */
function sanitizePagination(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}

export async function getOperatorInvoices(
  filters: OperatorInvoiceFilters = {},
): Promise<OperatorInvoiceResult> {
  const status = filters.status ?? null;
  const search = filters.search ?? null;
  const orgId = filters.orgId ?? null;
  const limit = sanitizePagination(filters.limit, 20, 1, 200);
  const offset = sanitizePagination(filters.offset, 0, 0, Number.MAX_SAFE_INTEGER);

  // Build where clause
  const where: Prisma.PaymentWhereInput = {};
  if (status) {
    where.paymentStatus = status;
  }
  if (search) {
    where.OR = [
      { paymentIntent: { contains: search, mode: "insensitive" } },
      {
        user: {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { email: { contains: search, mode: "insensitive" } },
          ],
        },
      },
    ];
  }
  if (orgId) {
    where.organizationId = orgId;
  }

  // Get invoices (payments with succeeded status are considered invoices)
  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where: {
        ...where,
        paymentStatus: status || PaymentStatus.SUCCEEDED,
      },
      include: {
        user: {
          select: { name: true, email: true },
        },
        appointment: {
          include: {
            consultation: {
              include: {
                consultationPlan: {
                  include: {
                    consultantProfile: {
                      include: { user: { select: { name: true } } },
                    },
                  },
                },
              },
            },
            subscription: {
              include: {
                subscriptionPlan: {
                  include: {
                    consultantProfile: {
                      include: { user: { select: { name: true } } },
                    },
                  },
                },
              },
            },
            webinar: {
              include: {
                webinarPlan: {
                  include: {
                    consultantProfile: {
                      include: { user: { select: { name: true } } },
                    },
                  },
                },
              },
            },
            class: {
              include: {
                classPlan: {
                  include: {
                    consultantProfile: {
                      include: { user: { select: { name: true } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.payment.count({
      where: {
        ...where,
        paymentStatus: status || PaymentStatus.SUCCEEDED,
      },
    }),
  ]);

  // Helper to extract consultant name from different appointment types
  const getConsultantName = (
    appointment: (typeof payments)[0]["appointment"],
  ) => {
    if (!appointment) return undefined;
    return (
      appointment.consultation?.consultationPlan?.consultantProfile?.user
        ?.name ||
      appointment.subscription?.subscriptionPlan?.consultantProfile?.user
        ?.name ||
      appointment.webinar?.webinarPlan?.consultantProfile?.user?.name ||
      appointment.class?.classPlan?.consultantProfile?.user?.name ||
      undefined
    );
  };

  const invoices: OperatorInvoice[] = payments.map((p) => ({
    id: p.id,
    invoiceNumber: `INV-${p.id.slice(-8).toUpperCase()}`,
    paymentIntent: p.paymentIntent,
    amount: p.amount,
    currency: p.currency,
    status: p.paymentStatus,
    gateway: p.paymentGateway,
    userName: p.user?.name || "Unknown",
    userEmail: p.user?.email || "",
    appointmentType: p.appointment?.appointmentType,
    consultantName: getConsultantName(p.appointment),
    createdAt: p.createdAt,
  }));

  return {
    invoices,
    pagination: {
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
    },
  };
}
