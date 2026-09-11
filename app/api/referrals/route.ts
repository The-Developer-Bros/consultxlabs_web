import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { getUserReferrals } from "@/lib/referrals/service";

/**
 * #674 org-scope decision: referrals are intentionally PERSONAL-ONLY.
 *
 * A user's referral code follows the user across every org they're a
 * member of — it's a personal acquisition incentive, not a tenant
 * artifact. Org context filtering at this endpoint would erase the
 * (correct) cross-org reach of the program. If a future requirement
 * needs per-org referral attribution (e.g. "Acme's HR sponsored a
 * batch invite campaign"), add an `originatingOrganizationId` column
 * on Referral rather than retrofitting `organizationId` here.
 *
 * Documented under the May 2026 audit's "scope filter coverage" line
 * item as DELIBERATE, not a leak.
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const referrals = await getUserReferrals(session.user.id);
    return NextResponse.json({ data: referrals });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "referrals" } });
    console.error("Error fetching referrals:", error);
    return NextResponse.json(
      { error: "Failed to fetch referrals" },
      { status: 500 },
    );
  }
}
