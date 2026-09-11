/**
 * POST /api/admin/erasure-requests/[id]/reject
 *
 * Admin rejects an erasure request (e.g. user is a financial obligor
 * with an open dispute). Required `reason` is stored on the row so the
 * user can see why; a future automated reply path will surface it.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireAdminAuth } from "@/lib/auth-helpers";

const BodySchema = z.object({
  reason: z.string().trim().min(1).max(2000),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdminAuth();
  if (auth.error) return auth.error;
  const { id } = await params;

  const raw = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "reason is required", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const request = await prisma.erasureRequest.findUnique({ where: { id } });
  if (!request) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }
  if (request.status === "COMPLETED" || request.status === "REJECTED") {
    return NextResponse.json(
      { error: `Request is already ${request.status}` },
      { status: 409 },
    );
  }

  const updated = await prisma.erasureRequest.update({
    where: { id },
    data: {
      status: "REJECTED",
      processedByAdminId: auth.session.user.id,
      notes: parsed.data.reason,
      completedAt: new Date(),
    },
  });

  return NextResponse.json({ request: updated });
}
