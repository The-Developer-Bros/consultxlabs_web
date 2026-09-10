/**
 * PATCH /api/admin/leads/[leadId]
 *
 * Status transition on the enterprise pipeline (#1230 wave-4c). Guarded by
 * a CAS where-clause (status must be in the allowed-from set for the
 * target) so two operators working the queue can't double-advance past
 * each other; zero rows ⇒ 409.
 *
 * Allowed flow (authoritative): NEW → CONTACTED → QUALIFIED → CLOSED_WON |
 * CLOSED_LOST. NEW and CONTACTED may also be lost directly. QUALIFIED cannot
 * be skipped on the way to WON, and terminal states accept no further moves.
 */

import { NextResponse, type NextRequest } from "next/server";
import { LeadStatus } from "@prisma/client";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { applyRateLimit, adminMutationLimiter } from "@/lib/rate-limit";

const BodySchema = z.object({
  status: z.nativeEnum(LeadStatus),
});

// CR #1245 r1 — table tightened to match the documented flow exactly
// (QUALIFIED could previously be reached from NEW, and WON from NEW/
// CONTACTED, letting an operator skip the qualification step).
const ALLOWED_FROM: Record<LeadStatus, LeadStatus[]> = {
  [LeadStatus.CONTACTED]: [LeadStatus.NEW],
  [LeadStatus.QUALIFIED]: [LeadStatus.CONTACTED],
  [LeadStatus.CLOSED_WON]: [LeadStatus.QUALIFIED],
  [LeadStatus.CLOSED_LOST]: [
    LeadStatus.NEW,
    LeadStatus.CONTACTED,
    LeadStatus.QUALIFIED,
  ],
  [LeadStatus.NEW]: [],
};


export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> },
) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const limited = await applyRateLimit(
      adminMutationLimiter,
      auth.session.user.id,
    );
    if (limited) return limited;

    const { leadId } = await params;
    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }
    const to = parsed.data.status;

    const claim = await prisma.lead.updateMany({
      where: { id: leadId, status: { in: ALLOWED_FROM[to] } },
      data: { status: to },
    });
    if (claim.count === 0) {
      return NextResponse.json(
        {
          error:
            "Lead is terminal or was advanced concurrently — reload the list.",
          code: "LEAD_NOT_CLAIMABLE",
        },
        { status: 409 },
      );
    }

    const lead = await prisma.lead.findUniqueOrThrow({
      where: { id: leadId },
    });
    return NextResponse.json({ lead });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "admin_lead_transition_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json(
      { error: "Failed to update lead" },
      { status: 500 },
    );
  }
}
