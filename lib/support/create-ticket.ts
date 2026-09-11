/**
 * #support-hub — the single factory for creating SupportTickets, shared by the
 * legacy user route, the per-appointment escalation path, and the platform
 * intake. One place for: staff notification, org attribution, and the
 * session-scope guard that keeps appointment-specific issue types out of the
 * platform queue (they belong on the per-appointment "Get help" threads).
 */

import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
} from "@/lib/prisma";
import type {
  SupportIssueType,
  SupportPriority,
  SupportTicket,
} from "@prisma/client";
import {
  notifySupportTicketCreated,
  notifySupportTicketUpdateForStaff,
} from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import { allocateTicketReference } from "./reference";
import { slaDeadlinesFor } from "./sla";

/**
 * Issue types that describe WHAT HAPPENED IN A SESSION. The platform-level
 * ticket form and the platform intake must not offer them — a user with one of
 * these picks the session first, and the per-appointment flowchart thread
 * routes it (with context) into the queue.
 */
export const SESSION_SCOPED_ISSUE_TYPES: ReadonlySet<SupportIssueType> =
  new Set([
    "CONSULTANT_NO_SHOW",
    "CONSULTANT_LATE",
    "SESSION_ENDED_EARLY",
    "SESSION_QUALITY_POOR",
    "COMMUNICATION_ISSUE",
    "WRONG_CONSULTANT",
    "ACCESS_ISSUE",
    "TIMEZONE_CONFUSION",
    "RESCHEDULING_HELP",
    "WANT_TO_CANCEL",
    "CANCELLATION_ISSUE",
    "DOCUMENT_ISSUE",
  ]);

export function isSessionScopedIssueType(
  issueType: SupportIssueType | null | undefined,
): boolean {
  return !!issueType && SESSION_SCOPED_ISSUE_TYPES.has(issueType);
}

export interface CreateSupportTicketInput {
  userId: string;
  title: string;
  description: string;
  priority?: SupportPriority;
  category?: string | null;
  issueType?: SupportIssueType | null;
  consultationId?: string | null;
  subscriptionId?: string | null;
  paymentId?: string | null;
  /** Org attribution (operator intake / escalated org threads). Null = B2C. */
  organizationId?: string | null;
}

/**
 * Fire-and-forget staff notification — shared by every creation path.
 *
 * Exported because the per-appointment escalation creates its ticket INSIDE a
 * transaction (atomically with the thread's state change) and so cannot use
 * `createSupportTicket`. It calls this after the transaction commits, which
 * keeps the invariant that matters: staff are never told about a ticket a
 * rollback then erased.
 */
export async function notifySupportStaff(
  ticket: Pick<
    SupportTicket,
    "id" | "title" | "organizationId" | "referenceNumber"
  >,
): Promise<void> {
  // ADR 23 — the notification inherits the ticket's org-ness (attribution +
  // deep-link filing only; recipient lists are unchanged).
  let orgName: string | null = null;
  if (ticket.organizationId) {
    const org = await prisma.organization.findUnique({
      where: { id: ticket.organizationId },
      select: { name: true },
    });
    orgName = org?.name ?? null;
  }
  const staffUsers = await prisma.user.findMany({
    where: { role: { in: ["STAFF", "ADMIN"] } },
    select: { id: true },
  });
  void notifySupportTicketCreated(
    staffUsers.map((u) => u.id),
    {
      ticketId: ticket.id,
      // Lead with the reference: it is what the user will quote back.
      ticketTitle: ticket.referenceNumber
        ? `${ticket.referenceNumber} — ${ticket.title || "Support Ticket"}`
        : ticket.title || "Support Ticket",
      dashboardUrl: "/dashboard/admin/tickets",
      ...notificationScope(ticket.organizationId, orgName),
    },
  );
}

/**
 * #705 — page ops when the USER adds to an existing ticket. Both directions of
 * this conversation now notify: previously a reply into an escalated thread, or
 * onto a ticket, told nobody, so staff only learned of it by reopening the
 * inbox. Prefers the assignee — fanning every reply at every staff member is
 * how a queue's notifications get muted.
 */
