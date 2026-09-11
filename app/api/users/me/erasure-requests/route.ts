/**
 * GET  /api/users/me/erasure-requests — show the user's open/most-recent request.
 * POST /api/users/me/erasure-requests — file a DPDP §12 erasure request.
 *
 * Idempotent POST: if the user already has an open (PENDING / IN_PROGRESS)
 * request, the route returns that row instead of creating a duplicate. The
 * partial-unique index on `(userId, status IN PENDING|IN_PROGRESS)` is the
 * DB-side guarantee; the route's lookup-then-insert pattern is the
 * friendly happy-path.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";

const CreateBodySchema = z.object({
  reason: z.string().trim().min(1).max(1000).optional(),
});

export async function GET() {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;

  const requests = await prisma.erasureRequest.findMany({
    where: { userId: auth.session.user.id },
    orderBy: { requestedAt: "desc" },
    take: 10,
  });
  return NextResponse.json({ data: requests });
}

export async function POST(req: Request) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;

  const raw = await req.json().catch(() => null);
  const parsed = CreateBodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const userId = auth.session.user.id;

  // Idempotent: short-circuit on an existing open request.
  const existing = await prisma.erasureRequest.findFirst({
    where: {
      userId,
      status: { in: ["PENDING", "IN_PROGRESS"] },
    },
  });
  if (existing) {
    return NextResponse.json({ request: existing }, { status: 200 });
  }

  const created = await prisma.$transaction(async (tx) => {
    const request = await tx.erasureRequest.create({
      data: {
        userId,
        status: "PENDING",
        reason: parsed.data.reason ?? null,
      },
    });
    // No org-scoped audit — the user may not be in any org. We log via
    // a SYSTEM-bucket row scoped to NULL organizationId is not allowed
    // by the schema, so the user-initiated request is recorded inline
    // on the ErasureRequest itself. The processing path writes per-org
    // audit rows once we know which orgs are affected.
    return request;
  });

  return NextResponse.json({ request: created }, { status: 201 });
}
