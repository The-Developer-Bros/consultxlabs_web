/**
 * #705 — recording, and reading, whether the tree actually helps.
 *
 * The deflection rate ("what fraction of conversations resolve without a
 * person") is the number every published support system tracks and the one this
 * subsystem could not produce, even retrospectively: platform-scope
 * resolutions wrote nothing at all.
 *
 * Read it with the caveat the research is unanimous about — deflection alone
 * scores a user who gave up exactly like a user who was helped. `recontactRate`
 * is the companion that catches that, and the two are meant to be read
 * together.
 */

import prisma from "@/lib/prisma";
import type { Prisma, SupportFlowOutcomeKind } from "@prisma/client";
import type { Tx } from "@/lib/prisma";

export interface FlowOutcomeInput {
  scope: "APPOINTMENT" | "PLATFORM";
  flowKey: string;
  terminalNodeId?: string | null;
  reason?: string | null;
  outcome: SupportFlowOutcomeKind;
  userId: string;
  organizationId?: string | null;
}

/**
 * Record one terminal turn. Never throws: an analytics row must not be able to
 * roll back the support turn that produced it, or a metric outage becomes a
 * support outage. Pass a `tx` when the caller already has one and WANTS the row
 * to share its fate.
 */
export async function recordFlowOutcome(
  input: FlowOutcomeInput,
  tx?: Tx,
): Promise<void> {
  const data = {
    scope: input.scope,
    flowKey: input.flowKey,
    terminalNodeId: input.terminalNodeId ?? null,
    reason: input.reason ?? null,
    outcome: input.outcome,
    userId: input.userId,
    organizationId: input.organizationId ?? null,
  };
  if (tx) {
    await tx.supportFlowOutcome.create({ data });
    return;
  }
  try {
    await prisma.supportFlowOutcome.create({ data });
  } catch (error) {
    console.error("support: failed to record flow outcome", { data, error });
  }
}

export interface DeflectionSummary {
  resolved: number;
  escalated: number;
  total: number;
  /** Null rather than 0 when nothing happened — 0% deflection and no traffic
   *  are different facts, and a dashboard that conflates them lies. */
  deflectionRate: number | null;
}

export async function deflectionSince(
  since: Date,
  where: Prisma.SupportFlowOutcomeWhereInput = {},
): Promise<DeflectionSummary> {
  const rows = await prisma.supportFlowOutcome.groupBy({
    by: ["outcome"],
    where: { ...where, createdAt: { gte: since } },
    _count: { _all: true },
  });
  const count = (kind: SupportFlowOutcomeKind) =>
    rows.find((r) => r.outcome === kind)?._count._all ?? 0;
  const resolved = count("RESOLVED");
  const escalated = count("ESCALATED");
  const total = resolved + escalated;
  return {
    resolved,
    escalated,
    total,
    deflectionRate: total ? Math.round((resolved / total) * 1000) / 10 : null,
  };
}
