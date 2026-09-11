/**
 * Per-org MemberRole transition policy.
 *
 * The product rule is that LEARNER and EXPERT are disjoint roles:
 * a member cannot flip between consuming services and delivering
 * them within the same Membership. They should be removed and
 * re-invited under the new role, which forces a fresh Membership
 * row with the right profile FKs (ConsulteeProfile vs
 * ConsultantProfile) and a clean audit entry.
 *
 * Other transitions (MAINTAINER <-> MANAGER, MANAGER -> LEARNER,
 * OWNER handoff via a separate flow, etc.) remain allowed and are
 * enforced by the existing role-hierarchy checks at the route layer.
 *
 * This module is the single source of truth for the blocked pairs so
 * the members PATCH route, audit/compliance tooling, and any future
 * bulk-role-change admin surface all read from the same set.
 */

import type { MemberRole } from "@prisma/client";

const BLOCKED_PAIRS = new Set<string>([
  "LEARNER>EXPERT",
  "EXPERT>LEARNER",
]);

export function isBlockedRoleTransition(
  from: MemberRole,
  to: MemberRole,
): boolean {
  if (from === to) return false;
  return BLOCKED_PAIRS.has(`${from}>${to}`);
}
