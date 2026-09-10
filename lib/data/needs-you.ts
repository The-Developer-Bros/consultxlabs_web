import prisma from "@/lib/prisma";
import type { Scope } from "@/lib/api/scope/parse";
import { scopeToWhereOrgId } from "@/lib/api/scope/parse";

/**
 * Cross-context "needs you" roll-up for a consultant.
 *
 * ADR 19 splits the dashboards by the org-ness of the underlying work, and
 * accepts as a known cost that "a consultant who works through an organization
 * now visits two dashboards". It also states the only sanctioned remedy: a
 * cross-context summary "would have to be built as a derived read rather than
 * by re-merging the views". This is that derived read.
 *
 * It deliberately returns COUNTS AND LINKS ONLY. It does not return rows, and
 * nothing renders from it in place — every item routes the user into the
 * dashboard that owns the work, which is what keeps each number authoritative
 * in exactly one place.
 */

export interface NeedsYouContext {
  /** Null for the personal B2C context. */
  organizationId: string | null;
  label: string;
  /** Booking requests waiting for this consultant to allocate slots. */
  pendingRequests: number;
  /** Where to send someone who clicks through. */
  href: string;
}

export interface NeedsYouSummary {
  contexts: NeedsYouContext[];
  total: number;
}

/**
 * #674 defect 13 — the org dimension comes from the shared projector, so
 * "what personal means" is defined once (lib/api/scope/parse.ts) instead of
 * being re-typed as a literal at each call site. The extra `appointment: null`
 * arm below is this surface's own business rule, not a scope rule: a request
 * has no appointment until it is allocated, and an unallocated request is by
 * definition not org-funded.
 *
 * #1345 — exported because the consultant Home badge counts the same cohort a
 * few inches above NeedsYou, and re-typing the predicate there let the two
 * numbers drift into different scopes.
 */
export function pendingConsultationWhere(
  consultantProfileId: string,
  scope: Scope,
) {
  const orgWhere = scopeToWhereOrgId(scope);
  return {
    status: "PENDING" as const,
    consultationPlan: { consultantProfileId },
    ...(scope.kind === "personal"
      ? { OR: [{ appointment: null }, { appointment: orgWhere }] }
      : { appointment: orgWhere }),
  };
}

export function pendingSubscriptionWhere(
  consultantProfileId: string,
  scope: Scope,
) {
  return {
    status: "PENDING" as const,
    subscriptionPlan: { consultantProfileId },
    // The personal arm cannot use the projector: a subscription spans many
    // appointments, so "personal" is the absence of ANY org-tagged child
    // rather than a pin on one row.
    appointments:
      scope.kind === "personal"
        ? { none: { organizationId: { not: null } } }
        : { some: scopeToWhereOrgId(scope) },
  };
}

/**
 * @param userId              the signed-in user
 * @param consultantProfileId their delivering profile
 */
export async function getNeedsYouSummary(
  userId: string,
  consultantProfileId: string,
): Promise<NeedsYouSummary> {
  // Memberships + personal-scope counts share no dependency — fetch together
  // so the personal context does not wait on the membership round-trip.
  const [deliveringMemberships, personalConsultations, personalSubscriptions] =
    await Promise.all([
      prisma.membership.findMany({
        where: {
          userId,
          status: "ACTIVE",
          consultantProfileId,
          organization: { canHost: true },
        },
        select: {
          organizationId: true,
          organization: { select: { name: true } },
        },
      }),
      prisma.consultation.count({
        where: pendingConsultationWhere(consultantProfileId, {
          kind: "personal",
        }),
      }),
      prisma.subscription.count({
        where: pendingSubscriptionWhere(consultantProfileId, {
          kind: "personal",
        }),
      }),
    ]);

  const orgScopes = deliveringMemberships.map((m) => ({
    organizationId: m.organizationId as string,
    label: m.organization.name,
    href: `/dashboard/organization/${m.organizationId}/requests`,
  }));

  const orgCounts = await Promise.all(
    orgScopes.map(async (scope) => {
      const [consultations, subscriptions] = await Promise.all([
        prisma.consultation.count({
          where: pendingConsultationWhere(consultantProfileId, {
            kind: "org",
            orgId: scope.organizationId,
          }),
        }),
        prisma.subscription.count({
          where: pendingSubscriptionWhere(consultantProfileId, {
            kind: "org",
            orgId: scope.organizationId,
          }),
        }),
      ]);
      return {
        ...scope,
        pendingRequests: consultations + subscriptions,
      };
    }),
  );

  const contexts = [
    {
      organizationId: null,
      label: "Personal",
      href: `/dashboard/consultant/${consultantProfileId}/requests`,
      pendingRequests: personalConsultations + personalSubscriptions,
    },
    ...orgCounts,
  ].filter((c) => c.pendingRequests > 0);

  return {
    contexts,
    total: contexts.reduce((sum, c) => sum + c.pendingRequests, 0),
  };
}
