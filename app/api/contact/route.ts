/**
 * POST /api/contact
 *
 * #1132 — the lead-capture endpoint the /contactus form never had. Both
 * /enterprise CTAs point at that form, so until this existed every enterprise
 * lead was discarded by the browser's default form submit.
 *
 * Public and unauthenticated by necessity — a prospect has no account yet — so
 * it carries the same protections as the other public write endpoints: a
 * per-IP rate limit, a honeypot, and strict length caps. Delivery failures fall
 * through to the FailedEmail retry worker rather than being swallowed.
 */

import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { sendContactInquiryEmail } from "@/lib/email";
import { applyRateLimit, getClientIp, spamLimiter } from "@/lib/rate-limit";
import { INQUIRY_CATEGORIES } from "@/app/(pages)/constants";

const CATEGORY_VALUES = INQUIRY_CATEGORIES.map((c) => c.value);

const ContactBodySchema = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(100),
  lastName: z.string().trim().min(1, "Last name is required").max(100),
  email: z.string().trim().email("Enter a valid email address").max(320),
  phone: z.string().trim().max(30).optional().or(z.literal("")),
  subject: z.string().trim().min(1, "Subject is required").max(200),
  message: z.string().trim().min(1, "Message is required").max(5000),
  category: z
    .string()
    .refine(
      (v) => CATEGORY_VALUES.includes(v as (typeof CATEGORY_VALUES)[number]),
      {
        message: "Unknown inquiry category",
      },
    )
    .optional()
    .or(z.literal("")),
  // Honeypot: a real person never fills a hidden field. Bots fill everything.
  // Present in the payload but never rendered visibly.
  //
  // #1132 — deliberately NOT `.max(0)`. Rejecting a populated value at the
  // schema meant a tripped honeypot returned 400 while a clean submit returned
  // 202, which is exactly the signal the silent-success branch below exists to
  // deny a bot. Accept it here, discard it after parsing.
  website: z.string().max(200).optional(),
});

export async function POST(req: NextRequest) {
  // #1132 — use the shared helper: it prefers Netlify's canonical
  // x-nf-client-connection-ip over the caller-supplied x-forwarded-for, so a
  // spoofed header cannot vary the bucket key per request.
  const ip = getClientIp(req);

  const rl = await applyRateLimit(spamLimiter, `contact:${ip}`);
  if (rl) return rl;

  const raw = await req.json().catch(() => null);
  const parsed = ContactBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Please correct the highlighted fields.",
        fieldErrors: parsed.error.flatten().fieldErrors,
      },
      { status: 400 },
    );
  }

  // Honeypot tripped — respond exactly as we would on success so the bot gets
  // no signal, but do not send anything.
  if (parsed.data.website) {
    return NextResponse.json({ ok: true }, { status: 202 });
  }

  // #1230 wave-4b — enterprise funnel persistence. The #1132 blocker-6
  // class was "email is the only record": a Resend outage discarded the
  // deal entirely. Enterprise/team-training inquiries now land in the Lead
  // table FIRST; the email is notification, not the system of record.
  const LEAD_CATEGORIES = new Set(["enterprise", "team-training"]);
  if (LEAD_CATEGORIES.has(parsed.data.category ?? "")) {
    // CR #1243 — idempotent lead capture. The key is a digest of the
    // submission content itself, so a user retrying after a 502 (or a
    // double-click) lands on the unique constraint and answers 202 against
    // the EXISTING row — no duplicate sales records, no client changes.
    // Canonical JSON of EVERY persisted field + a UTC day bucket: unambiguous
    // (no delimiter collisions) and time-scoped, so a genuine follow-up days
    // later creates a fresh lead while transport retries stay idempotent.
    const dayBucket = new Date().toISOString().slice(0, 10);
    const submissionKey = createHash("sha256")
      .update(
        JSON.stringify([
          dayBucket,
          parsed.data.email.toLowerCase(),
          parsed.data.firstName,
          parsed.data.lastName,
          parsed.data.phone ?? "",
          parsed.data.subject,
          parsed.data.message,
          parsed.data.category ?? "",
        ]),
      )
      .digest("hex");
    try {
      await prisma.lead.create({
        data: {
          submissionKey,
          sourceCategory: parsed.data.category ?? "",
          companyName: null,
          contactName: `${parsed.data.firstName} ${parsed.data.lastName}`.trim(),
          contactEmail: parsed.data.email,
          phone: parsed.data.phone || null,
          subject: parsed.data.subject,
          message: parsed.data.message,
        },
      });
    } catch (err) {
      if (
        !(
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        )
      ) {
        throw err;
      }
      // Duplicate of an existing lead — still answer success so the retry
      // loop terminates.
    }
  }

  const result = await sendContactInquiryEmail({
    firstName: parsed.data.firstName,
    lastName: parsed.data.lastName,
    email: parsed.data.email,
    phone: parsed.data.phone || null,
    subject: parsed.data.subject,
    message: parsed.data.message,
    category: parsed.data.category || null,
  });

  if (!result.success) {
    // The send already recorded a FailedEmail row for the retry worker, so the
    // lead is not lost — but the sender should know it was not delivered yet.
    return NextResponse.json(
      {
        error:
          "We could not send your message right now. Please email us directly and we will pick it up.",
      },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true }, { status: 202 });
}
