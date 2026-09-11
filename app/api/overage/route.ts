import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { headers } from "next/headers";
import { NextResponse } from "next/server";

/**
 * #775 — list the caller's outstanding CHARGE_MEMBER overage charges.
 *
 * GET /api/overage
 *
 * Backs the member-facing "pay your overage" surface. Only PENDING/FAILED
 * member-owed side-charges are listed — CHARGED/REVERSED ones have settled and
 * drop out. Ownership is scoped through the side-`Payment.userId`.
 */
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const userId = session.user.id;

  const rows = await prisma.overageEvent.findMany({
    where: {
      overageBehavior: "CHARGE_MEMBER",
      chargeStatus: { in: ["PENDING", "FAILED"] },
      payment: { is: { userId } },
    },
    select: {
      id: true,
      marginalPaise: true,
      currency: true,
      chargeStatus: true,
      createdAt: true,
      programAssignment: {
        select: {
          program: {
            select: {
              name: true,
              contract: {
                select: { organization: { select: { name: true } } },
              },
            },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({
    charges: rows.map((r) => ({
      id: r.id,
      amountPaise: r.marginalPaise,
      currency: r.currency,
      status: r.chargeStatus,
      programName: r.programAssignment.program.name,
      orgName: r.programAssignment.program.contract.organization.name,
      createdAt: r.createdAt,
    })),
  });
}
