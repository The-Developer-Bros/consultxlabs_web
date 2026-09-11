/**
 * Unsubscribe from the newsletter.
 *
 * GET  — the link in an email footer, answers with an HTML confirmation page.
 * POST — RFC 8058 one-click, used by Gmail/Outlook's native unsubscribe button
 *        via the List-Unsubscribe-Post header. Must not require a click-through
 *        or a session.
 *
 * Both are enumeration-safe: the response is identical whether the address was
 * on the list or not.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { unsubscribe } from "@/lib/waitlist/service";
import { getAppUrl } from "@/lib/url";

export async function GET(request: NextRequest): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const email = searchParams.get("email");
  const token = searchParams.get("token");

  if (!email || !token) {
    return html(
      "Link incomplete",
      "That unsubscribe link is missing information. Reply to any of our emails and we will remove you by hand.",
      400,
    );
  }

  try {
    await unsubscribe({ email, token });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "waitlist" } },
    );
    console.error("[waitlist/unsubscribe]", error);
  }

  // Same page on a bad token as on success — a differing response would
  // confirm whether an address is on the list.
  return html(
    "You are unsubscribed",
    "You will not receive any more newsletters from Familiarise. Changed your mind? You can sign up again from any page on the site.",
    200,
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const email = searchParams.get("email");
  const token = searchParams.get("token");

  if (email && token) {
    try {
      await unsubscribe({ email, token });
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "waitlist" } },
      );
      console.error("[waitlist/unsubscribe:one-click]", error);
    }
  }

  // RFC 8058 wants a 200 regardless; mail clients treat anything else as a
  // broken unsubscribe and may report the sender.
  return NextResponse.json({ success: true });
}

function html(title: string, body: string, status: number): Response {
  return new Response(
    `<!DOCTYPE html>
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
</html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
