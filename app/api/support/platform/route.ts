/**
 * #support-hub — PLATFORM-scope support intake (stateless).
 *
 * Platform issues (account, payments, site technical, general, operator
 * billing) have no appointment to hang a thread on. The flowchart runs
 * STATELESSLY: the client holds the cursor and replays it each turn; the
 * server validates every transition against the platform registry and never
 * trusts client state beyond "which node are you on". A terminal either
 * self-serves (nothing persisted) or escalates — the only write, a
 * SupportTicket via the shared factory with the walked path summarized in.
 *
 * GET  → the intent catalog for this caller (chips for the intake sheet).
 * POST → advance one turn: {flowId, nodeId?, chosenOptionId?/userMessage, orgId?}.
 *
 * Auth: any signed-in user (all roles — consultee, consultant, org operator).
 * Rate limit: same spam limiter as ticket creation, since escalation IS
 * ticket creation.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getSession } from "@/lib/auth-server";
import { supportError } from "@/lib/api/support-http";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";
import { assertBodySize } from "@/lib/validation/limits";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import prisma from "@/lib/prisma";
import { walkFlow } from "@/lib/support/flow-walk";
import {
  platformFlowsForContext,
  platformFlowForId,
  issueTypeForFlow,
  resolveOrgAttribution,
  type PlatformSupportContext,
} from "@/lib/support/platform-flows";
import {
  createSupportTicket,
  findRecentOpenEscalation,
} from "@/lib/support/create-ticket";
import { priorityForReason } from "@/lib/support/priority";
import { recordFlowOutcome } from "@/lib/support/deflection";
import { mentionsHumanKeyword } from "@/lib/support/escalation";

const turnSchema = z
  .object({
    flowId: z.string().min(1).max(64),
    /** Client-held cursor; null/omitted = first turn (entry prompt). */
    nodeId: z.string().max(64).nullable().optional(),
    chosenOptionId: z.string().max(200).optional(),
    userMessage: z.string().trim().max(2000).optional(),
    /** Org attribution for operator flows — validated against membership. */
    orgId: z.string().max(64).optional(),
  })
  // Only BOTH is invalid. An entry turn (nodeId null/omitted) legitimately
  // carries neither — startFlow sends {flowId} alone, and the XOR refinement
  // this replaced 400'd exactly that, breaking every intake's first click.
  .refine((v) => !(v.chosenOptionId && v.userMessage), {
    message: "Send either a chosen option or a message, not both",
  });

/** Resolve the caller's platform context (role-aware intent gating). */
async function buildPlatformContext(
  userId: string,
): Promise<PlatformSupportContext> {
  const memberships = await prisma.membership.findMany({
    where: { userId, status: "ACTIVE" },
    select: { organizationId: true, role: true },
  });
  return {
    userId,
    isOperator: memberships.some((m) =>
      hasOrgPermission(m.role, "operations.read"),
    ),
    organizationIds: memberships.map((m) => m.organizationId),
  };
}

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return supportError({ status: 401, code: "UNAUTHORIZED" });
    }
    const ctx = await buildPlatformContext(session.user.id);
    const flows = platformFlowsForContext(ctx).map((f) => ({
      id: f.id,
      title: f.title,
      description: f.description,
    }));
    return NextResponse.json({ data: { flows } });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: "support.platform", action: "catalog" },
    });
  }
}

