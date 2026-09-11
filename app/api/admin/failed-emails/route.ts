/**
 * GET  /api/admin/failed-emails
 * POST /api/admin/failed-emails
 *
 * #474 — operator surface for the transactional-email dead-letter queue.
 *
 *  - `GET` lists FailedEmail rows (most recent first), optionally filtered to
 *    a single `status` (e.g. DEAD_LETTER) for triage.
 *
 *  - `POST { ids: [...] }` requeues DEAD_LETTER rows: status → PENDING,
 *    nextRetryAt → now, attempts reset to 0 so the backoff schedule restarts.
 *    The worker (jobs/email/retry-failed-emails.ts) replays the stored html/
 *    text VERBATIM on its next tick — no re-render, no dispatcher. Scoped to
 *    DEAD_LETTER so a replay can't yank a row that's mid-retry.
 *
 * Access: platform admins only via `requirePrivilegedAuth`. The rendered
 * bodies can carry payment/PII detail, so this never reaches an org UI.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";

const ReplayBodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
});

const StatusSchema = z.enum(["PENDING", "RETRY", "SENT", "DEAD_LETTER"]);

export async function GET(req: NextRequest) {
  const auth = await requirePrivilegedAuth();
  if (auth.error) return auth.error;

  const url = new URL(req.url);
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1),
    200,
  );
  const statusParam = url.searchParams.get("status");
  const status = statusParam
    ? StatusSchema.safeParse(statusParam)
    : undefined;
  if (status && !status.success) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const rows = await prisma.failedEmail.findMany({
    where: status?.success ? { status: status.data } : undefined,
    orderBy: { createdAt: "desc" },
    take: limit,
    // Don't ship the rendered html/text bodies in the list view — they can be
    // large and carry PII. Operators replay by id; detail isn't needed here.
    select: {
      id: true,
      recipient: true,
      subject: true,
      emailType: true,
      status: true,
      attempts: true,
      nextRetryAt: true,
      lastError: true,
      sentAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return NextResponse.json({ data: rows });
}

export async function POST(req: NextRequest) {
  const auth = await requirePrivilegedAuth();
  if (auth.error) return auth.error;

  const raw = await req.json().catch(() => ({}));
  const parsed = ReplayBodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Only DEAD_LETTER rows are replayable — PENDING/RETRY are already in the
  // worker's queue, and re-queuing a SENT row would re-deliver a live email.
  const requeued = await prisma.failedEmail.updateMany({
    where: { id: { in: parsed.data.ids }, status: "DEAD_LETTER" },
    data: {
      status: "PENDING",
      attempts: 0,
      nextRetryAt: new Date(),
      lastError: null,
    },
  });

  return NextResponse.json({ data: { requeued: requeued.count } });
}
