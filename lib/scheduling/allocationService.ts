import { reportSentryError } from "@/lib/observability/report";
import { isEventIdFormat } from "@/schemas/slotAllocation/validationSchemas";
import { TimeSlot } from "./calendarUtils";
import type { SlotConflictResult } from "@/utils/slotAllocation/types";

/** #997 Phase 2 — tooltip display metadata for a booked slot, computed
 * server-side (only present when `includeAppointmentDetails` was authorized). */
export interface OverlappingAppointmentMeta {
  id: string;
  type: string;
  title: string;
  with?: string;
}

/** Shape of a raw availability slot returned from the availability-with-allocation API */
interface RawAvailabilityApiSlot {
  slotId: string;
  startsAt: string;
  endsAt: string;
  bookingStatus: "available" | "partially-booked" | "fully-booked";
  type: "WEEKLY" | "CUSTOM";
  dayOfWeek?: string;
  localStartTime?: string;
  localEndTime?: string;
  /** #997 Phase 2 — server-precomputed status-grid tooltip data; only
   * populated when the calendar requested `includeAppointmentDetails`. */
  overlappingAppointments?: OverlappingAppointmentMeta[];
}

export interface AllocationRequest {
  isAuto: boolean;
  slots?: string[];
  useRequestedSlots?: boolean;
  /** Reject (409) if the event already has confirmed slots — sent by the
   * Allocate Slots dialog so a stale tab can't silently replace another
   * tab's allocation. Reschedule flows omit it. */
  initialAllocation?: boolean;
  /** #1012 — reschedule stale-tab precondition. */
  expectedTentativeSlotCount?: number;
  /** #1206 — the consultant's explicit "place what fits now". Only ever sent
   * on the second attempt, after the server has said how many sessions fit. */
  allowPartial?: boolean;
}

/** What the allocate endpoints actually return in `data`: the created (or
 * approved) Appointment rows. Kept loose — callers only read identity. */
export interface AllocatedAppointmentDto {
  id: string;
  [key: string]: unknown;
}

export interface AllocationResponse {
  success: boolean;
  data?: AllocatedAppointmentDto[];
  error?: string;
  /** Structured code from the server (NO_AVAILABILITY, PERIOD_ENDED, etc.). */
  errorCode?: string;
  /** HTTP status of the failed response — 409 means "allocated elsewhere". */
  httpStatus?: number;
  /** #1206 — set on success when fewer sessions were placed than the plan
   * requires, and on a SLOT_SHORTAGE refusal (`placeableSessions`) to say how
   * many a partial attempt would place. Counts are whole sessions. */
  partial?: boolean;
  placedSessions?: number;
  requiredSessions?: number;
  unplacedSessions?: number;
  placeableSessions?: number;
}

export interface AllocationCallOptions {
  isAuto?: boolean;
  useRequestedSlots?: boolean;
  initialAllocation?: boolean;
  /** #1012 — reschedule stale-tab precondition. */
  expectedTentativeSlotCount?: number;
  /** Sent as the Idempotency-Key header; the server replays the original
   * batch for a repeated key instead of double-booking (#837). */
  idempotencyKey?: string;
  /** #1206 — allocate the sessions that fit instead of refusing them all. */
  allowPartial?: boolean;
}

export interface ValidationResponse {
  success: boolean;
  data?: SlotConflictResult;
  error?: string;
}

/**
 * AllocationService - Pure API Client for Event Slot Management
 *
 * Handles all HTTP communication for slot allocation, validation,
 * and related operations. This is a pure API client with no business logic.
 *
 * Features:
 * - Slot allocation for consultations, subscriptions, webinars, classes
 * - Slot validation with conflict and availability checking
 * - Consultant data and availability fetching
 * - Appointment querying
 * - Consistent error handling and response format
 *
 * @example
 * ```ts
 * // Allocate slots
 * const result = await AllocationService.allocateSlots(
 *   "consultation",
 *   consultationId,
 *   slots,
 *   { isAuto: false }
 * );
 *
 * // Validate slots
 * const validation = await AllocationService.validateSlots(
 *   "subscription",
 *   subscriptionId,
 *   slots
 * );
 * ```
 */