export async function POST(req: NextRequest) {
  // Hoisted so the catch block can tag the Sentry event even when the throw
  // happened before/during parsing.
  let userId: string | null = null;
  let flowId: string | null = null;
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return supportError({ status: 401, code: "UNAUTHORIZED" });
    }
    userId = session.user.id;

    const tooLarge = assertBodySize(req);
    if (tooLarge) return tooLarge;

    const body = turnSchema.safeParse(await req.json().catch(() => ({})));
    if (!body.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: body.error.flatten(),
        context: { route: "support.platform", action: "turn" },
      });
    }
    const input = body.data;
    flowId = input.flowId;

    const ctx = await buildPlatformContext(session.user.id);
    const flow = platformFlowForId(ctx, input.flowId);
    // An unavailable flow (e.g. operator-only, or stale catalog) 404s rather
    // than silently escalating — the client should refetch the catalog.
    if (!flow) {
      return supportError({
        status: 404,
        code: "NOT_FOUND",
        message: "That support topic isn't available — refresh and pick again.",
        detail: { flowId: input.flowId },
        context: { route: "support.platform", action: "turn" },
      });
    }

    const walked = walkFlow(
      flow,
      input.nodeId ?? null,
      { chosenOptionId: input.chosenOptionId, userMessage: input.userMessage },
      // Platform scope has no cancellation preview — refund % stays null.
      { refundPctIfCancelledNow: null },
    );
    // Asking for a person gets you one, in this scope too. The appointment
    // thread honours these keywords through `decideEscalation`; nothing was
    // checking here, so the unrecognized-input nudge — which tells the user to
    // type "agent" — dead-ended in this drawer and simply re-presented itself.
    const turn = mentionsHumanKeyword(input.userMessage)
      ? {
          ...walked,
          escalate: true,
          resolved: false,
          reason: walked.reason ?? "general_human",
        }
      : walked;

    // Org attribution is resolved BEFORE the resolved-turn branch, because the
    // outcome row is attributed too. Writing `input.orgId` straight through
    // would have let a caller stamp an outcome with an org they do not belong
    // to — exactly the forgery `resolveOrgAttribution` exists to refuse.
    const attribution = resolveOrgAttribution({
      flowId: flow.id,
      requestedOrgId: input.orgId,
      activeOrganizationIds: ctx.organizationIds,
    });
    if (!attribution.ok) {
      return supportError({
        status: 403,
        code: "FORBIDDEN",
        context: {
          route: "support.platform",
          action: "turn",
          flowId: flow.id,
          attemptedOrgId: input.orgId,
        },
      });
    }
    const organizationId = attribution.organizationId;

    if (!turn.escalate) {
      // #705 — the platform scope persisted NOTHING on a resolved turn, so a
      // user the tree helped left no trace and deflection was unanswerable
      // even after the fact. This is a counter only: no message bodies.
      if (turn.resolved) {
        await recordFlowOutcome({
          scope: "PLATFORM",
          flowKey: flow.id,
          terminalNodeId:
            (turn.messages[0]?.metadata as { nodeId?: string } | undefined)
              ?.nodeId ?? null,
          reason: turn.reason ?? null,
          outcome: "RESOLVED",
          userId: session.user.id,
          organizationId,
        });
      }
      return NextResponse.json({
        data: {
          flowId: flow.id,
          messages: turn.messages,
          nextNodeId: turn.nextNodeId,
          resolved: turn.resolved,
          escalated: false,
          actions: turn.actions,
        },
      });
    }

    // ---- Escalation: the only write. The ticket spam budget is charged
    // HERE, not on navigation turns — walking a multi-node flow must never
    // spend the same budget as filing a ticket, or a user can be throttled
    // before reaching the terminal.
    const rl = await applyRateLimit(spamLimiter, `tickets:${session.user.id}`);
    if (rl) return rl;

    const reason = turn.reason ?? "platform_escalated";
    const issueType = issueTypeForFlow(flow, reason);
    const priority = priorityForReason(reason);

    const walkedPath = input.nodeId
      ? `Flow ${flow.id} at node ${input.nodeId}`
      : `Flow ${flow.id} entry`;
    const description = [
      `Escalated from platform support intake (${flow.title}, reason: ${reason}).`,
      input.userMessage ? `User said: "${input.userMessage}"` : null,
      `[${walkedPath}]`,
      organizationId ? `Organization: ${organizationId}` : null,
    ]
      .filter(Boolean)
      .join(" ");

    // Replay dedup: a double-clicked/retried terminal turn reuses the user's
    // recent OPEN ticket for the same outcome instead of filing a twin.
    const recent = await findRecentOpenEscalation(
      session.user.id,
      issueType,
      organizationId,
    );
    if (recent) {
      return NextResponse.json({
        data: {
          flowId: flow.id,
          messages: turn.messages,
          nextNodeId: null,
          resolved: false,
          escalated: true,
          actions: turn.actions,
          supportTicketId: recent.id,
          supportTicketReference: recent.referenceNumber,
          deduped: true,
        },
      });
    }

    const ticket = await createSupportTicket({
      userId: session.user.id,
      title: `${flow.title}: ${reason.replaceAll("_", " ").toLowerCase()}`,
      description,
      priority,
      issueType,
      organizationId,
    });

    await recordFlowOutcome({
      scope: "PLATFORM",
      flowKey: flow.id,
      reason,
      outcome: "ESCALATED",
      userId: session.user.id,
      organizationId,
    });

    return NextResponse.json({
      data: {
        flowId: flow.id,
        messages: turn.messages,
        nextNodeId: null,
        resolved: false,
        escalated: true,
        actions: turn.actions,
        supportTicketId: ticket.id,
        supportTicketReference: ticket.referenceNumber,
      },
    });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: {
        route: "support.platform",
        action: "turn",
        userId,
        flowId,
      },
    });
  }
}
