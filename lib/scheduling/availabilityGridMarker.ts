import { createHash } from "node:crypto";
import type { Db } from "@/lib/prisma";

/**
 * #1319 PR 9 — the change marker behind the availability grid's conditional GET.
 *
 * ADR 16 settled that slot freshness is polled, not pushed, so every open
 * calendar re-asks `/api/slots/availability-with-allocation/[consultantId]`
 * once a minute and almost always gets back the answer it already has. This
 * module answers "has anything the response depends on changed?" in ONE
 * indexed read, so the unchanged case can be a 304 instead of the 8–18
 * statements the full grid costs (see docs/booking/20-availability-grid-cost.md).
 *
 * Deliberately raw SQL, against the ORM-first rule. The marker is only worth
 * having if it is CHEAPER than what it replaces, and cost here is round trips,
 * not rows: measured against the shared Supabase instance every statement costs
 * ~30 ms of round trip, PG_POOL_MAX=1 serialises them on Netlify, and
 * Promise.all buys nothing (measured, #1117). Expressed through the ORM this is
 * ten aggregates — ten round trips, i.e. slower than the query it is meant to
 * skip. As one statement it is one round trip.
 */

/**
 * Bump when the response SHAPE changes (new field, different bucketing). Every
 * previously issued ETag then misses and the next poll repaints.
 */
const MARKER_VERSION = "av2";

export interface AvailabilityGridMarker {
  /** Null when no such consultant — the caller must fall through to its 404. */
  profileUpdatedAt: Date | null;
  /** Weekly + custom availability rows for this consultant. */
  availabilityUpdatedAt: Date | null;
  /**
   * Weekly + custom row COUNT. A delete of an older row leaves max(updatedAt)
   * unchanged, so without this the grid could 304 on a calendar that lost a
   * window (review of #1334).
   */
  availabilityRowCount: number;
  /**
   * Payments reaching this calendar. A capture that flips PENDING → SUCCEEDED
   * writes the payment row; the slot/request rows usually move too, but this
   * keeps the marker honest when only the payment does.
   */
  paymentsUpdatedAt: Date | null;
  /** Booked slot rows reaching this consultant (and the consultee, if given). */
  slotsUpdatedAt: Date | null;
  /** Parent request rows — status flips that start or stop occupying. */
  requestsUpdatedAt: Date | null;
  /**
   * Earliest still-future PENDING payment deadline among those appointments.
   * The clock fold: when now() passes it the row drops out of the subquery and
   * this value moves to the next hold, so a lapsing hold changes the ETag even
   * though no row was written. Null when nothing is pending.
   */
  nextHoldExpiry: Date | null;
}

/**
 * One statement, one round trip. Every consultant-scoped arm is an index probe
 * (`SlotOfAppointment_consultantProfileId_startsAt_endsAt_idx`,
 * `_SlotOfAppointmentToUser_B_index`, the four `*Plan_consultantProfileId_idx`,
 * `Payment_expiresAt_paymentStatus_idx`).
 *
 * `reach` is the set of appointments that can paint a cell on this calendar:
 * the allocator stamps every slot it writes with BOTH the denormalized
 * consultantProfileId (#440) and a `user` edge to the consultant, and the
 * request arm below rides that set, so a status flip on a booking where the
 * consultant is the CONSULTEE is covered too.
 *
 * `consulteeUserId` is the empty string when absent: an index probe that
 * matches nothing, which keeps this one SQL string rather than two.
 */
