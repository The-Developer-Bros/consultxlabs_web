/**
 * Shared list-appointments query for the personal-vs-org-scope split
 * (#674 / B1-hybrid). One query, two routes:
 *
 *   - `/api/appointments?orgScope=...` — personal endpoint (auth: any
 *     signed-in user; defaults `personal`).
 *   - `/api/organizations/[orgId]/appointments` — org-scoped endpoint
 *     (auth: MANAGER+ at the org; scope is forced to `org:<orgId>`).
 *
 * Both routes call `listAppointmentsScoped` with the resolved Scope
 * and the same filters. The shape returned is identical so the same
 * client table component can render either source.
 *
 * Auth is enforced UPSTREAM in each route handler (`requireOrgAccess`
 * for the org route, session presence for the personal route). This
 * function trusts its caller — pass it the resolved Scope only after
 * `resolveOrgScope` returned `ok`.
 */

import prisma from "@/lib/prisma";
import type { AppointmentsType, Prisma } from "@prisma/client";
import type { Scope } from "./parse";
import { assertNeverScope } from "./parse";

export interface ListAppointmentsParams {
  scope: Scope;
  /** The session user's id. Used as the personal-scope filter root. */
  userId: string;
  /** Optional appointmentType filter (CONSULTATION/SUBSCRIPTION/...). */
  appointmentType?: AppointmentsType;
  /** Pagination — 1-indexed page, default 20 items per page. */
  page?: number;
  perPage?: number;
}

export interface ListAppointmentsResult {
  items: Awaited<ReturnType<typeof prisma.appointment.findMany>>;
  total: number;
  page: number;
  perPage: number;
}

/**
 * Build the Prisma `where` clause for the requested scope.
 *
 *   - `personal`: rows with `organizationId IS NULL` AND the user
 *     participates — either as the consultee (booked the session) OR as the
 *     consultant (owns the linked plan). Both sides are covered (#674): a
 *     consultant's own B2C sessions appear in their personal list; org-hosted
 *     sessions carry an organizationId and fall under `org` scope instead.
 *   - `org`: rows where `organizationId = orgId`. No user filter —
 *     MANAGER+ sees the org's full activity.
 *   - `all`: no scope filter; admin-only.
 */
export function buildWhere(
  params: ListAppointmentsParams,
): Prisma.AppointmentWhereInput {
  const base: Prisma.AppointmentWhereInput = {
    ...(params.appointmentType && {
      appointmentType: params.appointmentType,
    }),
  };

  if (params.scope.kind === "personal") {
    // #org-appts — the personal dashboards are now purely B2C on BOTH sides.
    // Every org-hosted session (delivered OR attended) lives in that org's
    // dashboard under `orgMember` scope, so both arms are constrained to
    // `organizationId: null`. This retires the earlier #674 carve-out that
    // force-showed delivered org sessions here — they were double-listed once
    // experts got a real org appointments surface. Trials stay B2C (personal)
    // even when org-tagged for analytics.
    const uid = params.userId;
    return {
      ...base,
      organizationId: null,
      OR: [
        // Consultee side — self-funded bookings.
        { consultation: { requestedBy: { userId: uid } } },
        { subscription: { requestedBy: { userId: uid } } },
        { trialSession: { consulteeProfile: { userId: uid } } },
        // Consultant side — sessions the user delivers B2C.
        { consultation: { consultationPlan: { consultantProfile: { userId: uid } } } },
        { subscription: { subscriptionPlan: { consultantProfile: { userId: uid } } } },
        { trialSession: { consultantProfile: { userId: uid } } },
        { webinar: { webinarPlan: { consultantProfile: { userId: uid } } } },
        { class: { classPlan: { consultantProfile: { userId: uid } } } },
      ],
    };
  }

  if (params.scope.kind === "orgMember") {
    // #org-appts — ONE member's own appointments WITHIN this org: sessions they
    // booked (as a learner), hold a seat in (webinar/class attendee), OR
    // deliver (as an expert). Hoists `organizationId: orgId` so it is strictly
    // this org's activity. Distinct from `org` (all-org, MANAGER+).
    //
    // Trials are intentionally EXCLUDED: a trial is a B2C acquisition session
    // (org-tagged only for conversion analytics, never org-sponsored), so it
    // belongs in the member's PERSONAL appointments, not the org view. The
    // attendee arm can't smuggle one in — trial checkout never stamps
    // Appointment.organizationId, so trials fail the org pin above.
    const uid = params.scope.userId;
    return {
      ...base,
      organizationId: params.scope.orgId,
      OR: [
        // Consumed as a learner (org-sponsored bookings).
        { consultation: { requestedBy: { userId: uid } } },
        { subscription: { requestedBy: { userId: uid } } },
        // #1166 ORG-5 — attended via a held seat. Group events share ONE
        // Appointment and registrants never appear in requestedBy, so without
        // this arm an org-sponsored webinar/class attendee's session was
        // invisible on BOTH dashboards (personal excludes org rows by design).
        // Mirrors lib/data/consultee-events-read.ts slot membership.
        { slotsOfAppointment: { some: { user: { some: { id: uid } } } } },
        // Delivered as an expert (owns the plan).
        { consultation: { consultationPlan: { consultantProfile: { userId: uid } } } },
        { subscription: { subscriptionPlan: { consultantProfile: { userId: uid } } } },
        { webinar: { webinarPlan: { consultantProfile: { userId: uid } } } },
        { class: { classPlan: { consultantProfile: { userId: uid } } } },
      ],
    };
  }

  if (params.scope.kind === "org") {
    // #1166 ORG-8 — org-OWNED rows only. The funded-elsewhere OR arm
    // (`payment.some.organizationId`) is gone: the detail page 404s any row
    // whose `organizationId` isn't this org, so the list was offering rows the
    // click could not open. Cross-org funding visibility (seats this org paid
    // for in another org's event) is the money views' responsibility now, not
    // this list's — the invoice/payments surfaces already carry those rows.
    return {
      ...base,
      organizationId: params.scope.orgId,
    };
  }

  // Explicit rather than a fall-through: `base` alone is the admin/staff arm,
  // so an unhandled kind reaching it would return every tenant's rows.
  if (params.scope.kind === "all") return base;

  return assertNeverScope(params.scope);
}

