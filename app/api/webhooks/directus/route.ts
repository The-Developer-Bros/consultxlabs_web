/**
 * POST /api/webhooks/directus
 *
 * Placeholder for Directus CMS webhook handler.
 * Disabled unless DIRECTUS_WEBHOOK_SECRET is configured.
 *
 * When Directus is integrated (Issue #312), this will:
 * 1. Receive `items.create` events for `cms_posts`
 * 2. Call ConvertKit to create a broadcast with the new blog post
 * 3. Optionally invalidate ISR/cache for the blog pages
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.DIRECTUS_WEBHOOK_SECRET;

  // Endpoint disabled when secret is not configured
  if (!secret) {
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }

  // Validate webhook signature
  const signature = req.headers.get("x-directus-signature");
  if (!signature || signature !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();

    console.log("[webhooks/directus] Received webhook event:", {
      collection: body?.collection,
      event: body?.event,
      keys: body?.keys,
    });

    // TODO: Issue #312 — Implement Directus webhook handling
    // 1. Check event type (items.create on cms_posts)
    // 2. Fetch post data from Directus API
    // 3. Call createBroadcast() from lib/newsletter/convertkit.ts
    // 4. Invalidate blog page cache

    return NextResponse.json({
      received: true,
      message: "CMS integration not yet active",
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "api" } });
    console.error("[webhooks/directus] Error:", error);
    return NextResponse.json(
      { error: "Webhook processing failed" },
      { status: 500 },
    );
  }
}
