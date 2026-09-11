import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { getSession } from "@/lib/auth-server";
import { getCreditHistory, getUserCredits } from "@/lib/referrals/service";

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [{ totalAvailable }, history] = await Promise.all([
      getUserCredits(session.user.id),
      getCreditHistory(session.user.id),
    ]);

    return NextResponse.json({
      data: {
        totalAvailable,
        history,
      },
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "referrals" } });
    console.error("Error fetching credits:", error);
    return NextResponse.json(
      { error: "Failed to fetch credits" },
      { status: 500 },
    );
  }
}
