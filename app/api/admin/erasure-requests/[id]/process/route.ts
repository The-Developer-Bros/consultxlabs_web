/**
 * POST /api/admin/erasure-requests/[id]/process
 *
 * Admin executes the scrub. The route flips the request status to
 * IN_PROGRESS (visible to a watching dashboard), invokes `scrubUser`,
 * and finalizes the row to COMPLETED on success. Idempotent: a
 * second invocation observes `erasedAt IS NOT NULL`, the helper
 * short-circuits, and we still mark the request COMPLETED so the
 * queue page advances.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireAdminAuth } from "@/lib/auth-helpers";
import { scrubUser } from "@/lib/compliance/erasure/scrub-user";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdminAuth();
  if (auth.error) return auth.error;
  const { id } = await params;

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

  // Move PENDING → IN_PROGRESS so a second admin clicking the same
  // button doesn't double-execute. The partial-unique index allows
  // both PENDING and IN_PROGRESS to count as "open"; the explicit
  // status flip is just for dashboard visibility.
  await prisma.erasureRequest.update({
    where: { id },
    data: { status: "IN_PROGRESS", processedByAdminId: auth.session.user.id },
  });

  try {
    const result = await scrubUser(prisma, request.userId);
    await prisma.erasureRequest.update({
      where: { id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        notes: result.scrubbed
          ? `Scrubbed across ${result.affectedOrganizationIds.length} org(s); pseudonymousId=${result.pseudonymousId.slice(0, 12)}…`
          : `User was already erased (idempotent); pseudonymousId=${result.pseudonymousId.slice(0, 12)}…`,
      },
    });
    return NextResponse.json({
      ok: true,
      affectedOrganizationIds: result.affectedOrganizationIds,
      pseudonymousId: result.pseudonymousId,
    });
  } catch (err) {
    // Flip back to PENDING so the queue picks it up again; record the
    // error in `notes` so the admin sees what blew up.
    await prisma.erasureRequest.update({
      where: { id },
      data: {
        status: "PENDING",
        notes: err instanceof Error ? err.message : String(err),
      },
    });
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "admin" } });
    return NextResponse.json(
      {
        error: "Erasure failed; request returned to PENDING",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
