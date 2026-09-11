import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { setCustomCode } from "@/lib/referrals/service";

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { customCode } = body;

    if (!customCode || typeof customCode !== "string") {
      return NextResponse.json(
        { error: "customCode is required" },
        { status: 400 },
      );
    }

    const result = await setCustomCode(session.user.id, customCode);

    if (!result) {
      return NextResponse.json(
        {
          error:
            "Unable to set custom code. It may be taken, too short (min 3 chars), or too long (max 20 chars).",
        },
        { status: 400 },
      );
    }

    return NextResponse.json({ data: result });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "referrals" } });
    console.error("Error setting custom code:", error);
    return NextResponse.json(
      { error: "Failed to set custom code" },
      { status: 500 },
    );
  }
}
