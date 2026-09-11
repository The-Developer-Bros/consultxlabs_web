/**
 * Admin/staff: platform trial-price floor (PlatformPricingConfig singleton).
 *
 * GET   — current minTrialPriceInPaise
 * PATCH — set minTrialPriceInPaise (0 keeps free trials allowed)
 *
 * ADMIN or STAFF may decide the floor — the product decision is theirs,
 * consultants only price above it.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import {
  getMinTrialPriceInPaise,
  setMinTrialPriceInPaise,
} from "@/lib/trials/pricing-config";

const patchSchema = z.object({
  minTrialPriceInPaise: z.number().int().min(0),
});

export async function GET() {
  const auth = await requirePrivilegedAuth();
  if (auth.error) return auth.error;

  try {
    const minTrialPriceInPaise = await getMinTrialPriceInPaise();
    return NextResponse.json({ minTrialPriceInPaise });
  } catch (error) {
    Sentry.captureException(error);
    return NextResponse.json(
      { error: "Failed to read trial pricing config" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  const auth = await requirePrivilegedAuth();
  if (auth.error) return auth.error;

  // Malformed JSON is a client error, not a Sentry-worthy exception.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "minTrialPriceInPaise must be a non-negative integer" },
        { status: 400 },
      );
    }
    const minTrialPriceInPaise = await setMinTrialPriceInPaise(
      parsed.data.minTrialPriceInPaise,
    );
    return NextResponse.json({ minTrialPriceInPaise });
  } catch (error) {
    Sentry.captureException(error);
    return NextResponse.json(
      { error: "Failed to update trial pricing config" },
      { status: 500 },
    );
  }
}
