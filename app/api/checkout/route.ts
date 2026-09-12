import * as Sentry from "@sentry/nextjs";
import { checkoutSchema } from "@/schemas/checkout";
import { handleCheckout } from "@/lib/payments/operations/checkout";
import {
  classifyError,
  logClassifiedError,
  isBusinessErrorCode,
  ErrorTypes,
} from "@/lib/errors/classification/payment-error-classification";
import { reportSentryError } from "@/lib/observability/report";
import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth-helpers";
import {
  EventCheckoutLockUnavailableError,
  BookingLockUnavailableError,
  EventCheckoutBusyError,
  ConsulteeBookingBusyError,
  EventFullError,
} from "@/utils/appointmentlock";
import { WalletFrozenError } from "@/lib/payments/wallet-freeze";
import { WalletInsufficientFundsError } from "@/lib/api/organizations/wallet";
import { DomainVerificationRequiredError } from "@/lib/enterprise/governance";
import { checkoutLimiter, applyRateLimit } from "@/lib/rate-limit";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { replayByIdempotencyKey } from "@/lib/payments/operations/checkout-replay";
import { isMockPayEnabled } from "@/app/checkout/plans/mockPay";
import { routeGateway } from "@/lib/payments/gateway-router";
import { resolveCheckoutTaxContext } from "@/lib/payments/tax/checkout-context";

