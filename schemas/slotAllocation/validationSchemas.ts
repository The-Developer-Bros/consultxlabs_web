/**
 * Zod Validation Schemas for Slot Allocation API Routes
 *
 * PURPOSE: Type-safe, declarative validation for all event booking endpoints
 *
 * WHY ZOD:
 * - Type inference: Automatic TypeScript types from schemas
 * - Composable: Define once, reuse everywhere
 * - Better DX: Declarative vs imperative validation
 * - Industry standard: Used by Vercel, tRPC, Remix, etc.
 * - Rich errors: Detailed validation messages out of the box
 *
 * VALIDATION LAYERS:
 * 1. Zod schemas (this file) - Validates data types and formats
 * 2. SlotValidationService - Validates business rules (conflicts, availability)
 * 3. SlotAllocationService - Executes allocation logic
 */

import { z } from "zod";

/**
 * ALLOCATION REQUEST SCHEMA
 *
 * Used by: All allocate endpoints (consultations, subscriptions, webinars, classes)
 *
 * Validates:
 * - isAuto: boolean flag for auto vs manual allocation
 * - slots: array of ISO datetime strings (required for manual allocation)
 * - useRequestedSlots: boolean flag to use pre-created appointments
 *
 * Business rule: Manual allocation requires slots array unless using requested slots
 */
export const allocationRequestSchema = z
  .object({
    isAuto: z.boolean({
      required_error: "'isAuto' is required",
      invalid_type_error: "'isAuto' must be a boolean (true/false)",
    }),

    useRequestedSlots: z
      .boolean({
        invalid_type_error: "'useRequestedSlots' must be a boolean",
      })
      .optional(),

    // Multi-tab guard: reject with 409 if the event already has confirmed
    // (non-tentative) slots. Sent by dialog-initiated FRESH allocations only;
    // reschedule/re-allocation flows omit it to keep replace semantics.
    initialAllocation: z
      .boolean({
        invalid_type_error: "'initialAllocation' must be a boolean",
      })
      .optional(),

    // #1012 — reschedule stale-tab precondition. When present, must equal the
    // live tentative slot count or the allocate returns 409.
    expectedTentativeSlotCount: z
      .number({
        invalid_type_error: "'expectedTentativeSlotCount' must be a number",
      })
      .int()
      .nonnegative()
      .optional(),

    // Consultant's explicit acceptance of times outside their own published
    // availability. The dialog has always offered this ("Override and
    // Allocate"), but the field was absent from this schema and therefore
    // stripped, so the button reliably 400'd with OUTSIDE_AVAILABILITY. The
    // route only honours it for the consultant or a privileged caller — a
    // consultee cannot wave away the consultant's schedule.
    override: z
      .boolean({
        invalid_type_error: "'override' must be a boolean",
      })
      .optional(),

    // #1206 — the consultant's explicit "place what fits now, the rest when
    // availability opens". Default false: a partial schedule is never chosen
    // on the consultee's behalf, only after the shortfall has been shown.
    allowPartial: z
      .boolean({
        invalid_type_error: "'allowPartial' must be a boolean",
      })
      .optional()
      .default(false),

    // #1206 — "place the sessions that are still missing and leave everything
    // already booked alone". Distinct from a plain re-allocation, which deletes
    // the confirmed sessions and re-plans the whole event. Consultant-only for
    // the same reason as `allowPartial`.
    topUp: z
      .boolean({
        invalid_type_error: "'topUp' must be a boolean",
      })
      .optional()
      .default(false),

    slots: z
      .array(
        z.string().datetime({
          message:
            "Each slot must be a valid ISO 8601 datetime string (e.g., '2025-01-15T10:00:00Z')",
        }),
      )
      .optional(),
  })
  .refine(
    (data) => {
      // Auto allocation: no slots needed
      if (data.isAuto) return true;

      // Using requested slots: no manual slots needed
      if (data.useRequestedSlots) return true;

      // Manual allocation: slots array is required
      return data.slots && data.slots.length > 0;
    },
    {
      message:
        "Manual allocation requires 'slots' array with at least one time slot",
      path: ["slots"],
    },
  );

