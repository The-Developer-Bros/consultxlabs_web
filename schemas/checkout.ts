import { z } from "zod";
import { AppointmentsType } from "@prisma/client";
import { validateSlotTiming } from "@/lib/payments/utils/slot-validation";
import {
  SUPPORTED_CURRENCY_CODES,
  toSupportedCurrency,
} from "@/lib/currency-codes";
import { GST_STATE_OPTIONS } from "@/lib/compliance/state-codes";

/**
 * The 2-digit GST state codes that actually exist, derived from the same map
 * the checkout picker renders. `.length(2)` alone let "00" or "99" through, and
 * `numericStateCode` passes any two digits straight to `placeOfSupply` — so an
 * invalid code reached a statutory document as a real-looking state and the
 * register filed it under a state that does not exist, without even a warning.
 */
const GST_STATE_CODES: ReadonlySet<string> = new Set(
  GST_STATE_OPTIONS.map((option) => option.code),
);

// Base schemas for individual components
export const appointmentTypeSchema = z.enum([
  "CONSULTATION",
  "SUBSCRIPTION",
  "WEBINAR",
  "CLASS",
  "TRIAL",
]);

export const paymentGatewaySchema = z.enum(["STRIPE", "RAZORPAY", "CARD"]);

// The implemented checkout gateways — a strict subset of the PaymentGateway
// Prisma enum. Post-MVP stubs (e.g. DODO_PAYMENTS, #984) are NOT valid at
// checkout, so everything flowing into CheckoutInput.paymentGateway uses this
// narrow type, never the full enum.
export type SupportedCheckoutGateway = z.infer<typeof paymentGatewaySchema>;

// Search params validation (URL query parameters)
export const searchParamsSchema = z.object({
  slotOfAvailabilityWeeklyId: z.string().optional(),
  slotOfAvailabilityCustomId: z.string().optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  discountCode: z.string().optional(),
  eventId: z.string().optional(),
  notes: z.string().optional(),
});

// Consultation-specific validation
export const consultationSearchParamsSchema = searchParamsSchema
  .extend({
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
  })
  .refine(
    (data) =>
      (data.slotOfAvailabilityWeeklyId && !data.slotOfAvailabilityCustomId) ||
      (!data.slotOfAvailabilityWeeklyId && data.slotOfAvailabilityCustomId),
    {
      message:
        "Exactly one of slotOfAvailabilityWeeklyId or slotOfAvailabilityCustomId must be provided",
      path: ["slotOfAvailabilityWeeklyId"],
    },
  )
  .refine((data) => new Date(data.startsAt) < new Date(data.endsAt), {
    message: "Start time must be before end time",
    path: ["startsAt"],
  });

// Subscription-specific validation
export const subscriptionSearchParamsSchema = searchParamsSchema.extend({
  schedulingPeriodStartsAt: z.string().datetime().optional(),
  schedulingPeriodEndsAt: z.string().datetime().optional(),
});

// Webinar-specific validation
export const webinarSearchParamsSchema = searchParamsSchema.extend({
  eventId: z.string(),
});

// Class-specific validation
export const classSearchParamsSchema = searchParamsSchema.extend({
  eventId: z.string(),
});