export async function notifyStaffOfTicketActivity(
  ticketId: string,
  organizationId?: string | null,
  /**
   * Identifies THIS activity. Without it `deriveTransactionId` falls back to
   * hashing the payload, which is byte-identical for every reply on the same
   * ticket — Novu rejects a repeated transactionId, so only the first reply
   * would ever have paged anyone.
   */
  eventId?: string,
): Promise<void> {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: {
      title: true,
      assignedToId: true,
      referenceNumber: true,
      organizationId: true,
    },
  });
  if (!ticket) return;
  const recipients = ticket.assignedToId
    ? [ticket.assignedToId]
    : (
        await prisma.user.findMany({
          where: { role: { in: ["STAFF", "ADMIN"] } },
          select: { id: true },
        })
      ).map((u) => u.id);
  if (recipients.length === 0) return;
  void notifySupportTicketUpdateForStaff(
    recipients,
    {
      ticketId,
      ticketTitle: ticket.referenceNumber
        ? `${ticket.referenceNumber} — ${ticket.title}`
        : ticket.title,
      dashboardUrl: "/dashboard/admin/tickets",
      ...notificationScope(organizationId ?? ticket.organizationId),
    },
    eventId ?? `${ticketId}:${Date.now()}`,
  );
}

/**
 * Create a support ticket + notify the ops queue. Callers own validation and
 * dedup (e.g. the paymentId dedup is a route-level UX decision).
 */
export async function createSupportTicket(
  input: CreateSupportTicketInput,
): Promise<SupportTicket> {
  const priority = input.priority ?? "MEDIUM";
  // One transaction so a rolled-back ticket cannot leave a live reference
  // behind, and so the SLA clock and the row it belongs to commit together.
  const ticket = await prisma.$transaction(
    async (tx) => {
      const openedAt = new Date();
      const referenceNumber = await allocateTicketReference(tx, openedAt);
      const { ackDueAt, resolutionDueAt } = slaDeadlinesFor(priority, openedAt);
      return tx.supportTicket.create({
        data: {
          title: input.title,
          description: input.description,
          priority,
          referenceNumber,
          ackDueAt,
          resolutionDueAt,
          category: input.category ?? undefined,
          issueType: input.issueType ?? undefined,
          consultationId: input.consultationId ?? undefined,
          subscriptionId: input.subscriptionId ?? undefined,
          paymentId: input.paymentId ?? undefined,
          organizationId: input.organizationId ?? undefined,
          // A ticket is born from a message (its description) — start the
          // last-activity clock at creation.
          lastMessageAt: openedAt,
          userId: input.userId,
        },
        include: { responses: true, attachments: true },
      });
    },
    // The counter row is a serialization point: concurrent creates queue on it,
    // so this transaction gets the repo's allocation budget rather than the
    // default, exactly as ALLOCATION_TX_* was named for.
    {
      maxWait: ALLOCATION_TX_MAX_WAIT_MS,
      timeout: ALLOCATION_TX_TIMEOUT_MS,
    },
  );
  // The ticket is already committed — a notification failure must not turn a
  // successful create into a 500, or the retrying client files a duplicate.
  await notifySupportStaff(ticket).catch((error) => {
    console.error("support: staff notification failed", {
      ticketId: ticket.id,
      error,
    });
  });
  return ticket;
}

/**
 * Best-effort escalation dedup for the platform intake: a replayed terminal
 * turn (double-click, client retry) reuses the user's still-OPEN ticket for
 * the same flow outcome instead of filing a twin. Runtime check, not a schema
 * unique — the schema is frozen (#705) and the same issue type may legitimately
 * recur once resolved, so the window is bounded. The lookup+create race window
 * is accepted (low volume; worst case one duplicate, same as pre-helper).
 */
export async function findRecentOpenEscalation(
  userId: string,
  issueType: SupportIssueType,
  organizationId: string | null,
): Promise<SupportTicket | null> {
  const dedupeWindow = new Date(Date.now() - 30 * 60_000);
  return prisma.supportTicket.findFirst({
    where: {
      userId,
      issueType,
      // Pass through directly: null must FILTER on organizationId: null (B2C
      // replays dedupe against B2C tickets only), not omit the constraint.
      organizationId,
      status: "OPEN",
      createdAt: { gte: dedupeWindow },
    },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Dedup: a payment-linked ticket reuses any still-open ticket the user already
 * filed for the same payment. Runtime check (not a schema unique) — a payment
 * can legitimately spawn a second ticket once the first is RESOLVED/CLOSED.
 */
export async function findOpenTicketForPayment(
  userId: string,
  paymentId: string,
): Promise<SupportTicket | null> {
  return prisma.supportTicket.findFirst({
    where: {
      paymentId,
      userId,
      status: { notIn: ["RESOLVED", "CLOSED"] },
    },
    include: {
      responses: {
        where: { isInternal: false },
        orderBy: { createdAt: "asc" },
        include: { user: { select: { name: true, role: true } } },
      },
      attachments: { orderBy: { uploadedAt: "desc" } },
    },
  });
}
