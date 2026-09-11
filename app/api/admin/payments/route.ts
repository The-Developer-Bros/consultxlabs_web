import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import {
  Prisma,
  PaymentStatus,
  PaymentGateway,
  AppointmentsType,
} from "@prisma/client";

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    // Parse query parameters
    const searchParams = req.nextUrl.searchParams;
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "20");
    const status = searchParams.get("status") as PaymentStatus | null;
    const gateway = searchParams.get("gateway") as PaymentGateway | null;
    const appointmentType = searchParams.get(
      "appointmentType",
    ) as AppointmentsType | null;
    const search = searchParams.get("search");
    // #674 comment 7 — optional org-scope filter for support staff drilling
    // into a single tenant's payments. No extra permission gate needed:
    // the route is already privileged (requirePrivilegedAuth above).
    const orgId = searchParams.get("orgId");

    // Build where clause
    const where: Prisma.PaymentWhereInput = {};

    if (status) {
      where.paymentStatus = status;
    }

    if (gateway) {
      where.paymentGateway = gateway;
    }

    if (search) {
      where.paymentIntent = {
        contains: search,
        mode: "insensitive",
      };
    }

    if (appointmentType) {
      where.appointment = {
        appointmentType,
      };
    }

    if (orgId) {
      where.organizationId = orgId;
    }

    // Fetch payments with pagination
    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          appointment: {
            select: {
              appointmentType: true,
            },
          },
          // #1365 — drives the "Invoice" column; an operator answering "where
          // is my invoice" should not have to open each payment to find out.
          consumerInvoice: {
            select: { id: true, invoiceNumber: true, issuedAt: true },
          },
        },
      }),
      prisma.payment.count({ where }),
    ]);

    return NextResponse.json({
      payments,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "admin" } });
    console.error("Admin payments list error:", error);
    return NextResponse.json(
      { error: "Failed to fetch payments" },
      { status: 500 },
    );
  }
}
