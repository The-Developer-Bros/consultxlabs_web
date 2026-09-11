/**
 * GET /api/waitlist/confirm — double opt-in landing.
 *
 * Clicked from an email client, so it answers with a small self-contained HTML
 * page rather than JSON. Mirrors the unsubscribe route's shape.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest } from "next/server";
import { confirmSubscription } from "@/lib/waitlist/service";
import { getAppUrl } from "@/lib/url";

function page(title: string, body: string, status: number): Response {
  return new Response(resultHtml(title, body), {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const email = searchParams.get("email");
    const token = searchParams.get("token");
    const issued = Number(searchParams.get("issued"));

    if (!email || !token) {
      return page(
        "Link incomplete",
        "That confirmation link is missing information. Try signing up again.",
        400,
      );
    }

    const result = await confirmSubscription({
      email,
      token,
      issuedAt: issued,
    });

    if (result.outcome === "INVALID") {
      return page(
        "Link expired",
        "This confirmation link is no longer valid — they expire after 48 hours. Sign up again and we will send a fresh one.",
        400,
      );
    }

    if (result.outcome === "ALREADY_CONFIRMED") {
      return page(
        "Already confirmed",
        "You are already on the list. Nothing more to do.",
        200,
      );
    }

    return page(
      "You are on the list",
      "Thanks for confirming. We will be in touch when there is something worth reading.",
      200,
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "waitlist" } },
    );
    console.error("[waitlist/confirm]", error);
    return page(
      "Something went wrong",
      "We could not confirm your subscription right now. Please try the link again in a moment.",
      500,
    );
  }
}

function resultHtml(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${title} — Familiarise</title>
  </head>
  <body style="margin:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',sans-serif">
    <div style="max-width:520px;margin:0 auto;padding:64px 20px">
      <div style="background:#fff;border-radius:8px;padding:32px">
        <h1 style="margin:0 0 12px;font-size:24px;color:#111">${title}</h1>
        <p style="margin:0 0 24px;font-size:16px;line-height:1.5;color:#444">${body}</p>
        <a href="${getAppUrl()}" style="display:inline-block;background:#000;color:#fff;padding:12px 20px;border-radius:5px;text-decoration:none;font-size:15px">Go to Familiarise</a>
      </div>
    </div>
  </body>
</html>`;
}