// Main checkout schema (for API requests)
export const checkoutSchema = z
  .object({
    appointmentType: appointmentTypeSchema,
    planId: z.string(),
    eventId: z.string().optional(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
    slotOfAvailabilityWeeklyId: z.string().optional(),
    slotOfAvailabilityCustomId: z.string().optional(),
    schedulingPeriodStartsAt: z.string().datetime().optional(),
    schedulingPeriodEndsAt: z.string().datetime().optional(),
    discountCode: z.string().optional(),
    // #828 — one key per logical checkout attempt; the server replays the
    // original response for a duplicate instead of minting a second order.
    clientIdempotencyKey: z.string().min(8).max(128).optional(),
    paymentGateway: paymentGatewaySchema.default("RAZORPAY"), // Server auto-routes; client hint only
    // #1396 — this lands in `Payment.displayCurrencyAtCheckout` and it comes
    // from localStorage. `z.string().length(3)` let any three letters through
    // and `Intl.NumberFormat` renders an invented code without complaint
    // ("XYZ 1,234.50"), so junk persisted onto a money row. Allowlisted against
    // the same codes the navbar offers; the list is shared so the two cannot
    // drift. This is a DISPLAY currency — settlement stays INR-only (ADR 15).
    displayCurrency: z.enum(SUPPORTED_CURRENCY_CODES).optional(),
    // #1437 — this note is forwarded verbatim into the Razorpay order's
    // `notes` payload, where a value may not exceed 256 characters. Over that
    // the gateway refuses to create the order and the buyer simply cannot pay,
    // so bound it here with a message they can act on. The metadata builder
    // truncates as a second line of defence; the full note is still persisted
    // on the Payment and Appointment rows.
    notes: z
      .string()
      .max(256, "Booking notes must be 256 characters or fewer")
      .optional(),
    // #1365 — the buyer's GST state (2-digit numeric), declared at checkout.
    // Optional by design: Sec 12(2)(b) IGST Act places a B2C supply at the
    // supplier's own location when no address is on record, so a blank field
    // is the statutory default rather than a missing answer.
    consumerStateCode: z
      .string()
      .length(2)
      .refine((code) => GST_STATE_CODES.has(code), {
        message: "Not a valid GST state code",
      })
      .optional(),
    useReferralCredits: z.boolean().optional(), // Apply available referral credits
    // Enterprise: optional org context. When set, the payment is tagged with
    // organizationId and billing is routed per the BillingAccount's
    // fundingSource (Arch-4 model):
    //   PERSONAL  → normal gateway, payment tagged for reporting.
    //   WALLET    → wallet debit (lib/api/organizations/wallet.ts).
    //   LICENSE   → covered by an active LICENSED_SEAT ProgramAssignment.
    //   INVOICE   → deferred billing; line item lands on next invoice.
    //   PROJECT   → reserved for v2.
    organizationId: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    // === CONSULTATION validation ===
    if (data.appointmentType === "CONSULTATION") {
      // Require slot timing
      if (!data.startsAt || !data.endsAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Consultation requires slot start and end times",
          path: ["startsAt"],
        });
      }

      // Require slot availability ID
      if (
        !data.slotOfAvailabilityWeeklyId &&
        !data.slotOfAvailabilityCustomId
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Consultation requires slot availability ID",
          path: ["slotOfAvailabilityWeeklyId"],
        });
      }
    }

    // === SUBSCRIPTION validation ===
    if (data.appointmentType === "SUBSCRIPTION") {
      const hasSlotData = data.startsAt && data.endsAt;
      const hasSchedulingPeriod =
        data.schedulingPeriodStartsAt && data.schedulingPeriodEndsAt;

      // Require EITHER slot data OR scheduling period
      if (!hasSlotData && !hasSchedulingPeriod) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Subscription requires either slot timing or scheduling period",
          path: ["startsAt"],
        });
      }

      // If slot data provided, require availability ID
      if (
        hasSlotData &&
        !data.slotOfAvailabilityWeeklyId &&
        !data.slotOfAvailabilityCustomId
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Subscription with slots requires slot availability ID",
          path: ["slotOfAvailabilityWeeklyId"],
        });
      }
    }

    // === WEBINAR and CLASS validation ===
    if (["WEBINAR", "CLASS"].includes(data.appointmentType)) {
      if (!data.eventId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${data.appointmentType.toLowerCase()} requires event ID`,
          path: ["eventId"],
        });
      }
    }

    // === Cross-field validation ===

    // Ensure only one type of slot availability ID
    if (data.slotOfAvailabilityWeeklyId && data.slotOfAvailabilityCustomId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Cannot provide both weekly and custom slot availability IDs",
        path: ["slotOfAvailabilityCustomId"],
      });
    }

    // Validate slot timing order if both provided
    if (data.startsAt && data.endsAt) {
      const startTime = new Date(data.startsAt);
      const endTime = new Date(data.endsAt);
      if (startTime >= endTime) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Start time must be before end time",
          path: ["endsAt"],
        });
      }
    }

    // Validate slot is not in the past or within minimum booking lead time
    if (data.startsAt) {
      const slotStart = new Date(data.startsAt);
      const timingError = validateSlotTiming(slotStart);
      if (timingError) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: timingError,
          path: ["startsAt"],
        });
      }
    }

    // Validate scheduling period order if both provided
    if (data.schedulingPeriodStartsAt && data.schedulingPeriodEndsAt) {
      const startDate = new Date(data.schedulingPeriodStartsAt);
      const endDate = new Date(data.schedulingPeriodEndsAt);
      if (startDate >= endDate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Scheduling period start must be before end",
          path: ["schedulingPeriodEndsAt"],
        });
      }
    }
  });

// Payment intent metadata schema
export const paymentMetadataSchema = z
  .object({
    appointmentId: z.string(),
    appointmentType: z.string(),
  })
  .and(z.record(z.string()));

// Response schemas
export const checkoutSuccessResponseSchema = z.object({
  success: z.literal(true),
  appointmentId: z.string().optional(), // Optional for production flow
  paymentIntentId: z.string().optional(),
  clientSecret: z.string().optional(),
  orderId: z.string().optional(),
  checkoutUrl: z.string().optional(),
  message: z.string().optional(),
  skipPayment: z.boolean().optional(),
  isMockPayment: z.boolean().optional(), // Mock payment flag
  isZeroAmountPayment: z.boolean().optional(), // Credits fully covered payment
  // Production flow fields
  paymentIntent: z
    .object({
      id: z.string(),
      client_secret: z.string().nullish(), // Can be Payment Intent secret, Checkout URL, or null for org billing modes
    })
    .optional(),
  amount: z.number().optional(),
  currency: z.string().optional(),
});

export const checkoutErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  errorType: z.string().optional(),
  details: z.any().optional(),
});

export const checkoutResponseSchema = z.union([
  checkoutSuccessResponseSchema,
  checkoutErrorResponseSchema,
]);

// Type exports for use in components
export type CheckoutInput = z.infer<typeof checkoutSchema>;
export type SearchParams = z.infer<typeof searchParamsSchema>;
export type ConsultationSearchParams = z.infer<
  typeof consultationSearchParamsSchema
>;
export type SubscriptionSearchParams = z.infer<
  typeof subscriptionSearchParamsSchema
>;
export type WebinarSearchParams = z.infer<typeof webinarSearchParamsSchema>;

// Utility functions for validation
export const validateSearchParamsForAppointmentType = (
  appointmentType: AppointmentsType,
  searchParams: Record<string, string | undefined>,
) => {
  switch (appointmentType) {
    case "CONSULTATION":
      return consultationSearchParamsSchema.safeParse(searchParams);
    case "SUBSCRIPTION":
      return subscriptionSearchParamsSchema.safeParse(searchParams);
    case "WEBINAR":
      return webinarSearchParamsSchema.safeParse(searchParams);
    case "CLASS":
      return classSearchParamsSchema.safeParse(searchParams);
    default:
      return {
        success: false,
        error: { issues: [{ message: "Invalid appointment type" }] },
      };
  }
};

export const createCheckoutData = (params: {
  appointmentType: AppointmentsType;
  planId: string;
  paymentGateway: SupportedCheckoutGateway;
  eventId?: string;
  startsAt?: string;
  endsAt?: string;
  slotOfAvailabilityWeeklyId?: string;
  slotOfAvailabilityCustomId?: string;
  schedulingPeriodStartsAt?: string;
  schedulingPeriodEndsAt?: string;
  discountCode?: string;
  displayCurrency?: string;
  notes?: string;
  useReferralCredits?: boolean;
  organizationId?: string;
  consumerStateCode?: string;
}): CheckoutInput => {
  return {
    appointmentType: params.appointmentType,
    planId: params.planId,
    paymentGateway: params.paymentGateway,
    eventId: params.eventId,
    startsAt: params.startsAt,
    endsAt: params.endsAt,
    slotOfAvailabilityWeeklyId: params.slotOfAvailabilityWeeklyId,
    slotOfAvailabilityCustomId: params.slotOfAvailabilityCustomId,
    schedulingPeriodStartsAt: params.schedulingPeriodStartsAt,
    schedulingPeriodEndsAt: params.schedulingPeriodEndsAt,
    discountCode: params.discountCode,
    displayCurrency: toSupportedCurrency(params.displayCurrency),
    notes: params.notes,
    useReferralCredits: params.useReferralCredits,
    organizationId: params.organizationId,
    consumerStateCode: params.consumerStateCode,
  };
};
