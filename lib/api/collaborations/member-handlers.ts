import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import prisma from "@/lib/prisma";
import {
  CollaboratorNotFoundError,
  CollaboratorTermsLockedError,
  updateCollaborator,
  removeCollaborator,
} from "@/lib/collaborators/service";
import {
  updateClassCollaboratorSchema,
  updateWebinarCollaboratorSchema,
} from "@/schemas/collaborators";

/**
 * The PATCH and DELETE bodies of `/api/collaborations/{webinar,class}/[planId]/[id]`.
 * The two route files were byte-for-byte twins apart from the plan model and
 * the Zod schema, so they are thin wrappers over this module (#1580 C-P2-7).
 */
type PlanType = "webinar" | "class";
type RouteContext = { params: Promise<{ planId: string; id: string }> };

const UPDATE_SCHEMAS = {
  webinar: updateWebinarCollaboratorSchema,
  class: updateClassCollaboratorSchema,
} as const;

const captureRouteError = (
  error: unknown,
  what: string,
  planType: PlanType,
) => {
  Sentry.captureException(
    error instanceof Error ? error : new Error(String(error)),
    { tags: { subsystem: "collaborations" } },
  );
  console.error(`Error ${what} ${planType} collaborator:`, error);
};

/**
 * The plan's owner profile id and the caller's profile id. Either missing is
 * a refusal: comparing `plan?.consultantProfileId` to `ownerProfile?.id` let
 * two undefineds match and waved a stranger through on a plan without an
 * owner (#1580 C-P2-7).
 */
async function resolveParties(
  planType: PlanType,
  planId: string,
  userId: string,
) {
  const [plan, callerProfile] = await Promise.all([
    planType === "webinar"
      ? prisma.webinarPlan.findUnique({
          where: { id: planId },
          select: { consultantProfileId: true },
        })
      : prisma.classPlan.findUnique({
          where: { id: planId },
          select: { consultantProfileId: true },
        }),
    prisma.consultantProfile.findFirst({
      where: { userId },
      select: { id: true },
    }),
  ]);
  if (!plan || !callerProfile) return null;
  return {
    callerProfileId: callerProfile.id,
    isOwner:
      plan.consultantProfileId !== null &&
      plan.consultantProfileId === callerProfile.id,
  };
}

export async function patchCollaborator(
  planType: PlanType,
  req: NextRequest,
  { params }: RouteContext,
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { planId, id } = await params;

    const parties = await resolveParties(planType, planId, session.user.id);
    if (!parties?.isOwner) {
      return NextResponse.json(
        { error: "Only the plan owner can update collaborators" },
        { status: 403 },
      );
    }

    const body = await req.json();
    const parsed = UPDATE_SCHEMAS[planType].safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors.map((e) => e.message).join(", ") },
        { status: 400 },
      );
    }

    const collab = await updateCollaborator(planType, id, planId, parsed.data);
    if (!collab) {
      return NextResponse.json(
        { error: "Failed to update collaborator" },
        { status: 400 },
      );
    }
    return NextResponse.json({ data: collab });
  } catch (error) {
    if (error instanceof CollaboratorTermsLockedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof CollaboratorNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    captureRouteError(error, "updating", planType);
    return NextResponse.json(
      { error: "Failed to update collaborator" },
      { status: 500 },
    );
  }
}

const NOT_A_PARTY =
  "Only the plan owner or the collaborator can remove this collaboration";

export async function deleteCollaborator(
  planType: PlanType,
  _req: NextRequest,
  { params }: RouteContext,
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { planId, id } = await params;

    const parties = await resolveParties(planType, planId, session.user.id);
    if (!parties) {
      return NextResponse.json({ error: NOT_A_PARTY }, { status: 403 });
    }

    // The owner removes any row; a collaborator may withdraw their own
    // PENDING/ACCEPTED row (#1580 C-P1-7), in which case the host is notified.
    const collab = parties.isOwner
      ? await removeCollaborator(planType, id, planId)
      : await removeCollaborator(planType, id, planId, {
          withdrawnByProfileId: parties.callerProfileId,
        });
    if (!collab) {
      return parties.isOwner
        ? NextResponse.json(
            { error: "Failed to remove collaborator" },
            { status: 400 },
          )
        : NextResponse.json({ error: NOT_A_PARTY }, { status: 403 });
    }
    return NextResponse.json({ data: collab });
  } catch (error) {
    captureRouteError(error, "removing", planType);
    return NextResponse.json(
      { error: "Failed to remove collaborator" },
      { status: 500 },
    );
  }
}
