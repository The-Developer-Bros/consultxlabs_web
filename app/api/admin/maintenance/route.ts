import * as Sentry from "@sentry/nextjs";
import {
  drainActiveSessions,
  unfreezeChannelsAfterMaintenance,
} from "@/actions/maintenance/drain-sessions";
import { reportSentryError } from "@/lib/observability/report";
import { freezeAppointments } from "@/actions/maintenance/freeze-appointments";
import { pauseDiscountCodes } from "@/actions/maintenance/pause-discount-codes";
import { runPostRecovery } from "@/actions/maintenance/post-recovery";
import { MaintenancePhase } from "@prisma/client";
import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { createIncident, resolveIncident } from "@/lib/betterstack";
import { requireAdminAuth } from "@/lib/auth-helpers";
import { getMaintenanceState, setMaintenanceState } from "@/lib/maintenance";
import prisma from "@/lib/prisma";

// Local wrapper preserves the existing call sites that expect `{ userId }`.
// Maintenance is now strictly ADMIN-only (was previously allowing STAFF too).
async function requireAdmin() {
  const result = await requireAdminAuth();
  if (result.error) return { error: result.error };
  return { userId: result.session.user.id };
}

const postSchema = z.object({
  phase: z.enum(["DEGRADED", "OFFLINE"]).optional(),
  reason: z.string().optional(),
  estimatedEnd: z.string().optional(),
  bypassDisputeCheck: z.boolean().optional(),
});

const patchSchema = z.object({
  phase: z.enum(["DEGRADED", "OFFLINE"]).optional(),
  reason: z.string().optional(),
  estimatedEnd: z.string().optional(),
});

type OfflineActivationResult = {
  drain?: Awaited<ReturnType<typeof drainActiveSessions>>;
  freeze?: Awaited<ReturnType<typeof freezeAppointments>>;
  discounts?: Awaited<ReturnType<typeof pauseDiscountCodes>>;
  errors: string[];
};

function parseOptionalDate(value?: string): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("estimatedEnd must be a valid ISO date/time string");
  }
  return parsed;
}

function formatError(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}

async function runOfflineActivation(
  estimatedEnd: Date | null,
): Promise<OfflineActivationResult> {
  const result: OfflineActivationResult = { errors: [] };
  const start = new Date();

  try {
    result.drain = await drainActiveSessions();
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "admin" } },
    );
    result.errors.push(formatError("drainActiveSessions failed", error));
  }

  try {
    result.freeze = await freezeAppointments(start, estimatedEnd);
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "admin" } },
    );
    result.errors.push(formatError("freezeAppointments failed", error));
  }

  try {
    result.discounts = await pauseDiscountCodes();
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "admin" } },
    );
    result.errors.push(formatError("pauseDiscountCodes failed", error));
  }

  return result;
}

/**
 * GET /api/admin/maintenance
 * Returns current maintenance state + recent maintenance windows.
 */