export async function readAvailabilityGridMarker(
  db: Db,
  consultantId: string,
  consulteeUserId: string | null,
): Promise<AvailabilityGridMarker | null> {
  const consulteeKey = consulteeUserId ?? "";
  const rows = await db.$queryRaw<AvailabilityGridMarker[]>`
    WITH consultant AS (
      SELECT id, "userId", "updatedAt"
        FROM "ConsultantProfile"
       WHERE id = ${consultantId}
    ),
    reach AS (
      SELECT s."appointmentId" AS id
        FROM "SlotOfAppointment" s
       WHERE s."consultantProfileId" = ${consultantId}
      UNION
      SELECT s."appointmentId"
        FROM "SlotOfAppointment" s
        JOIN "_SlotOfAppointmentToUser" e ON e."A" = s.id
        JOIN consultant c ON c."userId" = e."B"
      UNION
      SELECT s."appointmentId"
        FROM "SlotOfAppointment" s
        JOIN "_SlotOfAppointmentToUser" e ON e."A" = s.id
       WHERE e."B" = ${consulteeKey}
    )
    SELECT
      (SELECT c."updatedAt" FROM consultant c) AS "profileUpdatedAt",
      (SELECT max(t) FROM (
          SELECT max(w."updatedAt") AS t
            FROM "SlotOfAvailabilityWeekly" w
           WHERE w."consultantProfileId" = ${consultantId}
          UNION ALL
          SELECT max(cu."updatedAt")
            FROM "SlotOfAvailabilityCustom" cu
           WHERE cu."consultantProfileId" = ${consultantId}
       ) a) AS "availabilityUpdatedAt",
      (SELECT (SELECT count(*) FROM "SlotOfAvailabilityWeekly" w
                 WHERE w."consultantProfileId" = ${consultantId})
            + (SELECT count(*) FROM "SlotOfAvailabilityCustom" cu
                 WHERE cu."consultantProfileId" = ${consultantId}))::int
        AS "availabilityRowCount",
      (SELECT max(p."updatedAt")
         FROM "Payment" p
         JOIN reach r ON r.id = p."appointmentId") AS "paymentsUpdatedAt",
      (SELECT max(s."updatedAt")
         FROM "SlotOfAppointment" s
         JOIN reach r ON r.id = s."appointmentId") AS "slotsUpdatedAt",
      (SELECT max(t) FROM (
          SELECT max(c."updatedAt") AS t
            FROM "Consultation" c
            JOIN "Appointment" a ON a."consultationId" = c.id
            JOIN reach r ON r.id = a.id
          UNION ALL
          SELECT max(sb."updatedAt")
            FROM "Subscription" sb
            JOIN "Appointment" a ON a."subscriptionId" = sb.id
            JOIN reach r ON r.id = a.id
          UNION ALL
          SELECT max(w."updatedAt")
            FROM "Webinar" w
            JOIN "Appointment" a ON a."webinarId" = w.id
            JOIN reach r ON r.id = a.id
          UNION ALL
          SELECT max(cl."updatedAt")
            FROM "Class" cl
            JOIN "Appointment" a ON a."classId" = cl.id
            JOIN reach r ON r.id = a.id
          UNION ALL
          SELECT max(ts."updatedAt")
            FROM "TrialSession" ts
            JOIN reach r ON r.id = ts."appointmentId"
          UNION ALL
          SELECT max(c."updatedAt")
            FROM "Consultation" c
            JOIN "ConsultationPlan" cp ON cp.id = c."consultationPlanId"
           WHERE cp."consultantProfileId" = ${consultantId}
          UNION ALL
          SELECT max(sb."updatedAt")
            FROM "Subscription" sb
            JOIN "SubscriptionPlan" sp ON sp.id = sb."subscriptionPlanId"
           WHERE sp."consultantProfileId" = ${consultantId}
          UNION ALL
          SELECT max(w."updatedAt")
            FROM "Webinar" w
            JOIN "WebinarPlan" wp ON wp.id = w."webinarPlanId"
           WHERE wp."consultantProfileId" = ${consultantId}
          UNION ALL
          SELECT max(cl."updatedAt")
            FROM "Class" cl
            JOIN "ClassPlan" clp ON clp.id = cl."classPlanId"
           WHERE clp."consultantProfileId" = ${consultantId}
          UNION ALL
          SELECT max(ts."updatedAt")
            FROM "TrialSession" ts
           WHERE ts."consultantProfileId" = ${consultantId}
       ) b) AS "requestsUpdatedAt",
      (SELECT min(p."expiresAt")
         FROM "Payment" p
         JOIN reach r ON r.id = p."appointmentId"
        WHERE p."paymentStatus" = 'PENDING'
          AND p."expiresAt" > now()) AS "nextHoldExpiry"
  `;

  const row = rows[0];
  // A consultant that does not exist has no profile timestamp. Returning null
  // keeps the route's 404 reachable instead of 304ing a body that never was.
  return row?.profileUpdatedAt ? row : null;
}

/** Everything about the REQUEST that changes the body for the same marker. */
export interface AvailabilityGridEtagKey {
  consultantId: string;
  /** Parsed, so `startDate` and `startDateInUtc` hash identically. */
  startIso: string;
  endIso: string;
  timezone: string;
  /** Resolved, not requested — this is what actually shapes the payload. */
  includeAppointmentDetails: boolean;
  consulteeUserId: string | null;
}

/**
 * A strong ETag (no `W/`): the bytes really are identical, not just equivalent.
 * Hashed rather than concatenated so the header stays short and leaks no
 * timestamps about a consultant's booking activity to an anonymous caller —
 * this route is public.
 */
export function availabilityGridEtag(
  marker: AvailabilityGridMarker,
  key: AvailabilityGridEtagKey,
): string {
  const iso = (d: Date | null) => (d ? d.toISOString() : "-");
  const material = [
    MARKER_VERSION,
    key.consultantId,
    key.startIso,
    key.endIso,
    key.timezone,
    key.includeAppointmentDetails ? "d1" : "d0",
    key.consulteeUserId ?? "",
    iso(marker.profileUpdatedAt),
    iso(marker.availabilityUpdatedAt),
    String(marker.availabilityRowCount ?? 0),
    iso(marker.slotsUpdatedAt),
    iso(marker.paymentsUpdatedAt ?? null),
    iso(marker.requestsUpdatedAt),
    iso(marker.nextHoldExpiry),
  ].join(" ");
  return `"${createHash("sha256").update(material).digest("base64url")}"`;
}

/**
 * RFC 9110 §13.1.2 — the header is a comma-separated list, may be `*`, and its
 * entries may be weak. A weak match is enough to skip the body.
 */
export function ifNoneMatchSatisfied(
  header: string | null,
  etag: string,
): boolean {
  if (!header) return false;
  const target = etag.replace(/^W\//, "");
  return header.split(",").some((candidate) => {
    const trimmed = candidate.trim();
    return trimmed === "*" || trimmed.replace(/^W\//, "") === target;
  });
}
