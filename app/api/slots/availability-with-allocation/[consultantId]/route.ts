import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import {
  AppointmentSlot,
  CustomSlot,
  dayMap,
  isValidOvernightSlot,
  makeLocalizer,
  processAvailabilitySlots,
  WeeklySlot,
} from "@/utils/timeSlotsProcessing";
import { NextRequest, NextResponse } from "next/server";
import {
  buildConsultantOccupancyWhere,
  buildOccupiedAppointmentFilter,
} from "@/utils/slotAllocation/occupancyPolicy";
import { isOccupiedByLiveAppointment } from "@/utils/slotAllocation/SlotValidationService";
import { getSession } from "@/lib/auth-server";
import {
  buildOverlapMetaIndex,
  overlapMetaCandidatesFor,
  type OverlapAppointmentMeta,
  type AppointmentForOverlapMeta,
} from "@/lib/booking/overlap-meta";
import { isPrivileged } from "@/lib/auth-helpers";
import {
  availabilityGridEtag,
  ifNoneMatchSatisfied,
  readAvailabilityGridMarker,
} from "@/lib/scheduling/availabilityGridMarker";
import type { TSlotTiming } from "@/types/slots";
import type { BookingStatus } from "@/utils/timeSlotsProcessing";

type SlotTimingWithOverlap = TSlotTiming & {
  isAllocated: boolean;
  bookingStatus: BookingStatus;
  overlappingAppointments?: OverlapAppointmentMeta[];
};

// #1164 — browser-only cache for the polling grid. `private`, not the sibling's
// `public, s-maxage`: the same URL answers differently by session (the
// includeAppointmentDetails/consulteeUserId gates below), so a shared cache
// would cross identities. Bounded staleness is safe — allocation re-validates
// server-side — and the one caller that must never see it, the post-allocation
// refetch, asks for `cache: "no-store"` (AllocationService, #1164).
// No SWR: the 60s poll and return-tick must repaint fresh, not one-interval-old.
const GRID_CACHE_CONTROL = "private, max-age=30";