export async function POST(req: NextRequest) {
  // #828 — hoisted so the P2002 catch can replay without re-reading the
  // (already consumed) request body.
  let replayUserId: string | undefined;
  let replayKey: string | undefined;
  try {
    // Check authentication — force-fresh (auth-helpers doctrine): the cookie
    // cache can trail a revocation by up to its TTL, and this is a money path.
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const session = authResult.session!;
    replayUserId = session.user.id;

    // Rate limit: 5 checkouts per minute per user
    const rl = await applyRateLimit(checkoutLimiter, session.user.id);
    if (rl) return rl;

    // Validate request body
    const body = await req.json();
    const validatedData = checkoutSchema.parse(body);
    // Only allow mock payments in dev or on Netlify preview builds — prevent
    // client-side bypass in production.
    const isMockPayment = body.isMockPayment === true && isMockPayEnabled();

    // #828 — fast-path replay: a double-click / network retry / second tab
    // with the same key gets the original attempt's response, never a second
    // Payment + tentative slots + gateway order.
    // #1093 §3 — a nullable unique deduplicates nothing: every keyless
    // checkout previously had NO double-charge protection while the code read
    // as though the index covered it. Mint server-side when absent so the
    // column is never null in practice; the NOT NULL flip is staged for the
    // pre-MVP reset.
    validatedData.clientIdempotencyKey ??= globalThis.crypto.randomUUID();
    replayKey = validatedData.clientIdempotencyKey;
    if (replayKey) {
      const replay = await replayByIdempotencyKey(session.user.id, replayKey);
      if (replay) return replay;
    }

    const { buyerCountry } = await resolveCheckoutTaxContext({
      userId: session.user.id,
      headers: req.headers,
    });

    // Auto-route to optimal gateway (Razorpay domestic/IBT, Stripe fallback)
    const gatewayRouting = routeGateway({
      buyerCountry,
      requestedGateway: validatedData.paymentGateway,
    });

    // Override gateway with auto-routed selection
    validatedData.paymentGateway = gatewayRouting.gateway;

    console.log(
      JSON.stringify({
        event: "checkout_gateway_routed",
        buyerCountry,
        gateway: gatewayRouting.gateway,
        reason: gatewayRouting.reason,
        timestamp: new Date().toISOString(),
      }),
    );

    // Unified checkout flow: Create payment first, then appointment via webhook
    // Supports both real and mock payments via isMockPayment flag
    const result = await handleCheckout(
      validatedData,
      session.user.id,
      isMockPayment,
      buyerCountry,
    );
    if (!result.success) {
      return NextResponse.json(result, { status: 400 });
    }
    return NextResponse.json(result);
  } catch (error) {
    // #828 — two concurrent identical requests can both miss the replay
    // lookup; the loser's Payment.create dies on the unique key. Replay the
    // winner's response instead of surfacing a 500.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002" &&
      String(error.meta?.target ?? "").includes("clientIdempotencyKey") &&
      replayUserId &&
      replayKey
    ) {
      const replay = await replayByIdempotencyKey(replayUserId, replayKey);
      if (replay) return replay;
    }
    // ZodError from checkoutSchema.parse() — extract first human-readable message
    if (error instanceof ZodError) {
      const firstMessage = error.issues[0]?.message ?? "Invalid request";
      const lowerMsg = firstMessage.toLowerCase();
      const isAvailability =
        lowerMsg.includes("slot") ||
        lowerMsg.includes("passed") ||
        lowerMsg.includes("too soon") ||
        lowerMsg.includes("availability");
      return NextResponse.json(
        {
          error: firstMessage,
          errorType: isAvailability ? "AVAILABILITY_ERROR" : "UNKNOWN_ERROR",
          timestamp: new Date().toISOString(),
        },
        { status: 400 },
      );
    }

    // #676 CN-1 — the event-checkout lock fails CLOSED on a Redis outage with a
    // typed 503; classifyError is message-only and would mislabel it 500. Honor
    // the structured status so the client sees a retryable 503, not a 500.
    if (error instanceof EventCheckoutLockUnavailableError) {
      return NextResponse.json(
        {
          error:
            "The booking system is briefly busy and your card was not charged. Please try again in a moment.",
          errorType: error.code,
          timestamp: new Date().toISOString(),
        },
        { status: error.httpStatus },
      );
    }

    // B4 — SOLD OUT answered by the optimistic pre-check before the mutex.
    // Terminal until someone cancels: no retryAfter, plain copy.
    if (error instanceof EventFullError) {
      return NextResponse.json(
        {
          error: error.message,
          errorType: error.code,
          timestamp: new Date().toISOString(),
        },
        { status: error.httpStatus },
      );
    }

    // B4/B8c — typed lock contention: another buyer holds the event mutex, or
    // this same account is mid-checkout on another device. Structured 409 +
    // retryAfter so the client can auto-retry once instead of dead-ending.
    if (
      error instanceof EventCheckoutBusyError ||
      error instanceof ConsulteeBookingBusyError
    ) {
      return NextResponse.json(
        {
          error: error.message,
          errorType: error.code,
          retryAfter: error.retryAfterSeconds,
          yourCardWasNotCharged: true,
          timestamp: new Date().toISOString(),
        },
        { status: error.httpStatus },
      );
    }

    // #1169 PR 1 — the slot/consultee booking locks fail closed the same way;
    // without this branch classifyError mislabelled the outage as a 500.
    if (error instanceof BookingLockUnavailableError) {
      return NextResponse.json(
        {
          error:
            "The booking system is briefly busy and your card was not charged. Please try again in a moment.",
          errorType: error.code,
          timestamp: new Date().toISOString(),
        },
        { status: error.httpStatus },
      );
    }

    // #837 — a frozen wallet (ledger drift caught by reconcile) is a specific,
    // retryable 409, not a generic 500. classifyError is message-only and would
    // mislabel it; honor the structured httpStatus like the lock error above.
    if (error instanceof WalletFrozenError) {
      return NextResponse.json(
        {
          error:
            "This organization's wallet is temporarily on hold pending a balance review. Your card was not charged. Please try again shortly or contact support.",
          errorType: "WALLET_FROZEN",
          timestamp: new Date().toISOString(),
        },
        { status: error.httpStatus },
      );
    }

    // #1477 — an overdrawn wallet reaches here with its own code, so the
    // classifier below would already answer 402. It gets its own branch anyway
    // for the two things that fall-through cannot do: replace a message naming
    // the billing account and the paise figure with copy the buyer can act on,
    // and skip the unconditional `captureException` under it, which would file
    // a routine refusal as an exception.
    if (error instanceof WalletInsufficientFundsError) {
      // #1477 — a modelled refusal, reported like the other business-coded
      // outcomes below so the route's observability stays uniform.
      reportSentryError(error, { subsystem: "checkout", expected: true });
      return NextResponse.json(
        {
          error:
            "This organization's wallet does not have enough balance for this booking. Your card was not charged — ask your billing admin to top it up.",
          errorType: ErrorTypes.WALLET_INSUFFICIENT_FUNDS,
          yourCardWasNotCharged: true,
          timestamp: new Date().toISOString(),
        },
        { status: error.httpStatus },
      );
    }

    // #1407 — invoice funding asserts a verified org domain
    // (lib/payments/operations/checkout.ts:2585) and the guard's typed 403 fell
    // through to classifyError, which is message-only and answered 500
    // UNKNOWN_ERROR. Honour the structured status like WalletFrozenError above,
    // so the page can say what the admin has to do.
    if (error instanceof DomainVerificationRequiredError) {
      return NextResponse.json(
        {
          error:
            "Invoice funding requires a verified domain on this organization. Your card was not charged — ask your billing admin to verify the domain, or pay by card instead.",
          errorType: "DOMAIN_VERIFICATION_REQUIRED",
          timestamp: new Date().toISOString(),
        },
        { status: error.httpStatus },
      );
    }

    // #1319 — an exhausted serialization retry (P2034 ×4) means the tx never
    // committed: nothing was charged and a retry will see the sibling's state.
    // classifyError is message-only and would label it 500.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2034"
    ) {
      return NextResponse.json(
        {
          error:
            "The booking system is briefly busy and your card was not charged. Please try again in a moment.",
          errorType: "SERIALIZATION_CONFLICT",
          retryAfter: 2,
          yourCardWasNotCharged: true,
          timestamp: new Date().toISOString(),
        },
        { status: 409 },
      );
    }

    // #1477 — an error carrying a registered business code is an ANSWER, not a
    // fault: the classifier below already resolves it to its own status and
    // toast. Capturing it here as an exception is what kept every coded refusal
    // without an explicit branch above — the #1458 programme-cap codes, the
    // #1467 entitlement codes — paging as a checkout incident. Report it the
    // way the modelled refusals inside handleCheckout are reported instead.
    if (isBusinessErrorCode((error as { code?: unknown } | null)?.code)) {
      reportSentryError(error, { subsystem: "checkout", expected: true });
    } else {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "checkout" } },
      );
    }
    const classified = classifyError(error, "Checkout failed");
    logClassifiedError("Checkout", classified, error);

    return NextResponse.json(
      {
        error: classified.errorMessage,
        errorType: classified.errorType,
        timestamp: new Date().toISOString(),
      },
      { status: classified.httpStatus },
    );
  }
}
