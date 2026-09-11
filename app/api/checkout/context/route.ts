import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { resolveCheckoutTaxContext } from "@/lib/payments/tax/checkout-context";

export async function GET(req: NextRequest) {
  const session = await getSession();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const taxContext = await resolveCheckoutTaxContext({
      userId: session.user.id,
      headers: req.headers,
    });

    return NextResponse.json(taxContext);
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "checkout" } });
    console.error("Checkout context error:", error);
    return NextResponse.json(
      { error: "Failed to resolve checkout tax context" },
      { status: 500 },
    );
  }
}