// An org OWNER/MAINTAINER acting for a member consultant (RequestSlotAllocationTab
// mounts mode="allocate" for org admins allocating on a consultant's behalf)
// is authorized the same as the owning consultant. isPrivileged only covers
// PLATFORM staff, so without this an org admin 403s and loses the whole
// calendar rather than just the tooltip detail. EXPERT/other org roles are
// deliberately excluded — same Membership shape requireOrgAccess/catalog
// route use elsewhere (consultantProfileId + role: "EXPERT" identifies the
// org the consultant belongs to; isAtLeastRole's MAINTAINER floor is the
// "admin" rank used throughout app/api/organizations/**).
async function isOrgAdminOfConsultant(
  userId: string,
  consultantId: string,
): Promise<boolean> {
  const membership = await prisma.membership.findFirst({
    where: {
      userId,
      status: "ACTIVE",
      role: { in: ["OWNER", "MAINTAINER"] },
      organization: {
        memberships: {
          some: {
            consultantProfileId: consultantId,
            role: "EXPERT",
            status: "ACTIVE",
          },
        },
      },
    },
    select: { id: true },
  });
  return !!membership;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ consultantId: string }> },
) {
  try {
    const { consultantId } = await params;
    const { searchParams } = new URL(req.url);

    // Support both old and new parameter names for backward compatibility
    const startDateInUtc =
      searchParams.get("startDateInUtc") || searchParams.get("startDate");
    const endDateInUtc =
      searchParams.get("endDateInUtc") || searchParams.get("endDate");
    const timezone = searchParams.get("timezone") || "UTC";

    // #997 Phase 2 — explicit opt-in for the consultant Allocate-Slots
    // calendar's per-interval tooltip metadata (title/participant name).
    // This route is otherwise PUBLIC (consultee/trials browsing, see
    // middleware.ts) so the richer include is gated behind BOTH the flag
    // AND session ownership — a consultee's request never satisfies the
    // ownership check, so their response is byte-identical to before.
    const includeAppointmentDetailsRequested =
      searchParams.get("includeAppointmentDetails") === "true";
    const requestedConsulteeUserId = searchParams.get("consulteeUserId");

    // Both gates below need the caller's identity, and this route is re-hit on
    // every week-slide — so resolve it ONCE rather than awaiting getSession in
    // each gate. Still skipped entirely on the public path, where neither
    // parameter is present and the route stays anonymous.
    const session =
      includeAppointmentDetailsRequested || requestedConsulteeUserId
        ? await getSession(true)
        : null;
    // Ownership is a fact about the database, not about the session.
    //
    // The session field is a snapshot from when the session was minted, so a
    // consultant whose profile link changed since then fails this check while
    // requirePersonalProfileAccess — which re-reads the user — lets them onto
    // the page. The result was a page that rendered and then 403'd its own
    // calendar. Session first because it is free and almost always right; the
    // read only happens when it disagrees.
    const isOwningConsultant =
      !!session?.user?.id &&
      (session.user.consultantProfileId === consultantId ||
        (await prisma.consultantProfile.count({
          where: { id: consultantId, userId: session.user.id },
        })) > 0);

    // Resolved lazily and once: BOTH gates below need it, and the second used
    // not to know about it at all — an org admin cleared the details gate and
    // was then refused by the consultee gate with "cannot read another user's
    // calendar", which made Allocate Slots unusable for them.
    let orgAdminCheck: Promise<boolean> | null = null;
    const isOrgAdmin = () => {
      if (!session?.user?.id) return Promise.resolve(false);
      orgAdminCheck ??= isOrgAdminOfConsultant(session.user.id, consultantId);
      return orgAdminCheck;
    };

    let includeAppointmentDetails = false;
    if (includeAppointmentDetailsRequested) {
      // Three outcomes, not two.
      //
      // The detail payload carries plan titles and participant names. The
      // consultant may see their own; platform staff may see anyone's. An org
      // admin allocating for a member consultant needs the CALENDAR — which
      // cells are taken — but not what each block is: the consultant's personal
      // bookings with unrelated consultees are content, and ADR 20 gives an org
      // metadata, not content.
      //
      // So they are neither authorized nor refused. They get the same
      // busy/free grid a buyer gets, and the allocate surface works. 403ing
      // them cost the whole calendar over a tooltip they must not see anyway.
      const maySeeDetails =
        !!session?.user?.id &&
        (isOwningConsultant || isPrivileged(session.user.role));
      const maySeeCalendar = maySeeDetails || (await isOrgAdmin());

      if (!maySeeCalendar) {
        return NextResponse.json(
          {
            error:
              "Forbidden: appointment details require consultant ownership",
          },
          { status: 403 },
        );
      }
      includeAppointmentDetails = maySeeDetails;
    }

    // The allocator treats the CONSULTEE's bookings with ANY consultant as
    // occupied, so a grid that only knows the consultant paints cells green
    // that then fail validateNoConflicts. Callers who know whose calendar is
    // being booked pass it here.
    //
    // Gated because this route is otherwise PUBLIC: an ungated parameter would
    // be a busy/free oracle for any user id. You may ask about yourself, or the
    // consultant (and staff) may ask about a consultee booking with them.
    let consulteeUserId: string | null = null;
    if (requestedConsulteeUserId) {
      // The org-admin arm belongs here too. This parameter only marks cells
      // BUSY — it carries no titles or names — so it is metadata, which ADR 20
      // does allow an org to see, and allocation is wrong without it: the grid
      // would paint cells green that validation then rejects.
      const isSelf = session?.user?.id === requestedConsulteeUserId;
      if (
        !isSelf &&
        !isOwningConsultant &&
        !isPrivileged(session?.user?.role) &&
        !(await isOrgAdmin())
      ) {
        return NextResponse.json(
          { error: "Forbidden: cannot read another user's calendar" },
          { status: 403 },
        );
      }
      consulteeUserId = requestedConsulteeUserId;
    }

    if (!startDateInUtc || !endDateInUtc) {
      return NextResponse.json(
        { error: "startDateInUtc and endDateInUtc are required" },
        { status: 400 },
      );
    }

    // Validate dates
    let startDate: Date, endDate: Date;
    try {
      startDate = new Date(startDateInUtc);
      endDate = new Date(endDateInUtc);
      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        throw new Error("Invalid date format");
      }
    } catch (_error) {
      return NextResponse.json(
        { error: "Dates must be in UTC ISO format" },
        { status: 400 },
      );
    }

    // #1319 PR 9 — conditional GET, computed BEFORE the heavy reads.
    //
    // Every open calendar re-asks this endpoint once a minute (ADR 16: polling,
    // not Realtime) and the answer is almost always the one it already has. One
    // indexed marker read decides that in a single statement, against the 8
    // statements the public grid costs and the 18 the detail grid costs (#997,
    // docs/booking/20-availability-grid-cost.md).
    //
    // Placed after the authorization gates on purpose: a caller who has since
    // lost access is refused up there, so a 304 can never serve stale
    // permission. The resolved (not requested) detail flag and the consultee id
    // are hashed into the tag, so the two payload shapes cannot collide.
    const marker = await readAvailabilityGridMarker(
      prisma,
      consultantId,
      consulteeUserId,
    );
    // No marker = no such consultant; fall through so the 404 below still answers.
    const etag = marker
      ? availabilityGridEtag(marker, {
          consultantId,
          startIso: startDate.toISOString(),
          endIso: endDate.toISOString(),
          timezone,
          includeAppointmentDetails,
          consulteeUserId,
        })
      : null;
    if (etag && ifNoneMatchSatisfied(req.headers.get("if-none-match"), etag)) {
      return new NextResponse(null, {
        status: 304,
        headers: { "Cache-Control": GRID_CACHE_CONTROL, ETag: etag },
      });
    }

    // 1. Fetch consultant's availability
    const consultant = await prisma.consultantProfile.findUnique({
      where: { id: consultantId },
      include: {
        slotsOfAvailabilityWeekly: true,
        slotsOfAvailabilityCustom: {
          where: {
            // Use comprehensive overlap check for custom slots to match appointment logic
            OR: [
              {
                startsAt: {
                  gte: startDate,
                  lt: endDate,
                },
              },
              {
                endsAt: {
                  gt: startDate,
                  lte: endDate,
                },
              },
              {
                startsAt: { lte: startDate },
                endsAt: { gte: endDate },
              },
            ],
          },
        },
      },
    });

    if (!consultant) {
      return NextResponse.json(
        { error: "Consultant not found" },
        { status: 404 },
      );
    }

    // 2. Fetch all appointments to find allocated slots.
    //
    // The grid must answer occupancy the same way the allocator does, or it
    // paints cells green that every allocation mode then rejects. Both now
    // share buildConsultantOccupancyWhere.
    const slotsInWindow = {
      slotsOfAppointment: {
        some: {
          // A tombstoned slot is not a booking — never paint it busy.
          // (No completionStatus filter: RESCHEDULED rows are a pending
          // reschedule's live hold and must still occupy the grid.)
          deletedAt: null,
          OR: [
            {
              startsAt: {
                gte: startDate,
                lt: endDate,
              },
            },
            {
              endsAt: {
                gt: startDate,
                lte: endDate,
              },
            },
            {
              startsAt: { lte: startDate },
              endsAt: { gte: endDate },
            },
          ],
        },
      },
    };

    const occupiedAppointmentWhere = {
      AND: [
        buildConsultantOccupancyWhere(consultantId, consultant.userId),
        slotsInWindow,
      ],
    };

    // The parent's status and payment window decide whether a hold is still
    // live; without them isOccupiedByLiveAppointment cannot drop an expired
    // APPROVED_PENDING_PAYMENT and the grid blanks out genuinely free time.
    const LIVE_OCCUPANCY_SELECT = {
      consultation: { select: { status: true, bookingSource: true } },
      subscription: { select: { status: true, bookingSource: true } },
      payment: { select: { expiresAt: true, paymentStatus: true } },
    } as const;

    // #997 Phase 2 — two separate queries (rather than one conditionally-built
    // `include`) so the PUBLIC path (majority of traffic — consultee/trials
    // browsing) never pays for the extra plan-title/participant-name joins.
    let rawSlotsOfAppointment: { id: string; startsAt: Date; endsAt: Date }[];
    let overlapMetaIndex: Map<number, OverlapAppointmentMeta[]> = new Map();
    let detailAppointments: AppointmentForOverlapMeta[] = [];
    const occupancyNow = new Date();

    // The consultee's own bookings — with ANY consultant — folded in below so
    // the grid and the allocator agree on what is free for BOTH parties.
    //
    // Deliberately a SECOND query rather than a third arm of the consultant's
    // OR: the detail branch attaches plan titles and participant names, and a
    // consultee's booking with a *different* consultant must read as busy and
    // nothing more (ADR 20). Merged, those rows would inherit that metadata.
    // A PrismaPromise does not execute until awaited, so it is handed to the
    // Promise.all below to run alongside the consultant query rather than
    // after it — separate query, same round-trip.
    const consulteeOccupancy = consulteeUserId
      ? prisma.appointment.findMany({
          where: {
            AND: [
              { OR: buildOccupiedAppointmentFilter() },
              {
                slotsOfAppointment: {
                  some: { user: { some: { id: consulteeUserId } } },
                },
              },
              slotsInWindow,
            ],
          },
          include: {
            // Same tombstone exclusion as the consultant branches — the merge
            // below flatMaps these children into the painted grid, so an
            // unfiltered include would reintroduce deleted rows through the
            // one arm the first pass missed (CodeRabbit triage).
            slotsOfAppointment: { where: { deletedAt: null } },
            ...LIVE_OCCUPANCY_SELECT,
          },
        })
      : Promise.resolve([]);

    if (includeAppointmentDetails) {
      const [fetched] = await Promise.all([
        prisma.appointment.findMany({
          where: occupiedAppointmentWhere,
          include: {
            // Tombstone exclusion rides the include (not just the window
            // filter): a deleted slot of a qualifying appointment must not
            // paint busy. Deliberately NOT window-bounded — a booking that
            // started last week overlapping an in-window cell must still
            // paint that cell, so out-of-window children are load-bearing.
            slotsOfAppointment: { where: { deletedAt: null } },
            consultation: {
              select: {
                status: true,
                bookingSource: true,
                consultationPlan: { select: { title: true } },
                requestedBy: { select: { user: { select: { name: true } } } },
              },
            },
            subscription: {
              select: {
                status: true,
                bookingSource: true,
                subscriptionPlan: { select: { title: true } },
                requestedBy: { select: { user: { select: { name: true } } } },
              },
            },
            webinar: { select: { webinarPlan: { select: { title: true } } } },
            class: { select: { classPlan: { select: { title: true } } } },
            payment: { select: { expiresAt: true, paymentStatus: true } },
          },
        }),
        consulteeOccupancy,
      ]);
      detailAppointments = fetched.filter((appt) =>
        isOccupiedByLiveAppointment(appt, occupancyNow),
      );
      rawSlotsOfAppointment = detailAppointments.flatMap(
        (appt) => appt.slotsOfAppointment,
      );
      overlapMetaIndex = buildOverlapMetaIndex(detailAppointments);
    } else {
      const [appointments] = await Promise.all([
        prisma.appointment.findMany({
          where: occupiedAppointmentWhere,
          // Same tombstone exclusion as the detail branch above.
          include: {
            slotsOfAppointment: { where: { deletedAt: null } },
            ...LIVE_OCCUPANCY_SELECT,
          },
        }),
        consulteeOccupancy,
      ]);
      rawSlotsOfAppointment = appointments
        .filter((appt) => isOccupiedByLiveAppointment(appt, occupancyNow))
        .flatMap((appt) => appt.slotsOfAppointment);
    }

    // No overlap metadata is attached to these: the consultant may see that the
    // time is taken, not what it is taken by (ADR 20). Already resolved by the
    // Promise.all above — this await does not add a round-trip.
    if (consulteeUserId) {
      const consulteeAppointments = await consulteeOccupancy;

      const seen = new Set(rawSlotsOfAppointment.map((s) => s.id));
      for (const appt of consulteeAppointments) {
        if (!isOccupiedByLiveAppointment(appt, occupancyNow)) continue;
        for (const slot of appt.slotsOfAppointment) {
          if (!seen.has(slot.id)) {
            seen.add(slot.id);
            rawSlotsOfAppointment.push(slot);
          }
        }
      }
    }

    // Extract appointment slots using flatMap with defensive filtering
    // Defensive Programming: Filter out corrupt appointment slots
    const appointmentSlots: AppointmentSlot[] = rawSlotsOfAppointment
      .filter((slot) => {
        // Validate slot has required fields
        if (!slot.startsAt || !slot.endsAt) {
          console.warn(
            `⚠️ Skipping appointment slot ${slot.id}: missing start or end time`,
          );
          return false;
        }

        // Validate slot times are valid dates
        const start = new Date(slot.startsAt);
        const end = new Date(slot.endsAt);
        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
          console.warn(
            `⚠️ Skipping appointment slot ${slot.id}: invalid date format`,
          );
          return false;
        }

        // Filter out invalid appointment slots (allow legitimate overnight slots)
        if (!isValidOvernightSlot(start, end)) {
          console.warn(
            `⚠️ Skipping appointment slot ${slot.id}: end time ${end.toISOString()} <= start time ${start.toISOString()} (not a valid overnight slot)`,
          );
          return false;
        }

        // Defensive: Filter out slots that are unreasonably far in the past (>10 years)
        // This likely indicates data corruption
        const tenYearsAgo = new Date();
        tenYearsAgo.setFullYear(tenYearsAgo.getFullYear() - 10);
        if (end < tenYearsAgo) {
          console.warn(
            `⚠️ Skipping appointment slot ${slot.id}: end time is more than 10 years in the past (${end.toISOString()}) - possible data corruption`,
          );
          return false;
        }

        // Defensive: Filter out slots that are unreasonably far in the future (>10 years)
        // This likely indicates data corruption
        const tenYearsFromNow = new Date();
        tenYearsFromNow.setFullYear(tenYearsFromNow.getFullYear() + 10);
        if (start > tenYearsFromNow) {
          console.warn(
            `⚠️ Skipping appointment slot ${slot.id}: start time is more than 10 years in the future (${start.toISOString()}) - possible data corruption`,
          );
          return false;
        }

        // Defensive: Filter out slots with duration > 24 hours (likely data corruption)
        const durationHours =
          (end.getTime() - start.getTime()) / (1000 * 60 * 60);
        if (durationHours > 24) {
          console.warn(
            `⚠️ Skipping appointment slot ${slot.id}: duration is > 24 hours (${durationHours.toFixed(1)}h) - possible data corruption`,
          );
          return false;
        }

        return true;
      })
      .map((slot) => ({
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
      }));

    // Convert to utility interfaces with defensive validation
    // Weekly slots now use Int (minutes since midnight UTC 0-1439) instead of DateTime
    const weeklySlots: WeeklySlot[] = consultant.slotsOfAvailabilityWeekly
      .filter((slot) => {
        // Defensive: Validate required fields exist
        if (
          slot.startTimeUtc === null ||
          slot.startTimeUtc === undefined ||
          slot.endTimeUtc === null ||
          slot.endTimeUtc === undefined ||
          !slot.startDay
        ) {
          console.warn(
            `⚠️ Filtering out weekly slot ${slot.id}: missing required fields`,
          );
          return false;
        }

        // Defensive: Validate values are in range (0-1439 minutes)
        if (
          slot.startTimeUtc < 0 ||
          slot.startTimeUtc > 1439 ||
          slot.endTimeUtc < 0 ||
          slot.endTimeUtc > 1439
        ) {
          console.warn(
            `⚠️ Filtering out weekly slot ${slot.id}: time values out of range (0-1439)`,
          );
          return false;
        }

        // For same-day slots, start must be before end
        if (
          slot.startDay === slot.endDay &&
          slot.startTimeUtc >= slot.endTimeUtc
        ) {
          console.warn(
            `❌ Filtering out invalid weekly slot ${slot.id}: startTimeUtc (${slot.startTimeUtc}) >= endTimeUtc (${slot.endTimeUtc}) on same day`,
          );
          return false;
        }

        // Defensive: Check duration is reasonable (<= 24 hours = 1440 minutes)
        const durationMinutes =
          slot.startDay === slot.endDay
            ? slot.endTimeUtc - slot.startTimeUtc
            : 1440 - slot.startTimeUtc + slot.endTimeUtc;
        if (durationMinutes > 1440) {
          console.warn(
            `⚠️ Filtering out weekly slot ${slot.id}: duration > 24 hours (${(durationMinutes / 60).toFixed(1)}h)`,
          );
          return false;
        }

        return true;
      })
      // #1342 — the stored columns travel through as they are, including
      // utcOffsetMinutes: the generator derives each occurrence's UTC weekday
      // from the row's own frozen offset. Flattening the row onto a 1970
      // reference date threw that offset away and left the grid matching rows
      // against the viewer's weekday.
      .map((slot) => ({
        id: slot.id,
        startDay: slot.startDay,
        endDay: slot.endDay,
        startTimeUtc: slot.startTimeUtc,
        endTimeUtc: slot.endTimeUtc,
        utcOffsetMinutes: slot.utcOffsetMinutes,
      }));

    const customSlots: CustomSlot[] = consultant.slotsOfAvailabilityCustom
      .filter((slot) => {
        // Defensive: Validate required fields exist
        if (!slot.startsAt || !slot.endsAt) {
          console.warn(
            `⚠️ Filtering out custom slot ${slot.id}: missing required fields`,
          );
          return false;
        }

        // Defensive: Validate dates are valid
        const start = new Date(slot.startsAt);
        const end = new Date(slot.endsAt);
        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
          console.warn(
            `⚠️ Filtering out custom slot ${slot.id}: invalid date format`,
          );
          return false;
        }

        // Filter out invalid slots, but allow legitimate overnight slots
        if (!isValidOvernightSlot(slot.startsAt, slot.endsAt)) {
          console.warn(
            `❌ Filtering out invalid custom slot ${slot.id}: end time ${slot.endsAt.toISOString()} <= start time ${slot.startsAt.toISOString()}`,
          );
          return false;
        }

        // Defensive: Filter out slots that are unreasonably far in the past (>10 years)
        const tenYearsAgo = new Date();
        tenYearsAgo.setFullYear(tenYearsAgo.getFullYear() - 10);
        if (end < tenYearsAgo) {
          console.warn(
            `⚠️ Filtering out custom slot ${slot.id}: end time is more than 10 years in the past (${end.toISOString()})`,
          );
          return false;
        }

        // Defensive: Filter out slots that are unreasonably far in the future (>10 years)
        const tenYearsFromNow = new Date();
        tenYearsFromNow.setFullYear(tenYearsFromNow.getFullYear() + 10);
        if (start > tenYearsFromNow) {
          console.warn(
            `⚠️ Filtering out custom slot ${slot.id}: start time is more than 10 years in the future (${start.toISOString()})`,
          );
          return false;
        }

        // Defensive: Check duration is reasonable (<= 24 hours)
        const durationHours =
          (end.getTime() - start.getTime()) / (1000 * 60 * 60);
        if (durationHours > 24) {
          console.warn(
            `⚠️ Filtering out custom slot ${slot.id}: duration > 24 hours (${durationHours.toFixed(1)}h)`,
          );
          return false;
        }

        return true;
      })
      .map((slot) => ({
        id: slot.id,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
      }));

    // Apply schedule type filtering based on consultant's preference
    const filteredWeeklySlots =
      consultant.scheduleType === "WEEKLY" ? weeklySlots : [];
    const filteredCustomSlots =
      consultant.scheduleType === "CUSTOM" ? customSlots : [];

    // Process slots using the unified utility with filtered slots
    const slotsByDate: Record<string, SlotTimingWithOverlap[]> =
      processAvailabilitySlots(
        filteredWeeklySlots,
        filteredCustomSlots,
        appointmentSlots,
        startDate,
        endDate,
        timezone,
      );

    // #997 Phase 2 — attach per-interval tooltip metadata AND synthesize
    // "orphan" cells: a booked appointment slot whose availability row was
    // edited/removed after booking has no availability-derived entry above,
    // so without this the consultant calendar would silently show it as
    // pickable. This mirrors the client patch it replaces (previously in
    // useCalendarData.ts's slotStatusMap: "ensure appointments without
    // availability slots still show as booked").
    if (includeAppointmentDetails) {
      const coveredStartsMs = new Set<number>();
      for (const dateKey of Object.keys(slotsByDate)) {
        for (const slot of slotsByDate[dateKey]) {
          const startMs = new Date(slot.startsAt).getTime();
          coveredStartsMs.add(startMs);
          const endMs = new Date(slot.endsAt).getTime();
          slot.overlappingAppointments = overlapMetaCandidatesFor(
            overlapMetaIndex,
            startMs,
            endMs,
          );
        }
      }

      const loc = makeLocalizer(timezone);
      for (const apptSlot of rawSlotsOfAppointment) {
        const start = new Date(apptSlot.startsAt);
        const end = new Date(apptSlot.endsAt);
        if (isNaN(start.getTime()) || isNaN(end.getTime())) continue;
        if (start < startDate || start >= endDate) continue;
        const startMs = start.getTime();
        if (coveredStartsMs.has(startMs)) continue;
        coveredStartsMs.add(startMs); // de-dupe overlapping appointment rows onto one cell

        const dateKey = loc.dateKey(start);
        const synthetic: SlotTimingWithOverlap = {
          slotId: `orphan-${startMs}`,
          dateInISO: start.toISOString(),
          dayOfWeek: dayMap[loc.dayIndex(start)],
          startsAt: start.toISOString(),
          endsAt: end.toISOString(),
          slotOfAvailabilityId: "",
          slotOfAppointmentId: "",
          localStartTime: loc.timeP(start),
          localEndTime: loc.timeP(end),
          type: "CUSTOM",
          isAllocated: true,
          bookingStatus: "fully-booked",
          overlappingAppointments: overlapMetaCandidatesFor(
            overlapMetaIndex,
            startMs,
            end.getTime(),
          ),
        };
        (slotsByDate[dateKey] ||= []).push(synthetic);
      }

      // Re-sort days that received synthetic entries.
      for (const dateKey of Object.keys(slotsByDate)) {
        slotsByDate[dateKey].sort(
          (a, b) =>
            new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
        );
      }
    }

    return NextResponse.json(
      { data: slotsByDate },
      {
        status: 200,
        headers: {
          "Cache-Control": GRID_CACHE_CONTROL,
          // #1319 PR 9 — what the next poll sends back as If-None-Match.
          ...(etag ? { ETag: etag } : {}),
        },
      },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "scheduling" } },
    );
    console.error("Error fetching availability slots:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching availability slots" },
      { status: 500 },
    );
  }
}
