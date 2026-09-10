/**
 * GET /api/admin/leads
 *
 * Enterprise sales-pipeline list (#1230 wave-4c). Status filter + newest-
 * first cursor pagination, mirroring the admin route conventions
 * (requirePrivilegedAuth; nav surface `leads.manage` gates visibility).
 */

import { NextResponse, type NextRequest } from "next/server";
import { LeadStatus } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";

const PAGE_SIZE = 50;

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const cursor = searchParams.get("cursor");

    // `in` accepts constructor/toString — validate against actual values.
    if (
      status &&
      !Object.values(LeadStatus).includes(status as LeadStatus)
    ) {
      return NextResponse.json(
        { error: `Unknown lead status "${status}"` },
        { status: 400 },
      );
    }

    const leads = await prisma.lead.findMany({
      where: {
        ...(status ? { status: status as LeadStatus } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        sourceCategory: true,
        companyName: true,
        contactName: true,
        contactEmail: true,
        phone: true,
        subject: true,
        message: true,
        status: true,
        createdAt: true,
      },
    });

    const nextCursor =
      leads.length === PAGE_SIZE ? leads[leads.length - 1].id : null;

    return NextResponse.json({ leads, nextCursor });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "admin_leads_list_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json(
      { error: "Failed to load leads" },
      { status: 500 },
    );
  }
}
