/**
 * GET /api/organizations/[orgId]/support-threads
 *
 * #support-hub — ORG TRIAGE over members' per-appointment support threads.
 * Gated on `operations.read` (OWNER / MAINTAINER / MANAGER / SUPPORT).
 *
 * METADATA ONLY, by design: ADR 20 — an organization sees that a session
 * happened, never what happened in it, and a member's support conversation is
 * content (it contains their complaints). This endpoint selects an explicit
 * allowlist with NO messages, NO bodies, NO free text — the same discipline as
 * lib/api/scope/list-recordings.ts, pinned by
 * __tests__/security/org-scope-payload-allowlist.test.ts. The transcript
 * belongs to the participant and (once escalated) the platform's support team.
 *
 * Query params: `status`, `category`, `page`, `pageSize`.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { parsePagination } from "@/lib/enterprise/validators";
import { OrgIdParams } from "@/schemas/support";
import { parseRouteParams, supportError } from "@/lib/api/support-http";
import prisma from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import {
  SupportThreadCategoryEnum,
  SupportThreadStatusEnum,
} from "@/schemas/enums";

const ORG_THREADS_ROUTE = "organizations.support-threads";

const QuerySchema = z.object({
  status: SupportThreadStatusEnum.optional(),
  category: SupportThreadCategoryEnum.optional(),
});

// ADR-20 metadata allowlist. NOTHING here may be a message body or free text.
// The org-scope payload test fails if a content field joins this select.
const THREAD_METADATA_SELECT = {
  id: true,
  appointmentId: true,
  category: true,
  status: true,
  activeChannel: true,
  createdAt: true,
  lastMessageAt: true,
  resolvedAt: true,
  supportTicketId: true,
  user: { select: { id: true, name: true } },
  appointment: {
    select: {
      appointmentType: true,
      slotsOfAppointment: {
        orderBy: { startsAt: "asc" as const },
        take: 1,
        select: { startsAt: true, endsAt: true },
      },
      consultation: {
        select: { consultationPlan: { select: { title: true } } },
      },
      subscription: {
        select: { subscriptionPlan: { select: { title: true } } },
      },
      webinar: { select: { webinarPlan: { select: { title: true } } } },
      class: { select: { classPlan: { select: { title: true } } } },
    },
  },
} satisfies Prisma.AppointmentSupportThreadSelect;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const id = await parseRouteParams(OrgIdParams, params, {
    route: ORG_THREADS_ROUTE,
  });
  if (!id.ok) return id.response;
  const { orgId } = id.data;
  try {
    const access = await requireOrgAccess(orgId, { permission: "operations.read" });
    if (access.error) return access.error;

    const url = new URL(req.url);
    const filters = QuerySchema.safeParse({
      status: url.searchParams.get("status") ?? undefined,
      category: url.searchParams.get("category") ?? undefined,
    });
    if (!filters.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: filters.error.flatten(),
        context: { route: ORG_THREADS_ROUTE },
      });
    }
    const pagination = parsePagination(url);

    const where: Prisma.AppointmentSupportThreadWhereInput = {
      organizationId: orgId,
      ...(filters.data.status ? { status: filters.data.status } : {}),
      ...(filters.data.category ? { category: filters.data.category } : {}),
    };

    const [threads, total] = await Promise.all([
      prisma.appointmentSupportThread.findMany({
        where,
        orderBy: [
          { lastMessageAt: { sort: "desc", nulls: "last" } },
          { createdAt: "desc" },
        ],
        skip: (pagination.page - 1) * pagination.pageSize,
        take: pagination.pageSize,
        select: THREAD_METADATA_SELECT,
      }),
      prisma.appointmentSupportThread.count({ where }),
    ]);

    return NextResponse.json({
      data: threads.map((t) => ({
        id: t.id,
        appointmentId: t.appointmentId,
        category: t.category,
        status: t.status,
        activeChannel: t.activeChannel,
        createdAt: t.createdAt,
        lastMessageAt: t.lastMessageAt ?? t.createdAt,
        resolvedAt: t.resolvedAt,
        supportTicketId: t.supportTicketId,
        member: t.user,
        appointment: {
          appointmentType: t.appointment.appointmentType,
          startsAt: t.appointment.slotsOfAppointment[0]?.startsAt ?? null,
          planTitle:
            t.appointment.consultation?.consultationPlan?.title ??
            t.appointment.subscription?.subscriptionPlan?.title ??
            t.appointment.webinar?.webinarPlan?.title ??
            t.appointment.class?.classPlan?.title ??
            null,
        },
        // Deliberately NO transcript, NO last-message preview: metadata triage
        // only (ADR 20). The count of exchanges is operational metadata; their
        // content is not.
      })),
      pagination: {
        page: pagination.page,
        perPage: pagination.pageSize,
        total,
        pages: Math.ceil(total / pagination.pageSize),
      },
    });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: ORG_THREADS_ROUTE, action: "list", orgId },
    });
  }
}
