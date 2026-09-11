import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { applyReferralCode } from "@/lib/referrals/service";
import { referralApplyLimiter, applyRateLimit } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Rate limit: 3 referral applications per 24 hours per user
    const rl = await applyRateLimit(referralApplyLimiter, session.user.id);
    if (rl) return rl;

    const body = await req.json();
    const { code } = body;

    if (!code || typeof code !== "string") {
      return NextResponse.json(
        { error: "Referral code is required" },
        { status: 400 },
      );
    }

    const referral = await applyReferralCode(session.user.id, code);

    if (!referral) {
      return NextResponse.json(
        {
          error:
            "Unable to apply referral code. It may be invalid, expired, your own code, or you've already been referred.",
        },
        { status: 400 },
      );
    }

    return NextResponse.json({
      data: referral,
      // FIX #437: Credits are now deferred to first booking, not given on signup
      message:
        "Referral code applied successfully! You'll receive your bonus credits after your first booking.",
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "referrals" } });
    console.error("Error applying referral code:", error);
    return NextResponse.json(
      { error: "Failed to apply referral code" },
      { status: 500 },
    );
  }
}
