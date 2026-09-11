/**
 * #1356 — the post-payment chat leg, as a re-drivable step.
 *
 * Creating the buyer's Stream channel is the last thing a successful capture
 * does, and it happens after the confirmation transaction has committed:
 * `handlePaymentSuccess` fires it and does not wait, because it is outbound
 * network work that must not sit inside a Serializable transaction or inside a
 * request under Netlify's function ceiling. The consequence was that a crash, a
 * cold-start kill or a Stream outage in that window left a confirmed, paid
 * booking with no conversation, and nothing anywhere recorded that the step had
 * been skipped — the failure was a Sentry event and nothing more.
 *
 * The fix is state-as-outbox rather than an outbox table: the appointment row
 * already is the durable record of the work, so it carries the completion stamp
 * too. `Appointment.chatChannelEnsuredAt` is written only once the channel calls
 * have actually returned, which makes "confirmed, paid, and still NULL" an exact
 * query for the work that was lost. The reconcile sweep runs that query and
 * calls straight back into this function. See ADR 27.
 *
 * Everything here is idempotent — `createDirectMessageChannel` and
 * `addUserToEventChannel` both upsert — so the live path and the sweep can race
 * each other without consequence.
 *
 * A row that fails is deliberately left in the queue rather than marked
 * terminal, because every reason it can fail for is repairable — a missing
 * consultant, an appointment relation that is still NULL, a Stream outage — and
 * writing a terminal marker would abandon a row that a later data repair would
 * have made succeed. The sweep's seven-day window is what bounds the cost of
 * retrying it. #1391
 *
 * The stamp is per APPOINTMENT, and for a `WEBINAR` or `CLASS` — the two types
 * many buyers share — that is not the same grain as the work. Once the sixth
 * buyer's capture stamps the row, a seventh buyer whose `addUserToEventChannel`
 * throws is no longer in the sweep's queue, because that queue selects on the
 * stamp being NULL. What catches them is `syncUserEventChannels` on their next
 * dashboard load: unlike the DM case in #1134 P1-15, the `Webinar`/`Class` row
 * plainly exists, so the sync can derive their membership from it and add them.
 * So the sweep is the durable re-drive for the first buyer of any appointment
 * and for every buyer of the 1:1 types, and the dashboard sync is the net for a
 * later event buyer. Making the sweep cover that case too means moving the
 * marker to the buyer grain; see the #1391 review thread.
 */
import prisma from "@/lib/prisma";
import { addUserToEventChannel } from "@/actions/stream/chat/event-channel.action";
import { createDirectMessageChannel } from "@/actions/stream/chat/channel.action";
import { streamLogger } from "@/lib/stream-logger";
import { bookingOrgId } from "@/lib/stream-utils";

export interface EnsureChannelsResult {
  /** True when every buyer's channel exists and the appointment is stamped. */
  ensured: boolean;
  /** Why nothing was ensured. Present only when `ensured` is false. */
  reason?: string;
}

/**
 * Make sure every paid-up participant of an appointment has the chat channel
 * their purchase entitles them to, then stamp the appointment.
 *
 * Loads everything it needs from the appointment id alone, so it is callable
 * both from the capture pipeline (which has the metadata in hand) and from the
 * reconcile sweep (which has only a row).
 */
