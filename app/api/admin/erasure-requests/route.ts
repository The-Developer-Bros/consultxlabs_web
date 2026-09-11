/**
 * GET /api/admin/erasure-requests
 *
 * Admin review queue. Surfaces PENDING + IN_PROGRESS requests first
 * (the ones that have an SLA clock), then COMPLETED / REJECTED for
 * historical context. Admin-only.
 */

import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAdminAuth } from "@/lib/auth-helpers";

export async function GET() {
  const auth = await requireAdminAuth();
  if (auth.error) return auth.error;

  const requests = await prisma.erasureRequest.findMany({
    orderBy: [{ status: "asc" }, { requestedAt: "asc" }],
    take: 200,
    include: {
      user: { select: { id: true, name: true, email: true, erasedAt: true } },
    },
  });
  return NextResponse.json({ data: requests });
}