/**
 * VALIDATION REQUEST SCHEMA
 *
 * Used by: All validate endpoints (consultations, subscriptions, webinars, classes)
 *
 * Validates:
 * - slots: array of ISO datetime strings (required, non-empty)
 *
 * This is simpler than allocation since validation always requires slots.
 */
export const validationRequestSchema = z.object({
  slots: z
    .array(
      z.string().datetime({
        message:
          "Each slot must be a valid ISO 8601 datetime string (e.g., '2025-01-15T10:00:00Z')",
      }),
    )
    .min(1, {
      message: "'slots' array must contain at least one time slot to validate",
    }),
});

/**
 * EVENT ID SCHEMA
 *
 * Used by: All API routes for validating URL path parameters
 *
 * Validates:
 * - ID is a valid UUID or CUID format
 *
 * UUID format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 * CUID format: cxxxxxxxxxxxxxxxxxxxxxxxxx
 *
 * COMPATIBILITY FIX:
 * Different Prisma models use different ID formats based on schema.prisma:
 * - UUID events: Consultation (@default(uuid()))
 * - CUID events: Subscription, Webinar, Class (all @default(cuid()))
 * - CUID plans: ConsultationPlan, SubscriptionPlan, WebinarPlan, ClassPlan
 *
 * Keep `isEventIdFormat` in sync — SSR timings gates and the allocate client
 * reuse that helper so a bad mock PK fails closed before the Zod 400 toast.
 */
/** UUID format: 8-4-4-4-12 hexadecimal characters */
const EVENT_ID_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** CUIDv1 (Prisma <5): 'c' + 24 chars = 25 total; CUIDv2: letter + 23 = 24 */
const EVENT_ID_CUID_RE = /^[a-z][a-z0-9]{23,24}$/;

/** Same rule as `eventIdSchema`, for SSR/client guards without throwing. */
export function isEventIdFormat(id: string | null | undefined): boolean {
  if (!id) return false;
  return EVENT_ID_UUID_RE.test(id) || EVENT_ID_CUID_RE.test(id);
}

export const EVENT_ID_INVALID_MESSAGE =
  "Event ID must be a valid UUID or CUID format (received invalid format)";

export const eventIdSchema = z
  .string()
  .min(1, { message: "Event ID is required" })
  .refine((id) => isEventIdFormat(id), {
    message: EVENT_ID_INVALID_MESSAGE,
  });

/**
 * PAGINATION SCHEMA
 *
 * Used by: List endpoints (future feature)
 *
 * Validates:
 * - page: positive integer (default: 1)
 * - limit: integer between 1-100 (default: 20)
 *
 * This is prepared for future pagination features.
 */
export const paginationSchema = z.object({
  page: z.coerce
    .number()
    .int()
    .positive({ message: "'page' must be a positive integer" })
    .default(1),

  limit: z.coerce
    .number()
    .int()
    .min(1, { message: "'limit' must be at least 1" })
    .max(100, { message: "'limit' cannot exceed 100" })
    .default(20),
});

/**
 * HELPER: Parse and format Zod errors for API responses
 *
 * Converts Zod's detailed error structure into user-friendly messages.
 *
 * EXAMPLE:
 * Input: ZodError with 2 issues
 * Output: "slots: Each slot must be a valid ISO datetime; isAuto: Required field"
 */
export function formatZodError(error: z.ZodError): string {
  return error.errors
    .map((err) => {
      const path = err.path.join(".");
      return path ? `${path}: ${err.message}` : err.message;
    })
    .join("; ");
}

/**
 * HELPER: Safe parse with custom error handling
 *
 * Wraps Zod's parse() with try-catch and returns formatted error.
 * Use this in API routes for consistent error handling.
 *
 * RETURNS:
 * - { success: true, data: T } on valid data
 * - { success: false, error: string } on validation failure
 */
export function safeParse<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
): { success: true; data: T } | { success: false; error: string } {
  try {
    const parsed = schema.parse(data);
    return { success: true, data: parsed };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: formatZodError(error) };
    }
    return { success: false, error: "Invalid input data" };
  }
}