export async function GET() {
  const auth = await requireAdmin();
  if ("error" in auth && auth.error) return auth.error;

  const [state, recentWindows] = await Promise.all([
    getMaintenanceState(),
    prisma.maintenanceWindow.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  return NextResponse.json({ state, history: recentWindows });
}

/**
 * POST /api/admin/maintenance
 * Start maintenance mode.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if ("error" in auth && auth.error) return auth.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    );
  }

  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid request body",
        details: parsed.error.flatten().fieldErrors,
      },
      { status: 400 },
    );
  }
  const { phase, reason, estimatedEnd, bypassDisputeCheck } = parsed.data;
  let estimatedEndDate: Date | null = null;
  try {
    estimatedEndDate = parseOptionalDate(estimatedEnd);
  } catch (error) {
    return NextResponse.json(
      { error: formatError("Invalid estimatedEnd", error) },
      { status: 400 },
    );
  }

  // Block if open disputes have response deadlines within the maintenance window (+48h buffer)
  if (estimatedEndDate && !bypassDisputeCheck) {
    const bufferEnd = new Date(
      estimatedEndDate.getTime() + 48 * 60 * 60 * 1000,
    );
    const urgentDisputes = await prisma.dispute.findMany({
      where: {
        status: { in: ["NEEDS_RESPONSE", "WARNING_NEEDS_RESPONSE"] },
        dueBy: { gte: new Date(), lte: bufferEnd },
      },
      select: { id: true, dueBy: true, amountPaise: true, currency: true },
      orderBy: { dueBy: "asc" },
    });
    if (urgentDisputes.length > 0) {
      return NextResponse.json(
        {
          error: `${urgentDisputes.length} dispute(s) have response deadlines within the maintenance window. Resolve them first or pass bypassDisputeCheck: true to override.`,
          disputes: urgentDisputes,
        },
        { status: 409 },
      );
    }
  }

  const targetPhase =
    phase === "DEGRADED" ? MaintenancePhase.DEGRADED : MaintenancePhase.OFFLINE;

  const bypassSecret = crypto.randomUUID();

  let betterstackIncidentId: string | null = null;
  if (targetPhase === MaintenancePhase.OFFLINE) {
    betterstackIncidentId = await createIncident(
      "Platform Maintenance",
      reason || "Scheduled platform maintenance in progress",
    );
  }

  await setMaintenanceState(targetPhase, {
    reason,
    estimatedEnd: estimatedEndDate?.toISOString(),
    bypassSecret,
    startedBy: auth.userId,
    betterstackIncidentId: betterstackIncidentId ?? undefined,
  });

  let offlineActivation: OfflineActivationResult | undefined;
  if (targetPhase === MaintenancePhase.OFFLINE) {
    offlineActivation = await runOfflineActivation(estimatedEndDate);
  }

  return NextResponse.json({
    phase: targetPhase,
    bypassSecret,
    betterstackIncidentId,
    message: `Maintenance mode set to ${targetPhase}`,
    ...(offlineActivation?.drain !== undefined
      ? { drain: offlineActivation.drain }
      : {}),
    ...(offlineActivation?.freeze !== undefined
      ? { freeze: offlineActivation.freeze }
      : {}),
    ...(offlineActivation?.discounts !== undefined
      ? { discounts: offlineActivation.discounts }
      : {}),
    ...(offlineActivation && offlineActivation.errors.length > 0
      ? { setupErrors: offlineActivation.errors }
      : {}),
  });
}

/**
 * PATCH /api/admin/maintenance
 * Update maintenance phase or config (e.g., transition DEGRADED ↔ OFFLINE, update ETA).
 */
export async function PATCH(request: NextRequest) {
  const auth = await requireAdmin();
  if ("error" in auth && auth.error) return auth.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    );
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid request body",
        details: parsed.error.flatten().fieldErrors,
      },
      { status: 400 },
    );
  }
  const { phase, reason, estimatedEnd } = parsed.data;
  let estimatedEndDate: Date | null | undefined;
  try {
    estimatedEndDate =
      estimatedEnd === undefined ? undefined : parseOptionalDate(estimatedEnd);
  } catch (error) {
    return NextResponse.json(
      { error: formatError("Invalid estimatedEnd", error) },
      { status: 400 },
    );
  }

  const currentState = await getMaintenanceState();
  if (currentState.phase === "OFF") {
    return NextResponse.json(
      {
        error: "No active maintenance window to update. Use POST to start one.",
      },
      { status: 400 },
    );
  }

  const currentPhase = currentState.phase as MaintenancePhase;
  const targetPhase = phase ? (phase as MaintenancePhase) : currentPhase;
  const nextReason = reason ?? currentState.reason ?? undefined;
  const nextEstimatedEnd =
    estimatedEndDate === undefined
      ? (currentState.estimatedEnd ?? undefined)
      : estimatedEndDate?.toISOString();

  let betterstackIncidentId = currentState.betterstackIncidentId;
  if (
    currentPhase !== MaintenancePhase.OFFLINE &&
    targetPhase === MaintenancePhase.OFFLINE
  ) {
    betterstackIncidentId = await createIncident(
      "Platform Maintenance",
      nextReason || "Scheduled platform maintenance in progress",
    );
  } else if (
    currentPhase === MaintenancePhase.OFFLINE &&
    targetPhase !== MaintenancePhase.OFFLINE &&
    betterstackIncidentId
  ) {
    await resolveIncident(betterstackIncidentId);
    betterstackIncidentId = null;
  }

  await setMaintenanceState(targetPhase, {
    reason: nextReason,
    estimatedEnd: nextEstimatedEnd,
    bypassSecret: currentState.bypassSecret ?? undefined,
    betterstackIncidentId: betterstackIncidentId ?? undefined,
  });

  let offlineActivation: OfflineActivationResult | undefined;
  if (
    currentPhase !== MaintenancePhase.OFFLINE &&
    targetPhase === MaintenancePhase.OFFLINE
  ) {
    offlineActivation = await runOfflineActivation(estimatedEndDate ?? null);
  }

  return NextResponse.json({
    phase: targetPhase,
    betterstackIncidentId,
    transition: `${currentPhase} -> ${targetPhase}`,
    message: `Maintenance updated to ${targetPhase}`,
    ...(offlineActivation?.drain !== undefined
      ? { drain: offlineActivation.drain }
      : {}),
    ...(offlineActivation?.freeze !== undefined
      ? { freeze: offlineActivation.freeze }
      : {}),
    ...(offlineActivation?.discounts !== undefined
      ? { discounts: offlineActivation.discounts }
      : {}),
    ...(offlineActivation && offlineActivation.errors.length > 0
      ? { setupErrors: offlineActivation.errors }
      : {}),
  });
}

