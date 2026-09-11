import * as Sentry from "@sentry/nextjs";
import { fetchExpertsMetadata } from "@/lib/data/explore-experts";
import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/errors";

export async function GET(_req: NextRequest) {
  try {
    const metadata = await fetchExpertsMetadata();

    return NextResponse.json(
      { data: metadata },
      {
        status: 200,
        headers: {
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
        },
      },
    );
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "auth" } });
    return apiError({ tag: "[ConsultantsMeta.GET]", error });
  }
}
