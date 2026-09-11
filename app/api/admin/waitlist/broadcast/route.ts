/**
 * POST /api/admin/waitlist/broadcast
 *
 * Sends one newsletter to every SUBSCRIBED address via Resend's batch API
 * (100 per call). Every message carries an unsubscribe link in the footer and
 * the List-Unsubscribe headers that let mail clients offer one-click opt-out.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth-helpers";
import { getResendClient, recordFailedEmail } from "@/lib/email";
import { listSendableSubscribers } from "@/lib/waitlist/service";
import { buildUnsubscribeUrl } from "@/lib/waitlist/tokens";

const sendSchema = z.object({
  subject: z.string().trim().min(1, "Subject is required").max(200),
  htmlBody: z.string().min(1, "Email body is required"),
  textBody: z.string().optional(),
});

const BATCH_SIZE = 100;
const FROM_ADDRESS = "Familiarise <newsletter@familiarise.com>";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await requireAdminAuth();
    if (auth.error) return auth.error;

    const body = await request.json().catch(() => null);
    const parsed = sendSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const { subject, htmlBody, textBody } = parsed.data;

    const resend = getResendClient();
    if (!resend) {
      return NextResponse.json(
        { error: "Email service not configured (RESEND_API_KEY missing)" },
        { status: 503 },
      );
    }

    const subscribers = await listSendableSubscribers();
    if (subscribers.length === 0) {
      return NextResponse.json(
        { error: "No confirmed subscribers to send to" },
        { status: 404 },
      );
    }

    let sent = 0;
    let failed = 0;
    const errors: string[] = [];

    for (let i = 0; i < subscribers.length; i += BATCH_SIZE) {
      const batch = subscribers.slice(i, i + BATCH_SIZE);
      const emails = batch.map((sub) =>
        buildMessage(sub.email, subject, htmlBody, textBody),
      );

      const outcome = await sendBatch(resend, emails);
      if (outcome.ok) {
        sent += outcome.sent;
      } else {
        failed += batch.length;
        errors.push(
          `Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${outcome.error}`,
        );
      }
    }

    console.log(
      `[admin/waitlist/broadcast] sent=${sent} failed=${failed} total=${subscribers.length}`,
    );

    return NextResponse.json({
      success: true,
      sent,
      failed,
      total: subscribers.length,
      ...(errors.length > 0 && { errors }),
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "waitlist" } },
    );
    console.error("[admin/waitlist/broadcast]", error);
    return NextResponse.json(
      { error: "Failed to send the newsletter" },
      { status: 500 },
    );
  }
}

type BroadcastMessage = ReturnType<typeof buildMessage>;

function buildMessage(
  email: string,
  subject: string,
  htmlBody: string,
  textBody: string | undefined,
) {
  const unsubscribeUrl = buildUnsubscribeUrl(email);
  return {
    from: FROM_ADDRESS,
    to: email,
    subject,
    html: appendUnsubscribeFooter(htmlBody, unsubscribeUrl),
    text: textBody,
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

/**
 * Sends one batch. A failure dead-letters every message in it so the retry
 * worker can replay them — the old route only counted the failure and dropped
 * the content.
 */
async function sendBatch(
  resend: NonNullable<ReturnType<typeof getResendClient>>,
  emails: BroadcastMessage[],
): Promise<{ ok: true; sent: number } | { ok: false; error: string }> {
  try {
    const result = await resend.batch.send(emails);
    if (result.error) {
      throw new Error(result.error.message || "Resend batch error");
    }
    return { ok: true, sent: result.data?.data?.length ?? emails.length };
  } catch (batchError) {
    for (const email of emails) {
      await recordFailedEmail(
        {
          from: email.from,
          to: email.to,
          subject: email.subject,
          html: email.html,
          text: email.text,
        },
        "WAITLIST_BROADCAST",
        batchError,
      );
    }
    return {
      ok: false,
      error: batchError instanceof Error ? batchError.message : "Unknown error",
    };
  }
}

function appendUnsubscribeFooter(html: string, unsubscribeUrl: string): string {
  const footer = `
<div style="text-align:center;margin:30px 0 0;padding:20px 0;border-top:1px solid #eee">
  <p style="font-size:12px;color:#666;margin:10px 0;line-height:1.5">
    &copy; ${new Date().getFullYear()} Familiarise. All rights reserved.
  </p>
  <p style="font-size:12px;color:#666;margin:10px 0;line-height:1.5">
    You received this because you joined the Familiarise waitlist.
    <br/>
    <a href="${unsubscribeUrl}" style="color:#666;text-decoration:underline">Unsubscribe</a>
  </p>
</div>`;

  if (html.includes("</body>"))
    return html.replace("</body>", `${footer}</body>`);
  if (html.includes("</html>"))
    return html.replace("</html>", `${footer}</html>`);
  return html + footer;
}
