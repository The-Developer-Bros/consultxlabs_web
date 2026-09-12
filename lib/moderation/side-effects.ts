/**
 * Moderation action side-effects (#693) — two-phase execution.
 *
 * Phase 1 (applyTransactionalEffects) runs inside the action route's
 * interactive transaction: user ban flags, session revocation, earnings hold,
 * profile unverification, review soft-delete. All-or-nothing with the
 * ModerationAction row, so a report can never read ACTION_TAKEN while the
 * target's account state didn't move.
 *
 * Phase 2 (applyBestEffortEffects) runs after commit: bulk cancel + refunds
 * (refundPayment owns its own Serializable tx), Stream revocation, Novu.
 * Each step is individually try/caught — one failure never blocks the next —
 * and the outcome lands in ModerationAction.sideEffects for staff visibility.
 */
import * as Sentry from "@sentry/nextjs";
import type {
  ModerationActionType,
  ModerationReportType,
} from "@prisma/client";
import { EarningStatus } from "@prisma/client";
import prisma, { type Tx } from "@/lib/prisma";
import {
  removeCollaboratorStanding,
  type CollaborationRef,
} from "@/lib/collaborators/standing";
import { recomputeConsultantRating } from "@/lib/reviews";
import {
  getStreamChatClient,
  isExpectedStreamError,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { assertEarningStatusTransitionLegal } from "@/lib/payments/payouts/earning-status";
import {
  notifyModerationWarning,
  notifyAccountSuspended,
  notifyAccountBanned,
  notifyVerificationStatusChanged,
} from "@/lib/novu";
import {
  cancelFutureEngagementsForUser,
  type BulkCancelSummary,
} from "./cancel-user-engagements";

export interface ModerationReportRef {
  id: string;
  /** What the report is about. CONTENT_REMOVED acts on the id this type owns
   *  and ignores any other, so a stored cross-type id can never be enforced. */
  type: ModerationReportType;
  targetUserId: string;
  reviewId: string | null;
  /** #1270 — set on MESSAGE reports; what CONTENT_REMOVED deletes on Stream. */
  streamMessageId?: string | null;
  /**
   * #1270 — the channel the message lives in, canonical from Stream. Carried
   * with the id because the two are only useful together, and because the
   * retry sweep was forwarding one without the other.
   */
  streamChannelCid?: string | null;
}

export interface ModerationSideEffectInput {
  actionType: ModerationActionType;
  report: ModerationReportRef;
  staffUserId: string;
  notes?: string;
  /** Required for USER_SUSPENDED. */
  suspensionDays?: number;
}

export interface TransactionalEffectResult {
  sessionsRevoked?: number;
  earningsHeld?: number;
  profilesUnverified?: number;
  reviewRemoved?: boolean;
  /** #705 — whose public surfaces need purging once the transaction commits.
   *  A removed review kept rendering on the landing page for up to an hour
   *  because nothing invalidated the cache. */
  reviewRemovedConsultantProfileId?: string;
  banExpires?: string | null;
  /** #1580 C-P0-4 — the plans whose collaborator row the ban moved to REMOVED;
   *  phase 2 revokes their Stream access. Reinstatement never restores them. */
  collaborationsRemoved?: CollaborationRef[];
}

export type StepStatus = "ok" | "failed" | "skipped" | "gave_up";

export interface SideEffectSummary extends TransactionalEffectResult {
  cancellations?: BulkCancelSummary;
  /**
   * The outcome of this action's Stream write — and, since #1270, the queue the
   * retry sweep drains. One field covers both Stream steps because an action
   * only ever owes one: a ban revokes and deactivates, CONTENT_REMOVED deletes
   * a message. `errors[]` carries the prefix that tells them apart, and
   * `gave_up` is the terminal state the sweep stamps once it stops retrying.
   */
  stream?: StepStatus;
  /** #1270 — how many times the sweep has re-driven a failed Stream step. */
  streamAttempts?: number;
  notification?: StepStatus;
  /** #1580 C-P0-4 — Stream revocation for every plan in `collaborationsRemoved`. */
  collaboratorRevocation?: StepStatus;
  /** #1580 — how many times the sweep has re-driven a failed revocation. */
  collaboratorRevocationAttempts?: number;
  errors?: string[];
}

const HOLDABLE: EarningStatus[] = [
  EarningStatus.PENDING,
  EarningStatus.PENDING_TRUST,
  EarningStatus.READY,
];

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const captureModerationError = (error: unknown) =>
  Sentry.captureException(
    error instanceof Error ? error : new Error(String(error)),
    { tags: { subsystem: "moderation" } },
  );

export async function applyTransactionalEffects(
  tx: Tx,
  input: ModerationSideEffectInput,
): Promise<TransactionalEffectResult> {
  const { actionType, report } = input;

  switch (actionType) {
    case "USER_SUSPENDED":
    case "USER_BANNED":
      return banOrSuspendUser(tx, input);
    case "PROFILE_UNVERIFIED":
      return unverifyProfiles(tx, report.targetUserId);
    case "CONTENT_REMOVED":
      // A reported chat message is removed in phase 2 — the delete is a Stream
      // API call and cannot join this transaction (#1270).
      if (report.type !== "REVIEW") return {};
      return softDeleteReview(tx, report.reviewId);
    case "WARNING_ISSUED":
    case "NO_ACTION":
    case "USER_REINSTATED":
    case "REVIEW_REMOVED":
    case "REVIEW_REPLY_REMOVED":
    case "REVIEW_EXCLUDED_FROM_AGGREGATE":
    case "FEEDBACK_EXCLUDED_FROM_AGGREGATE":
      // A reinstatement is taken through the unban route, and the four #1562 acts
      // are written by their own routes with the audit row; none lands here.
      return {};
  }
}

async function banOrSuspendUser(
  tx: Tx,
  input: ModerationSideEffectInput,
): Promise<TransactionalEffectResult> {
  const { actionType, report, notes, suspensionDays } = input;
  const banExpires =
    actionType === "USER_SUSPENDED"
      ? new Date(Date.now() + (suspensionDays ?? 7) * 86_400_000)
      : null;
  await tx.user.update({
    where: { id: report.targetUserId },
    data: {
      banned: true,
      banReason: notes ?? `moderation: ${actionType}`,
      banExpires,
    },
  });
  const result: TransactionalEffectResult = {
    banExpires: banExpires ? banExpires.toISOString() : null,
  };

  const revoked = await tx.session.deleteMany({
    where: { userId: report.targetUserId },
  });
  result.sessionsRevoked = revoked.count;

  if (actionType === "USER_BANNED") {
    const earningsHeld = await holdBannedConsultantEarnings(
      tx,
      report.targetUserId,
    );
    if (earningsHeld !== undefined) result.earningsHeld = earningsHeld;
  }

  // #1580 C-P0-4 — a moderated account otherwise stays an ACCEPTED collaborator
  // in every split, roster and recording; the flip is shared with erasure.
  const collaborationsRemoved = await removeCollaboratorStanding(
    tx,
    report.targetUserId,
  );
  if (collaborationsRemoved.length > 0) {
    result.collaborationsRemoved = collaborationsRemoved;
  }
  return result;
}

// Hold the banned consultant's unpaid earnings for admin disposition; HELD is
// skipped by the release-earnings cron. PAID/REFUNDED rows are untouchable by
// doctrine — the guard below enforces it per row. Returns undefined when the
// target has no consultant profile (earningsHeld stays unset, as before).
async function holdBannedConsultantEarnings(
  tx: Tx,
  targetUserId: string,
): Promise<number | undefined> {
  const target = await tx.user.findUnique({
    where: { id: targetUserId },
    select: { consultantProfileId: true },
  });
  if (!target?.consultantProfileId) return undefined;

  const holdable = await tx.consultantEarnings.findMany({
    where: {
      consultantProfileId: target.consultantProfileId,
      status: { in: HOLDABLE },
    },
    select: { id: true, status: true },
  });
  for (const row of holdable) {
    assertEarningStatusTransitionLegal(row.id, row.status, EarningStatus.HELD);
  }
  const held = await tx.consultantEarnings.updateMany({
    where: {
      id: { in: holdable.map((r) => r.id) },
      status: { in: HOLDABLE },
    },
    data: { status: EarningStatus.HELD },
  });
  return held.count;
}

async function unverifyProfiles(
  tx: Tx,
  targetUserId: string,
): Promise<TransactionalEffectResult> {
  // Both fields: explore + the booking gate filter on verificationStatus,
  // while isVerified is the projected display flag.
  const updated = await tx.consultantProfile.updateMany({
    where: { userId: targetUserId },
    data: { isVerified: false, verificationStatus: "REJECTED" },
  });
  return { profilesUnverified: updated.count };
}

async function softDeleteReview(
  tx: Tx,
  reviewId: string | null,
): Promise<TransactionalEffectResult> {
  if (!reviewId) return {};
  const review = await tx.consultantReview.findUnique({
    where: { id: reviewId },
    select: { consultantProfileId: true, deletedAt: true, removedBy: true },
  });
  if (!review) return {};
  // Already taken down by moderation: nothing to do. An AUTHOR's withdrawal is
  // not a takedown — it is revivable — so moderation still stamps itself over
  // it, or the author could revive content staff resolved as removed. The actor
  // and reason are the report's ModerationAction row (#1562).
  if (review.deletedAt && review.removedBy === "MODERATION") return {};
  // CAS'd in the WHERE rather than trusting the read above.
  const removed = await tx.consultantReview.updateMany({
    where: { id: reviewId, OR: [{ deletedAt: null }, { removedBy: "AUTHOR" }] },
    data: { deletedAt: new Date(), removedBy: "MODERATION" },
  });
  if (removed.count === 0) return {};
  // #705 — one implementation of the rating rule, never an inlined `_avg`.
  await recomputeConsultantRating(tx, review.consultantProfileId);
  return {
    reviewRemoved: true,
    reviewRemovedConsultantProfileId: review.consultantProfileId,
  };
}

type TriggerOutcome = { success: boolean; error?: Error | string } | null;

export async function applyBestEffortEffects(
  input: ModerationSideEffectInput,
  transactional: TransactionalEffectResult,
): Promise<SideEffectSummary> {
  const { actionType } = input;
  const summary: SideEffectSummary = { ...transactional };
  const errors: string[] = [];

  if (actionType === "USER_SUSPENDED" || actionType === "USER_BANNED") {
    await runBulkCancellations(input, summary, errors);
  }
  if (hasStreamEnforcement(actionType, input.report)) {
    await runStreamStep(input, summary, errors);
  }
  if (transactional.collaborationsRemoved?.length) {
    await runCollaboratorRevocations(
      input.report.targetUserId,
      transactional.collaborationsRemoved,
      summary,
      errors,
    );
  }

  await runNotification(input, transactional, summary, errors);

  if (errors.length > 0) summary.errors = errors;
  return summary;
}

async function runBulkCancellations(
  input: ModerationSideEffectInput,
  summary: SideEffectSummary,
  errors: string[],
): Promise<void> {
  const { report, staffUserId, notes } = input;
  try {
    summary.cancellations = await cancelFutureEngagementsForUser(
      report.targetUserId,
      { initiatedByUserId: staffUserId, notes },
    );
  } catch (error) {
    errors.push(`cancellations: ${errMsg(error)}`);
    captureModerationError(error);
  }
}

// #1580 C-P0-4 — the Stream side of the rows phase 1 moved to REMOVED. The ban
// notification already went out, so the per-plan removal Novu is skipped.
async function runCollaboratorRevocations(
  targetUserId: string,
  plans: CollaborationRef[],
  summary: SideEffectSummary,
  errors: string[],
): Promise<void> {
  const failed: string[] = [];
  // Lazy: a static import would pull the auth + email graph into every action.
  const { revokeCollaboratorAccess } =
    await import("@/lib/collaborators/service");
  for (const { planType, planId } of plans) {
    try {
      const { success } = await revokeCollaboratorAccess(
        planType,
        planId,
        targetUserId,
        { notify: false },
      );
      if (!success) failed.push(`${planType}:${planId}`);
    } catch (error) {
      failed.push(`${planType}:${planId}`);
      captureModerationError(error);
    }
  }
  summary.collaboratorRevocation = failed.length === 0 ? "ok" : "failed";
  if (failed.length > 0) {
    errors.push(`collaborator-revoke: ${failed.join(", ")}`);
  }
}

/**
 * #1270 — does this action owe Stream a write at all?
 *
 * Also the sweep's filter: an action with no Stream step must never be picked
 * up for retry, and a CONTENT_REMOVED on a review has nothing to delete there.
 */
export function hasStreamEnforcement(
  actionType: ModerationActionType,
  report: ModerationReportRef,
): boolean {
  if (actionType === "USER_BANNED" || actionType === "USER_SUSPENDED") {
    return true;
  }
  return (
    actionType === "CONTENT_REMOVED" &&
    report.type === "MESSAGE" &&
    Boolean(report.streamMessageId)
  );
}

/**
 * The single Stream write an action owes, isolated from the bookkeeping around
 * it so the retry sweep re-drives exactly this and nothing else (#1270).
 *
 * Every branch is idempotent, which is what makes a blind retry safe:
 * re-revoking moves a timestamp that is already in the past, re-deactivating an
 * inactive user is a no-op, and a message that is already gone is the outcome
 * we wanted.
 */
export async function applyStreamEnforcement(
  actionType: ModerationActionType,
  report: ModerationReportRef,
): Promise<void> {
  await withStreamCircuitBreaker(async () => {
    const chat = getStreamChatClient();
    if (actionType === "CONTENT_REMOVED") {
      await deleteReportedMessage(chat, report);
      return;
    }
    // revokeUserToken sets revoke_tokens_issued_before = now, which invalidates
    // every token issued BEFORE that instant. A suspension therefore self-heals:
    // once banExpires passes, the token provider mints a fresh token whose `iat`
    // is later than the revoke timestamp, and Stream accepts it.
    //
    // That was only true after #1134 P0-4. Chat tokens used to be minted with no
    // `iat` at all, and Stream treats an iat-less token as INVALID whenever
    // revocation is active — so every future token was rejected too and a 7-day
    // suspension was permanent. lib/stream-client.ts now always sets `iat`.
    await chat.revokeUserToken(report.targetUserId, new Date());
    if (actionType === "USER_BANNED") {
      // Deactivated users cannot connect at all; history is preserved.
      // Permanent by design — USER_BANNED sets banExpires null. Lifting one
      // is an explicit act and must call restoreStreamAccess below.
      await chat.deactivateUser(report.targetUserId, {
        mark_messages_deleted: false,
      });
    }
  });
}

async function deleteReportedMessage(
  chat: ReturnType<typeof getStreamChatClient>,
  report: ModerationReportRef,
): Promise<void> {
  if (!report.streamMessageId) return;
  try {
    // Soft delete: Stream keeps the row and stops serving the text, so the
    // evidence survives an appeal while the channel stops showing the abuse.
    // A hard delete would destroy the only copy of what was moderated.
    await chat.deleteMessage(report.streamMessageId);
  } catch (error) {
    // A message Stream cannot find is already gone — the state this step
    // exists to reach — and that is the normal answer when the sweep re-drives
    // a step that actually succeeded, or when the author deleted it first.
    // Stream answers with the 404/code-16 shape isExpectedStreamError already
    // recognises as "Stream is up and said no such thing"; an outage never
    // looks like this, so nothing real is being swallowed.
    if (isExpectedStreamError(error)) return;
    throw error;
  }
}

async function runStreamStep(
  input: ModerationSideEffectInput,
  summary: SideEffectSummary,
  errors: string[],
): Promise<void> {
  const { actionType, report } = input;
  try {
    await applyStreamEnforcement(actionType, report);
    summary.stream = "ok";
  } catch (error) {
    summary.stream = "failed";
    summary.streamAttempts = 1;
    errors.push(`${streamErrorPrefix(actionType)}: ${errMsg(error)}`);
    captureModerationError(error);
  }
}

/** Which Stream step failed — the two are indistinguishable from `stream` alone. */
export function streamErrorPrefix(actionType: ModerationActionType): string {
  return actionType === "CONTENT_REMOVED" ? "message-delete" : "stream";
}

/**
 * Best-effort persistence of the side-effect summary, which is what staff read
 * and what the retry sweep drains. A failure here is captured but never
 * surfaced to the caller: the enforcement itself already happened, and failing
 * the request would invite a retry that the 409 idempotency guard would refuse.
 */
export async function persistActionSideEffects(
  actionId: string,
  sideEffects: SideEffectSummary,
): Promise<void> {
  const write = () =>
    prisma.moderationAction.update({
      where: { id: actionId },
      // NOT structuredClone (Sonar S7784): this is a SERIALIZATION, not a
      // deep clone. `SideEffectSummary` has five optional fields, and Prisma's
      // InputJsonValue rejects `undefined` in an object — the JSON round-trip
      // strips those keys, structuredClone would preserve them.
      data: { sideEffects: JSON.parse(JSON.stringify(sideEffects)) },
    });

  try {
    await write();
  } catch (first) {
    // #1270 review — this row IS the outbox. `retry-moderation-enforcement`
    // selects on `sideEffects.stream === "failed"`, so losing this write does
    // not merely lose a status field: it loses the queue entry, and a ban that
    // never reached Stream is then never retried and never surfaced. Swallowing
    // it, as this used to, made the one durable record of an unlanded
    // enforcement the most disposable thing in the flow.
    captureModerationError(first);
    try {
      await write();
    } catch (second) {
      // Both attempts gone. Nothing downstream can recover this, so it is
      // raised at a level a human sees rather than logged and forgotten.
      Sentry.captureException(
        second instanceof Error ? second : new Error(String(second)),
        {
          level: "fatal",
          tags: { subsystem: "moderation", op: "persistActionSideEffects" },
          extra: { actionId, streamOutcome: sideEffects.stream ?? null },
        },
      );
    }
  }
}

async function runNotification(
  input: ModerationSideEffectInput,
  transactional: TransactionalEffectResult,
  summary: SideEffectSummary,
  errors: string[],
): Promise<void> {
  try {
    // The Novu wrappers are non-throwing (TriggerResult) — read the success
    // flag; the catch only covers unexpected throws.
    const trigger = await triggerModerationNotification(
      input,
      transactional,
      summary,
    );
    if (trigger === null) {
      summary.notification = "skipped";
    } else if (trigger.success) {
      summary.notification = "ok";
    } else {
      summary.notification = "failed";
      errors.push(`notification: ${errMsg(trigger.error ?? "trigger failed")}`);
    }
  } catch (error) {
    summary.notification = "failed";
    errors.push(`notification: ${errMsg(error)}`);
    captureModerationError(error);
  }
}

function triggerModerationNotification(
  input: ModerationSideEffectInput,
  transactional: TransactionalEffectResult,
  summary: SideEffectSummary,
): Promise<TriggerOutcome> {
  const { actionType, report, notes } = input;
  switch (actionType) {
    case "WARNING_ISSUED":
    case "CONTENT_REMOVED":
      return notifyModerationWarning(report.targetUserId, { reason: notes });
    case "USER_SUSPENDED":
      return notifyAccountSuspended(report.targetUserId, {
        reason: notes,
        suspendedUntil: transactional.banExpires ?? "",
        appointmentsCancelled: summary.cancellations?.engagementsCancelled,
      });
    case "USER_BANNED":
      return notifyAccountBanned(report.targetUserId, {
        reason: notes,
        appointmentsCancelled: summary.cancellations?.engagementsCancelled,
      });
    case "PROFILE_UNVERIFIED":
      return notifyVerificationStatusChanged(report.targetUserId, {
        status: "REJECTED",
        reason: notes,
        dashboardUrl: "/dashboard",
      });
    case "NO_ACTION":
    case "USER_REINSTATED":
    case "REVIEW_REMOVED":
    case "REVIEW_REPLY_REMOVED":
    case "REVIEW_EXCLUDED_FROM_AGGREGATE":
    case "FEEDBACK_EXCLUDED_FROM_AGGREGATE":
      // No Novu workflow exists for a reinstatement, and inventing a
      // log-and-skip trigger would report "skipped" for one nobody plans to
      // build. The #1562 acts are never taken through a report.
      return Promise.resolve(null);
  }
}

/**
 * #1134 P0-4 — the inverse of runStreamRevocation, for when a ban is lifted.
 *
 * A USER_BANNED action calls `deactivateUser`, which is permanent: a deactivated
 * user cannot connect to Stream at all, and nothing in this codebase ever undid
 * it. That is correct while the ban stands, but if an operator lifts a permanent
 * ban the account is left unable to chat with no visible cause.
 *
 * `revokeUserToken(id, null)` is belt-and-braces. Tokens now carry `iat`, so a
 * freshly-minted one already post-dates the revoke timestamp and would be
 * accepted regardless — clearing the flag just removes a trap for anyone who
 * later reintroduces an iat-less token.
 *
 * Idempotent: reactivating a live user and clearing an unset revocation are both
 * no-ops on Stream's side. Callers should invoke this from whatever unban path
 * they build; there is no automated one today because USER_SUSPENDED expires
 * lazily at sign-in without ever deactivating.
 */
/**
 * Is this the benign "that user was never deactivated" response?
 *
 * Stream documents neither outcome for `reactivateUser` on an active user — not
 * that it errors, not that it is a no-op — so this matches narrowly and lets
 * everything else through. The asymmetry is deliberate: swallowing the
 * already-active case costs nothing, because the account is already in the state
 * we wanted. Swallowing a timeout, a 429 or a 5xx would report a successful
 * restore for an account that is still deactivated and still unable to chat,
 * which is precisely how P0-4 stayed invisible for months.
 *
 * Stream's `ErrorFromResponse` carries `status`; a network or timeout failure
 * carries none, so it falls through to the rethrow.
 */
function isAlreadyActiveResponse(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status !== "number" || status < 400 || status >= 500) return false;
  return /not deactivated|already active/i.test(errMsg(error));
}

export async function restoreStreamAccess(userId: string): Promise<void> {
  await withStreamCircuitBreaker(async () => {
    const chat = getStreamChatClient();
    await chat.revokeUserToken(userId, null);
    try {
      await chat.reactivateUser(userId);
    } catch (error) {
      // A lifted SUSPENSION only ever revoked tokens, never deactivated, so
      // "was not deactivated" is the normal shape there and is a SUCCESS — the
      // un-revoke above is the part that mattered for that case. Reporting it
      // would page on the healthy path, which is how a real signal gets tuned
      // out. Every other failure means the account is still locked out of chat,
      // so it is both reported and propagated.
      if (isAlreadyActiveResponse(error)) return;
      captureModerationError(error);
      throw error;
    }
  });
}
