/**
 * POST /api/admin/reconcile-ledgers
 * GET  /api/admin/reconcile-ledgers
 *
 * Platform-admin-only ledger auditor.
 *
 *  - `POST` triggers a fresh reconciliation run synchronously and
 *    returns the resulting report. Body may include `{ organizationId }`
 *    to scope the run to a single org (faster, for targeted ops
 *    investigation); omit for a full-scope run (nightly-cron equivalent).
 *
 *  - `GET` lists the most recent reports (paginated). Useful for the
 *    admin UI to render a timeline of "ledger health" runs.
 *
 * Access: platform admins only via `requireBackofficeSurface("payouts.read")`
 * (ADMIN-only — STAFF is deliberately excluded: the reports expose cross-org
 * ledger aggregates incl. per-org wallet balances, which the settlement
 * surfaces keep ADMIN-only). Does NOT
 * grant org admins the ability to run reconciliation on their own org —
 * intentionally, because the reconcile output exposes cross-org
 * aggregate shapes that we don't want leaking through an in-app UI.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { runReconcileLedgers } from "@/scripts/reconcile/reconcile-ledgers";

const RunBodySchema = z.object({
  organizationId: z.string().min(1).optional(),
});

export async function POST(req: NextRequest) {
  const auth = await requireBackofficeSurface("payouts.read");
  if (auth.error) return auth.error;

  const raw = await req.json().catch(() => ({}));
  const parsed = RunBodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { organizationId } = parsed.data;
  const scope = organizationId ? `org:${organizationId}` : "full";
  // requirePrivilegedAuth returns the privileged session id so we can
  // attribute the run in the report row. Fall back to null for service
  // accounts / cli if the helper ever widens.
  const triggeredById =
    (auth as unknown as { session?: { user?: { id?: string } } }).session?.user?.id ??
    null;

  try {
    const report = await runReconcileLedgers({
      scope,
      organizationId: organizationId ?? undefined,
      triggeredById: triggeredById ?? undefined,
    });

    return NextResponse.json({ data: report });
  } catch (err) {
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "admin" } });
    console.error("[admin/reconcile-ledgers] run failed", err);
    return NextResponse.json(
      {
        error: "Reconciliation run failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireBackofficeSurface("payouts.read");
  if (auth.error) return auth.error;

  const url = new URL(req.url);
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 1),
    100,
  );
  const onlyDirty = url.searchParams.get("onlyDirty") === "true";

  const reports = await prisma.ledgerReconciliationReport.findMany({
    where: onlyDirty ? { ok: false } : undefined,
    orderBy: { runAt: "desc" },
    take: limit,
  });

  return NextResponse.json({ data: reports });
}