/**
 * DELETE /api/admin/maintenance
 * End maintenance mode (set phase=OFF).
 */
export async function DELETE() {
  const auth = await requireAdmin();
  if ("error" in auth && auth.error) return auth.error;

  const currentState = await getMaintenanceState();

  if (currentState.betterstackIncidentId) {
    await resolveIncident(currentState.betterstackIncidentId);
  }

  await setMaintenanceState(MaintenancePhase.OFF, {
    endedBy: auth.userId,
  });

  // #1146 — the unfreeze must not be able to be skipped by something upstream
  // of it throwing.
  //
  // This used to be a bare `await`, with the chat unfreeze below it. Every step
  // inside `runPostRecovery` is individually wrapped today, so a rejection is
  // unlikely in practice — but the call site took no responsibility for it, and
  // a single future unguarded `await` inside that function would make an OFF
  // transition skip the unfreeze entirely and brick group chat with no signal.
  // Stream grants `use-frozen-channel` to no role, so "bricked" means unwritable
  // by every user AND every admin, with no error and no visible cause.
  //
  // The recovery report is best-effort; the unfreeze is not.
  let recoveryResult: Awaited<ReturnType<typeof runPostRecovery>>;
  try {
    recoveryResult = await runPostRecovery();
  } catch (error) {
    reportSentryError(error, {
      subsystem: "admin",
      op: "maintenance.post-recovery",
    });
    recoveryResult = {
      database: false,
      redis: false,
      notification: false,
      errors: [formatError("runPostRecovery failed", error)],
    };
  }

  // #1134 — the drain freezes group chat channels on the way into OFFLINE, and
  // Stream grants `use-frozen-channel` to NO role by default, so a channel left
  // frozen is unwritable by every user AND every admin, with no visible cause.
  // Shipping the freeze without its inverse would leave a release window in
  // which ending maintenance silently bricks group chat, which is why both
  // halves are in this PR rather than four apart.
  //
  // Best-effort: a chat failure must not stop maintenance from ending. But it is
  // REPORTED and returned — a silent unfreeze failure is indistinguishable from
  // success, and being invisible is the entire problem with a frozen channel.
  let chat:
    | Awaited<ReturnType<typeof unfreezeChannelsAfterMaintenance>>
    | undefined;
  try {
    chat = await unfreezeChannelsAfterMaintenance();
    if (chat.errors.length > 0) {
      reportSentryError(
        new Error(
          `Maintenance unfreeze partially failed: ${chat.errors.length} channel(s)`,
        ),
        {
          subsystem: "stream",
          op: "maintenance.unfreeze",
          extra: { errors: chat.errors.slice(0, 10) },
        },
      );
    }
  } catch (error) {
    reportSentryError(error, {
      subsystem: "stream",
      op: "maintenance.unfreeze",
    });
    chat = {
      unfrozen: 0,
      errors: [error instanceof Error ? error.message : String(error)],
      source: "none",
    };
  }

  return NextResponse.json({
    phase: "OFF",
    message: "Maintenance mode ended",
    recovery: recoveryResult,
    // Surfaced, not swallowed: the caller is an operator ending maintenance and
    // needs to know if chat did not come back with it.
    chat,
  });
}
