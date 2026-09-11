/**
 * POST /api/waitlist — public newsletter signup.
 *
 * Double opt-in: this only creates a PENDING row and sends a confirmation
 * email. Rate limited to 3/hr per IP in middleware.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { WaitlistSource } from "@prisma/client";
import { z } from "zod";
import { getSession } from "@/lib/auth-server";
import { getClientIp } from "@/lib/rate-limit";
import { subscribe } from "@/lib/waitlist/service";

const subscribeSchema = z.object({
  email: z.string().trim().email("Enter a valid email address").max(254),
  name: z.string().trim().max(120).optional(),
  source: z.nativeEnum(WaitlistSource).optional(),
  tags: z.array(z.string().trim().max(40)).max(10).optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json().catch(() => null);
    const parsed = subscribeSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid email address" },
        { status: 400 },
      );
    }

    // Link the row to the account when one is signed in — but never require
    // a session; the footer form is public.
    const session = await getSession().catch(() => null);

    const result = await subscribe({
      ...parsed.data,
      userId: session?.user?.id ?? null,
      ip: getClientIp(request),
      userAgent: request.headers.get("user-agent"),
    });

    // A send failure is an infrastructure state, not a per-address one, so
    // saying so leaks no membership — and silently claiming success would
    // strand the subscriber at PENDING with no confirmation to click.
    if (result.outcome === "CONFIRMATION_FAILED") {
      return NextResponse.json(
        {
          error:
            "We could not send your confirmation email. Please try again shortly.",
        },
        { status: 502 },
      );
    }

    // Otherwise deliberately uniform: telling the caller whether the address
    // was already subscribed would turn this into a membership oracle.
    return NextResponse.json({
      success: true,
      message: "Check your email to confirm your subscription.",
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "waitlist" } },
    );
    console.error("[waitlist/subscribe]", error);
    return NextResponse.json(
      { error: "Could not sign you up right now. Please try again." },
      { status: 500 },
    );
  }
}