export async function ensureChannelsForAppointment(
  appointmentId: string,
): Promise<EnsureChannelsResult> {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    // #1446 — a `select`, not a six-relation `include`. This read runs in
    // `after()` against the instance's only connection (PG_POOL_MAX=1) with an
    // inbound request queued behind it, and the step uses nothing but ids, org
    // ids and the consultant's `userId` — the whole plan and profile rows were
    // being dragged over the wire for a field each.
    select: {
      id: true,
      appointmentType: true,
      // Read by `bookingOrgId` below as the appointment-level fallback.
      organizationId: true,
      // The buyers, not "the buyer": a webinar or class appointment is shared
      // by everyone who registered for it, so the seat that needs a channel is
      // whichever one is missing. Only SUCCEEDED payments count — a tentative
      // hold has not bought anything yet.
      payment: {
        where: { paymentStatus: "SUCCEEDED", deletedAt: null },
        select: { userId: true },
        orderBy: { createdAt: "asc" },
      },
      consultation: {
        select: {
          id: true,
          consultationPlan: {
            select: {
              organizationId: true,
              consultantProfile: { select: { userId: true } },
            },
          },
        },
      },
      subscription: {
        select: {
          id: true,
          subscriptionPlan: {
            select: {
              organizationId: true,
              consultantProfile: { select: { userId: true } },
            },
          },
          // The org-tagged sibling, not the appointment being paid for.
          // `appointment` is one appointment of many under a subscription and
          // may be the personal one, while createSubscriptionChannel resolves
          // the first ORG-tagged row — so without this the creator mints
          // `dmo-…` and this path looks for `dm-…`. Filtered in the query
          // because `take: 1` truncates server-side, before bookingOrgId's
          // `find` can choose.
          appointments: {
            where: { organizationId: { not: null } },
            select: { organizationId: true },
            // Deterministic, not just filtered: `take: 1` over an unordered
            // result can hand different callers different rows if a
            // subscription ever carries two org-tagged appointments, which is
            // the same divergence one layer down.
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: 1,
          },
        },
      },
      webinar: {
        select: {
          id: true,
          webinarPlan: {
            select: { consultantProfile: { select: { userId: true } } },
          },
        },
      },
      class: {
        select: {
          id: true,
          classPlan: {
            select: { consultantProfile: { select: { userId: true } } },
          },
        },
      },
      // A trial appointment has none of the four relations above — the
      // consultant hangs off TrialSession directly. Without this the
      // resolution below yields undefined, the guard fails, and the TRIAL
      // branch never executes for the only appointments that can reach it.
      trialSession: {
        select: { consultantProfile: { select: { userId: true } } },
      },
    },
  });

  if (!appointment) {
    return { ensured: false, reason: "appointment_not_found" };
  }

  const consultantProfile =
    appointment.consultation?.consultationPlan?.consultantProfile ||
    appointment.subscription?.subscriptionPlan?.consultantProfile ||
    appointment.webinar?.webinarPlan?.consultantProfile ||
    appointment.class?.classPlan?.consultantProfile ||
    // `TrialSession.consultantProfile` is the required, authoritative
    // relation — not `trialSession.subscriptionPlan.consultantProfile`,
    // which is the plan author and can differ.
    appointment.trialSession?.consultantProfile;

  const consultantUserId = consultantProfile?.userId;
  if (!consultantUserId) {
    return { ensured: false, reason: "consultant_not_resolved" };
  }

  const buyerIds = appointment.payment.map((p) => p.userId);
  if (buyerIds.length === 0) {
    return { ensured: false, reason: "no_succeeded_payment" };
  }

  const eventType = appointment.appointmentType;
  const consultation = appointment.consultation;
  const subscription = appointment.subscription;
  const webinar = appointment.webinar;
  const classEvent = appointment.class;

  // #1134 P0-8 — the org MUST be threaded through. getDmPairsForUser
  // recomputes the expected id with plan-org-then-appointment-org precedence,
  // so a DM minted without it landed on the personal `dm-` key, failed to match
  // the expected `dmo-` one, and — because `dm-` is a managed prefix — was then
  // treated as stale and the user removed from the only conversation they had.
  // Shared with every other site that derives this key, so the two can no
  // longer drift.
  const dmOrgId = bookingOrgId({
    consultationPlan: consultation?.consultationPlan,
    subscriptionPlan: subscription?.subscriptionPlan,
    appointments: subscription?.appointments,
    appointment,
  });

  for (const userId of buyerIds) {
    // #1134 P0-7 — `consultation-<id>` / `subscription-<id>` channels are NOT
    // created any more. syncUserEventChannels only ever expected webinars,
    // classes and DMs, while treating both prefixes as managed, so every one of
    // these was deleted on the buyer's next dashboard load. The pair already
    // gets a DM, and createConsultationChannel minted a DM rather than a
    // `consultation-` channel anyway — the concept never cohered. One thread
    // per relationship-context is the whole model now.
    if (
      (eventType === "CONSULTATION" && consultation) ||
      (eventType === "SUBSCRIPTION" && subscription) ||
      // #1134 P1-16 — TRIAL had no branch here at all, so a trial buyer got
      // video and no way to message the consultant before or after it. A trial
      // is the platform's first impression; it is the LAST session type that
      // should be mute. Same DM as any other 1:1, so it merges with their
      // thread if they go on to book.
      eventType === "TRIAL"
    ) {
      await createDirectMessageChannel(consultantUserId, userId, dmOrgId);
    } else if (eventType === "WEBINAR" && webinar) {
      await addUserToEventChannel("webinar", webinar.id, userId);
    } else if (eventType === "CLASS" && classEvent) {
      await addUserToEventChannel("class", classEvent.id, userId);
    } else {
      return { ensured: false, reason: "no_channel_branch_for_appointment" };
    }
  }

  // Stamp only after the calls succeeded — a throw above leaves the column NULL
  // and the appointment stays in the sweep's work queue, which is the whole
  // point. `updateMany` scoped to the NULL makes the stamp itself idempotent,
  // so a later buyer's capture does not rewrite the first buyer's timestamp and
  // two racing drivers cannot fight over it.
  await prisma.appointment.updateMany({
    where: { id: appointmentId, chatChannelEnsuredAt: null },
    data: { chatChannelEnsuredAt: new Date() },
  });

  streamLogger.info("Stream channels ensured for appointment", {
    appointmentType: eventType,
    appointmentId,
    buyers: buyerIds.length,
  });

  return { ensured: true };
}
