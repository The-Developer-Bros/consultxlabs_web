/**
 * Staff Support Tickets API
 * Staff/Admin access to all support tickets with filtering and pagination
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import {
  SupportTicketStatus,
  SupportPriority,
  SupportIssueType,
  Prisma,
} from "@prisma/client";

/**
 * GET /api/staff/support-tickets
 * List all support tickets with filters (staff/admin access)
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    // Parse query parameters
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status") as SupportTicketStatus | null;
    const priority = searchParams.get("priority") as SupportPriority | null;
    const issueType = searchParams.get("issueType") as SupportIssueType | null;
    const assignedToId = searchParams.get("assignedToId");
    const search = searchParams.get("search");
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "20");
    const offset = (page - 1) * limit;

    // Build where clause
    const where: Prisma.SupportTicketWhereInput = {};

    if (status) {
      where.status = status;
    }
    if (priority) {
      where.priority = priority;
    }
    if (issueType) {
      where.issueType = issueType;
    }
    if (assignedToId) {
      where.assignedToId = assignedToId === "unassigned" ? null : assignedToId;
    }
    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
        { id: { contains: search, mode: "insensitive" } },
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

    // Get tickets with related data
    const [tickets, total] = await Promise.all([
      prisma.supportTicket.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
            },
          },
          _count: {
            select: {
              responses: true,
              attachments: true,
            },
          },
        },
        orderBy: [
          { priority: "desc" }, // URGENT first
          { createdAt: "desc" },
        ],
        take: limit,
        skip: offset,
      }),
      prisma.supportTicket.count({ where }),
    ]);

    // Format response
    const formattedTickets = tickets.map((ticket) => ({
      id: ticket.id,
      title: ticket.title,
      description: ticket.description,
      priority: ticket.priority,
      status: ticket.status,
      category: ticket.category,
      issueType: ticket.issueType,
      user: ticket.user,
      assignedToId: ticket.assignedToId,
      responseCount: ticket._count.responses,
      attachmentCount: ticket._count.attachments,
      // Entity links
      consultationId: ticket.consultationId,
      subscriptionId: ticket.subscriptionId,
      paymentId: ticket.paymentId,
      refundId: ticket.refundId,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
    }));

    // Get counts by status for dashboard
    const statusCounts = await prisma.supportTicket.groupBy({
      by: ["status"],
      _count: { id: true },
    });

    const counts = {
      total,
      open: statusCounts.find((s) => s.status === "OPEN")?._count.id || 0,
      inProgress:
        statusCounts.find((s) => s.status === "IN_PROGRESS")?._count.id || 0,
      onHold: statusCounts.find((s) => s.status === "ON_HOLD")?._count.id || 0,
      resolved:
        statusCounts.find((s) => s.status === "RESOLVED")?._count.id || 0,
      closed: statusCounts.find((s) => s.status === "CLOSED")?._count.id || 0,
    };

    return NextResponse.json({
      tickets: formattedTickets,
      counts,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasMore: offset + limit < total,
      },
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "staff" } });
    console.error("Error fetching support tickets:", error);
    return NextResponse.json(
      { error: "Failed to fetch support tickets" },
      { status: 500 },
    );
  }
}