export class AllocationService {
  /**
   * Shared PATCH for all four allocate endpoints.
   */
  private static async patchAllocation(
    url: string,
    request: AllocationRequest,
    fallbackError: string,
    idempotencyKey?: string,
  ): Promise<AllocationResponse> {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (idempotencyKey) {
        headers["Idempotency-Key"] = idempotencyKey;
      }

      const response = await fetch(url, {
        method: "PATCH",
        headers,
        body: JSON.stringify(request),
      });

      const data = await response.json();

      if (!response.ok) {
        return {
          success: false,
          error: data.error || fallbackError,
          errorCode: data.errorCode,
          httpStatus: response.status,
          // #1206 — a shortage the consultant can still act on.
          placeableSessions: data.placeableSessions,
          requiredSessions: data.requiredSessions,
        };
      }

      return {
        success: true,
        data: data.data,
        partial: data.partial,
        placedSessions: data.placedSessions,
        requiredSessions: data.requiredSessions,
        unplacedSessions: data.unplacedSessions,
      };
    } catch (error) {
      console.error(`Allocation request failed (${url}):`, error);
      reportSentryError(error, {
        subsystem: "client",
        tags: { feature: "slot-allocation" },
      });
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Network error occurred",
      };
    }
  }

  /**
   * Validates slots for consultations
   */
  static async validateConsultationSlots(
    consultationId: string,
    slots: string[],
  ): Promise<ValidationResponse> {
    try {
      const response = await fetch(
        `/api/bookings/consultations/${consultationId}/validate`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ slots }),
        },
      );

      const data = await response.json();

      if (!response.ok) {
        return {
          success: false,
          error: data.error || "Failed to validate consultation slots",
        };
      }

      return {
        success: true,
        data: data.data,
      };
    } catch (error) {
      console.error("Error validating consultation slots:", error);
      reportSentryError(error, {
        subsystem: "scheduling",
        op: "slot-allocation",
      });
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Network error occurred",
      };
    }
  }

  /**
   * Validates slots for subscriptions
   */
  static async validateSubscriptionSlots(
    subscriptionId: string,
    slots: string[],
  ): Promise<ValidationResponse> {
    try {
      const response = await fetch(
        `/api/bookings/subscriptions/${subscriptionId}/validate`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ slots }),
        },
      );

      const data = await response.json();

      if (!response.ok) {
        return {
          success: false,
          error: data.error || "Failed to validate subscription slots",
        };
      }

      return {
        success: true,
        data: data.data,
      };
    } catch (error) {
      console.error("Error validating subscription slots:", error);
      reportSentryError(error, {
        subsystem: "scheduling",
        op: "slot-allocation",
      });
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Network error occurred",
      };
    }
  }

  /**
   * Generic allocation method that routes to the appropriate endpoint
   */
  static async allocateSlots(
    eventType: "consultation" | "subscription" | "webinar" | "class",
    eventId: string,
    slots: TimeSlot[],
    allocationOptions?: AllocationCallOptions,
  ): Promise<AllocationResponse> {
    // Fail closed before the Zod 400 — mock/hand-crafted PKs (e.g.
    // mock0801-appt-pending) are legal Prisma String @ids but rejected by
    // eventIdSchema. Surface a clear recreate message instead.
    if (!isEventIdFormat(eventId)) {
      return {
        success: false,
        error:
          "This booking has an invalid event id — reseed or recreate it with a generated UUID/CUID.",
      };
    }

    const slotStrings = slots.map((slot) => slot.startTime.toISOString());

    // Build the request object consistently for all event types. Auto mode
    // omits `slots` entirely — the server discovers them (#997 Phase 1).
    const request: AllocationRequest = {
      isAuto: allocationOptions?.isAuto || false,
      slots: allocationOptions?.isAuto ? undefined : slotStrings,
      useRequestedSlots: allocationOptions?.useRequestedSlots,
      initialAllocation: allocationOptions?.initialAllocation,
      expectedTentativeSlotCount: allocationOptions?.expectedTentativeSlotCount,
      allowPartial: allocationOptions?.allowPartial,
    };

    const paths = {
      consultation: "consultations",
      subscription: "subscriptions",
      webinar: "webinars",
      class: "classes",
    } as const;

    const path = paths[eventType];
    if (!path) {
      return {
        success: false,
        error: "Invalid event type",
      };
    }

    return this.patchAllocation(
      `/api/bookings/${path}/${eventId}/allocate`,
      request,
      `Failed to allocate ${eventType} slots`,
      allocationOptions?.idempotencyKey,
    );
  }

  /**
   * Validates slots for classes
   */
  static async validateClassSlots(
    classId: string,
    slots: string[],
  ): Promise<ValidationResponse> {
    try {
      const response = await fetch(
        `/api/bookings/classes/${classId}/validate`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ slots }),
        },
      );

      const data = await response.json();

      if (!response.ok) {
        return {
          success: false,
          error: data.error || "Failed to validate class slots",
        };
      }

      return {
        success: true,
        data: data.data,
      };
    } catch (error) {
      console.error("Error validating class slots:", error);
      reportSentryError(error, {
        subsystem: "scheduling",
        op: "slot-allocation",
      });
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Network error occurred",
      };
    }
  }

  /**
   * Validates slots for webinars
   */
  static async validateWebinarSlots(
    webinarId: string,
    slots: string[],
  ): Promise<ValidationResponse> {
    try {
      const response = await fetch(
        `/api/bookings/webinars/${webinarId}/validate`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ slots }),
        },
      );

      const data = await response.json();

      if (!response.ok) {
        return {
          success: false,
          error: data.error || "Failed to validate webinar slots",
        };
      }

      return {
        success: true,
        data: data.data,
      };
    } catch (error) {
      console.error("Error validating webinar slots:", error);
      reportSentryError(error, {
        subsystem: "scheduling",
        op: "slot-allocation",
      });
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Network error occurred",
      };
    }
  }

  /**
   * Generic validation method that routes to the appropriate service
   */
  static async validateSlots(
    eventType: "consultation" | "subscription" | "webinar" | "class",
    eventId: string,
    slots: TimeSlot[],
  ): Promise<ValidationResponse> {
    const slotStrings = slots.map((slot) => slot.startTime.toISOString());

    switch (eventType) {
      case "consultation":
        return this.validateConsultationSlots(eventId, slotStrings);

      case "subscription":
        return this.validateSubscriptionSlots(eventId, slotStrings);

      case "class":
        return this.validateClassSlots(eventId, slotStrings);

      case "webinar":
        return this.validateWebinarSlots(eventId, slotStrings);

      default:
        return {
          success: false,
          error: "Validation not supported for this event type",
        };
    }
  }

  /**
   * Fetches consultant data
   */
  static async fetchConsultantData(consultantId: string) {
    try {
      const response = await fetch(`/api/user/consultants/${consultantId}`);

      if (!response.ok) {
        // Carry the status onto the thrown Error (message/instanceof
        // unchanged) so the catch below can tell a 4xx business answer
        // (consultant not found/forbidden) from a real 5xx/network fault.
        throw Object.assign(new Error("Failed to fetch consultant data"), {
          httpStatus: response.status,
        });
      }

      const { data } = await response.json();
      return data;
    } catch (error) {
      console.error("Error fetching consultant data:", error);
      const httpStatus =
        error && typeof error === "object" && "httpStatus" in error
          ? (error as { httpStatus?: number }).httpStatus
          : undefined;
      const expected =
        typeof httpStatus === "number" && httpStatus >= 400 && httpStatus < 500;
      reportSentryError(error, {
        subsystem: "client",
        op: "slot-allocation",
        expected,
        extra: { consultantId, httpStatus },
      });
      throw error;
    }
  }

  /**
   * Fetches consultant availability slots (weekly and custom)
   */
  static async fetchAvailabilitySlots(
    consultantId: string,
    startDate: Date,
    endDate: Date,
    /**
     * Explicit timezone override. If omitted we fall back to the browser's
     * locale (when running on the client) and finally to "UTC".  This keeps
     * the API response aligned with the user's calendar view.
     */
    timezone?: string,
    /**
     * #997 Phase 2 — requests the server-computed status grid's per-interval
     * `overlappingAppointments` tooltip metadata + "orphan booked slot"
     * synthesis. The route re-checks ownership server-side regardless of
     * this flag (it's an opt-in signal, not the authorization itself) — the
     * consultee/trials calendars never pass it, so their response shape is
     * unchanged.
     */
    includeAppointmentDetails?: boolean,
    /**
     * Whose calendar is being booked. The allocator counts this user's bookings
     * with ANY consultant as occupied, so without it the grid paints cells green
     * that allocation then rejects. The route re-checks that the caller may read
     * this user's calendar.
     */
    consulteeUserId?: string,
    /**
     * #1164 — skip the browser's HTTP cache for this request. The route now
     * answers `private, max-age=30`, which is right for navigation and polling
     * and wrong immediately after a mutation: the
     * post-allocation refetch would be served the pre-allocation body and the
     * consultant would not see the slots they just booked.
     */
    bypassHttpCache?: boolean,
    /**
     * #1319 PR 9 — the previous response's ETag. The route recomputes its
     * change marker in one indexed read and answers 304 when nothing this grid
     * depends on has moved, so an unchanged 60s poll costs one statement
     * instead of eight. Skipped on the bypass path: that caller just mutated
     * and wants the body regardless.
     */
    ifNoneMatch?: string | null,
  ) {
    if (!consultantId) {
      throw new Error("Consultant ID is required");
    }

    // Resolve the timezone to send to the server.  Priority:
    //   1. Explicit argument
    //   2. Browser-reported tz (client-side)
    //   3. "UTC" (safe default on server or SSR)
    const tz =
      timezone ||
      (typeof Intl !== "undefined"
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : undefined) ||
      "UTC";

    try {
      const params = new URLSearchParams({
        startDateInUtc: startDate.toISOString(),
        endDateInUtc: endDate.toISOString(),
        timezone: tz,
      });
      if (includeAppointmentDetails) {
        params.set("includeAppointmentDetails", "true");
      }
      if (consulteeUserId) {
        params.set("consulteeUserId", consulteeUserId);
      }
      // Sending a conditional header makes fetch treat the request as
      // `no-store` (Fetch spec §4.6), so the browser's own 30s freshness
      // shortcut no longer short-circuits it. That is the trade: one cheap
      // round trip that ends in 304, in exchange for never repainting from a
      // body the browser may have evicted.
      const conditional =
        !bypassHttpCache && ifNoneMatch
          ? { headers: { "If-None-Match": ifNoneMatch } }
          : undefined;
      const response = await fetch(
        `/api/slots/availability-with-allocation/${consultantId}?${params}`,
        bypassHttpCache ? { cache: "no-store" } : conditional,
      );
      // 304 — the marker says nothing this grid reads has changed. The caller
      // keeps the state it already has; no body was sent to parse.
      if (response.status === 304) {
        // Discriminated: the 304 branch carries NO arrays, so a caller that
        // forgets to check `notModified` cannot mistake it for an empty week.
        return { etag: ifNoneMatch ?? null, notModified: true as const };
      }
      if (!response.ok) {
        const errorData = await response.json();
        // See fetchConsultantData: httpStatus lets the catch distinguish a
        // 4xx business answer from a real fault without changing the thrown
        // Error's message/shape.
        throw Object.assign(
          new Error(errorData.error || "Failed to fetch availability slots"),
          { httpStatus: response.status },
        );
      }
      const result = await response.json();
      const { data: slotsByDate } = result;

      // Flatten the grouped-by-date slots into a single array
      const allSlots: RawAvailabilityApiSlot[] = (
        Object.values(slotsByDate) as RawAvailabilityApiSlot[][]
      ).flat();

      return {
        weekly: allSlots.filter((s) => s.type === "WEEKLY"),
        custom: allSlots.filter((s) => s.type === "CUSTOM"),
        etag: response.headers.get("ETag"),
        notModified: false as const,
      };
    } catch (error) {
      console.error("Error fetching availability slots:", error);
      const httpStatus =
        error && typeof error === "object" && "httpStatus" in error
          ? (error as { httpStatus?: number }).httpStatus
          : undefined;
      const expected =
        typeof httpStatus === "number" && httpStatus >= 400 && httpStatus < 500;
      reportSentryError(error, {
        subsystem: "client",
        op: "slot-allocation",
        expected,
        extra: { consultantId, httpStatus },
      });
      throw error;
    }
  }

  /**
   * Fetches specific event slots for any event type
   * Used to display "This Event" (black) instead of "Booked" (gray) in calendar
   *
   * #997 Phase 3 — when `slotsPerCall` is given for a subscription, the
   * response also carries `weeklyConfirmedCallCounts` (server-bucketed by
   * scheduling-timezone week, ADR B9) so the calendar's interactive
   * weekly-limit guard no longer needs a separate whole-window appointment
   * fetch to re-derive it.
   */
  static async fetchEventSlots(
    eventType: "consultation" | "subscription" | "webinar" | "class",
    eventId: string,
    consultantProfileId: string,
    slotsPerCall?: number,
  ) {
    try {
      const params = new URLSearchParams({
        type: eventType.toUpperCase(),
        consultantProfileId,
      });

      // Add the appropriate ID parameter based on event type
      if (eventType === "webinar") {
        params.append("webinarId", eventId);
      } else if (eventType === "class") {
        params.append("classId", eventId);
      } else if (eventType === "subscription") {
        params.append("subscriptionId", eventId);
        if (slotsPerCall && slotsPerCall > 0) {
          params.append("slotsPerCall", String(slotsPerCall));
        }
      } else if (eventType === "consultation") {
        params.append("consultationId", eventId);
      }

      const response = await fetch(`/api/slots/appointments?${params}`);

      if (!response.ok) {
        // See fetchConsultantData: httpStatus lets the catch distinguish a
        // 4xx business answer from a real fault without changing the thrown
        // Error's message/shape.
        throw Object.assign(new Error("Failed to fetch event slots"), {
          httpStatus: response.status,
        });
      }

      const { data, weeklyConfirmedCallCounts } = await response.json();
      return {
        data: data || [],
        weeklyConfirmedCallCounts:
          (weeklyConfirmedCallCounts as Record<string, number> | undefined) ||
          {},
      };
    } catch (error) {
      console.error("Error fetching event slots:", error);
      const httpStatus =
        error && typeof error === "object" && "httpStatus" in error
          ? (error as { httpStatus?: number }).httpStatus
          : undefined;
      const expected =
        typeof httpStatus === "number" && httpStatus >= 400 && httpStatus < 500;
      reportSentryError(error, {
        subsystem: "client",
        op: "slot-allocation",
        expected,
        extra: { eventType, eventId, httpStatus },
      });
      throw error;
    }
  }
}