export async function listAppointmentsScoped(
  params: ListAppointmentsParams,
): Promise<ListAppointmentsResult> {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(100, Math.max(1, params.perPage ?? 20));
  const where = buildWhere(params);

  const [total, items] = await prisma.$transaction([
    prisma.appointment.count({ where }),
    prisma.appointment.findMany({
      where,
      include: {
        // Who from the VIEWING org was funded into this session.
        //
        // Scoped to `scope.orgId` and nothing else, which is the whole point: a
        // webinar's registrants may span several sponsors and the public, and a
        // sponsor is entitled to see the five people it paid for — not the
        // twenty it did not. Empty for 1:1 kinds, where `getMember` already
        // names the counterpart, and empty for a hosted-but-not-funded event.
        ...(params.scope.kind === "org"
          ? {
              payment: {
                where: { organizationId: params.scope.orgId },
                select: {
                  id: true,
                  user: { select: { id: true, name: true, email: true } },
                },
              },
            }
          : {}),
        // #org-appts — slot fields drive the in-context Join (getOrCreate needs
        // slot id + startsAt); consultantProfile.user.id lets the caller stamp
        // per-appointment identity into the Stream call (host/guest derivation).
        // deletedAt + meetingSession ride along so isDeadSlot/getSlotJoinState
        // see what they need: without deletedAt a tombstoned row counted as
        // live, and without meetingSession a host-ended call still offered
        // Join (booking-journey audit B7).
        slotsOfAppointment: {
          select: {
            id: true,
            startsAt: true,
            endsAt: true,
            isTentative: true,
            completionStatus: true,
            deletedAt: true,
            meetingSession: { select: { endedAt: true, endedReason: true } },
          },
          orderBy: { startsAt: "asc" },
        },
        consultation: {
          select: {
            consultationPlan: {
              select: {
                title: true,
                consultantProfile: {
                  select: {
                    user: { select: { id: true, name: true, email: true } },
                  },
                },
              },
            },
            requestedBy: {
              select: { user: { select: { id: true, name: true, email: true } } },
            },
          },
        },
        subscription: {
          select: {
            subscriptionPlan: {
              select: {
                title: true,
                consultantProfile: {
                  select: {
                    user: { select: { id: true, name: true, email: true } },
                  },
                },
              },
            },
            requestedBy: {
              select: { user: { select: { id: true, name: true, email: true } } },
            },
          },
        },
        webinar: {
          select: {
            webinarPlan: {
              select: {
                title: true,
                consultantProfile: {
                  select: {
                    user: { select: { id: true, name: true, email: true } },
                  },
                },
              },
            },
          },
        },
        class: {
          select: {
            classPlan: {
              select: {
                title: true,
                consultantProfile: {
                  select: {
                    user: { select: { id: true, name: true, email: true } },
                  },
                },
              },
            },
          },
        },
        trialSession: {
          select: {
            consulteeProfile: {
              select: { user: { select: { id: true, name: true, email: true } } },
            },
            consultantProfile: {
              select: { user: { select: { id: true, name: true, email: true } } },
            },
          },
        },
        organization: { select: { id: true, name: true, slug: true } },
      },
      orderBy: { createdAt: "desc" },
      take: perPage,
      skip: (page - 1) * perPage,
    }),
  ]);

  return { items, total, page, perPage };
}
