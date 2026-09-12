import type { CollaboratorRole } from "@prisma/client";

// #1580 §6 — the one co-presenter a plan may carry (CO_HOST / CO_INSTRUCTOR).
// Its own module so call, recording and access code can read it without the
// service's Stream and Novu graph.
export const PRESENTER_ROLES: readonly CollaboratorRole[] = [
  "CO_HOST",
  "CO_INSTRUCTOR",
];

/** #1580 C-P1-4 — host controls (end for everyone, record) reach presenters only. */
export function isPresenterRole(role: CollaboratorRole): boolean {
  return PRESENTER_ROLES.includes(role);
}
