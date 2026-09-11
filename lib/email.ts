import * as Sentry from "@sentry/nextjs";
import { Resend } from "resend";
import { WelcomeEmail } from "@/emails/auth/WelcomeEmail";
import { PasswordResetEmail } from "@/emails/auth/PasswordResetEmail";
import { VerificationEmail } from "@/emails/auth/VerificationEmail";
import { AccountLinkedEmail } from "@/emails/auth/AccountLinkedEmail";
import { PaymentLinkEmail } from "@/emails/payments/PaymentLinkEmail";
import { PaymentSuccessEmail } from "@/emails/payments/PaymentSuccessEmail";
import { PaymentFailedEmail } from "@/emails/payments/PaymentFailedEmail";
import { OrgInvitationEmail } from "@/emails/organizations/OrgInvitationEmail";
import { WaitlistConfirmEmail } from "@/emails/waitlist/WaitlistConfirmEmail";
import { WaitlistWelcomeEmail } from "@/emails/waitlist/WaitlistWelcomeEmail";
import { buildConfirmUrl, buildUnsubscribeUrl } from "@/lib/waitlist/tokens";
import { render } from "@react-email/render";
import { getAppUrl } from "@/lib/url";
import prisma from "@/lib/prisma";

// #474 — default sender when a dead-lettered row was persisted without a
// `from` (shouldn't happen — every sender below sets one — but the worker's
// replay needs a non-null fallback). Mirrors the senders' onboarding identity.
export const DEFAULT_FROM_ADDRESS = "Familiarise <onboarding@familiarise.com>";

// #474 — the already-RENDERED message a sender handed to Resend. We persist
// THIS verbatim (not the sender args) so retry is a re-send, not a re-render.
export interface RenderedEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

/**
 * #474 — single persistence point for a transient Resend send failure. Each
 * sender's catch calls this with the message it already built, so a dropped
 * transactional email lands in `FailedEmail` (PENDING, retry-now) for the
 * worker to replay instead of being swallowed by a console.error. Best-effort:
 * a failure here must not change the sender's existing non-throwing contract,
 * so we swallow + log rather than rethrow.
 */
export async function recordFailedEmail(
  message: RenderedEmail,
  emailType: string,
  sendError: unknown,
): Promise<void> {
  // Capture email send failures in Sentry so they surface without requiring
  // a query against the FailedEmail table. Only emailType is tagged — the
  // recipient address is PII and must not appear in Sentry.
  const errObj =
    sendError instanceof Error ? sendError : new Error(String(sendError));
  Sentry.captureException(errObj, {
    tags: { subsystem: "email", emailType },
    level: "warning",
  });

  try {
    await prisma.failedEmail.create({
      data: {
        recipient: message.to,
        fromAddress: message.from,
        replyTo: message.replyTo ?? null,
        subject: message.subject,
        htmlBody: message.html,
        textBody: message.text ?? null,
        emailType,
        status: "PENDING",
        // Retry-now: the worker's first pass picks it up; backoff only kicks
        // in once a replay attempt itself fails.
        nextRetryAt: new Date(),
        lastError:
          sendError instanceof Error ? sendError.message : String(sendError),
      },
    });
  } catch (persistError) {
    // The dead-letter insert itself failed — log and move on. We've already
    // lost the email; taking down the caller too helps no one.
    console.error("[recordFailedEmail] persist failed:", persistError);
  }
}

// Initialize Resend lazily to avoid build-time issues
let resendClient: Resend | null = null;

export function getResendClient(): Resend | null {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;

  if (!RESEND_API_KEY) {
    console.warn(
      "WARNING: RESEND_API_KEY is not defined. Email functionality will not work.",
    );
    return null;
  }

  if (!resendClient) {
    resendClient = new Resend(RESEND_API_KEY);
  }

  return resendClient;
}

// Base URL for app
const baseUrl = getAppUrl();

/**
 * Send welcome email to newly registered user
 * @param params User email, name, and optional custom URL
 * @returns Response from Resend
 */
export async function sendWelcomeEmail({
  email,
  name,
  dashboardUrl = `${baseUrl}/dashboard`,
}: {
  email: string;
  name: string;
  dashboardUrl?: string;
}) {
  // #474 — holds the rendered message so the catch can dead-letter exactly
  // what we tried to send. Undefined until render+build succeeds.
  let sentMessage: RenderedEmail | undefined;
  try {
    const resend = getResendClient();

    // Check if Resend client is available
    if (!resend) {
      console.error(
        "RESEND_API_KEY is not configured. Cannot send welcome email.",
      );
      return {
        success: false,
        error: "Email service not configured",
      };
    }

    // Render email template
    const html = await render(WelcomeEmail({ name, dashboardUrl }));

    // #474 — build the rendered message once so the catch can dead-letter it
    // verbatim (no re-render). Hoisted above resend.emails.send so the catch
    // sees it; a render-stage failure has nothing to replay so it stays null.
    sentMessage = {
      from: "Familiarise <onboarding@familiarise.com>",
      to: email,
      subject: "Welcome to Familiarise!",
      html,
    };

    // Send email
    console.log(
      `Attempting to send welcome email to ${email} from onboarding@familiarise.com`,
    );
    const data = await resend.emails.send(sentMessage);
    // #474 — Resend resolves (does not throw) on API-level errors, returning a
    // non-null `error`. Throw so the catch below dead-letters the message
    // instead of reporting a false success.
    if (data.error) throw new Error(data.error.message || "Resend API error");

    console.log("Resend API response:", data);
    return { success: true, data };
  } catch (error) {
    console.error("Failed to send welcome email:", error);
    // #474 — dead-letter the rendered message so the worker can replay it.
    if (sentMessage) await recordFailedEmail(sentMessage, "WELCOME", error);
    return { success: false, error };
  }
}

/**
 * Send password reset email with reset link
 * @param params User email, name, and reset token
 * @returns Response from Resend
 */
export async function sendPasswordResetEmail({
  email,
  name,
  token,
}: {
  email: string;
  name: string;
  token: string;
}) {
  let sentMessage: RenderedEmail | undefined;
  try {
    const resend = getResendClient();

    if (!resend) {
      console.error(
        "RESEND_API_KEY is not configured. Cannot send password reset email.",
      );
      return {
        success: false,
        error: "Email service not configured",
      };
    }

    const resetLink = `${baseUrl}/auth/reset-password?token=${token}`;
    const html = await render(PasswordResetEmail({ name, resetLink }));

    sentMessage = {
      from: "Familiarise Security <security@familiarise.com>",
      to: email,
      subject: "Reset your Familiarise password",
      html,
    };

    const data = await resend.emails.send(sentMessage);
    // #474 — Resend resolves (does not throw) on API-level errors, returning a
    // non-null `error`. Throw so the catch below dead-letters the message
    // instead of reporting a false success.
    if (data.error) throw new Error(data.error.message || "Resend API error");

    return { success: true, data };
  } catch (error) {
    console.error("Failed to send password reset email:", error);
    // #474 — dead-letter the rendered message so the worker can replay it.
    if (sentMessage)
      await recordFailedEmail(sentMessage, "PASSWORD_RESET", error);
    return { success: false, error };
  }
}

/**
 * Send email-address verification link.
 *
 * `verificationUrl` is the ready-to-use link BetterAuth hands the
 * `emailVerification.sendVerificationEmail` hook (it already carries the token
 * + callbackURL), so we pass it through verbatim rather than rebuilding it.
 *
 * @param params User email, name, and the BetterAuth verification URL
 * @returns Response from Resend
 */
export async function sendVerificationEmail({
  email,
  name,
  verificationUrl,
}: {
  email: string;
  name: string;
  verificationUrl: string;
}) {
  // Dev affordance: when RESEND_API_KEY is unset the email can't send, so log
  // the link to the server console so local verification flows are testable.
  if (!process.env.RESEND_API_KEY) {
    console.log(`[verify-email] ${email} -> ${verificationUrl}`);
  }

  let sentMessage: RenderedEmail | undefined;
  try {
    const resend = getResendClient();

    if (!resend) {
      console.error(
        "RESEND_API_KEY is not configured. Cannot send verification email.",
      );
      return {
        success: false,
        error: "Email service not configured",
      };
    }

    const html = await render(
      VerificationEmail({ name, verificationLink: verificationUrl }),
    );

    sentMessage = {
      from: "Familiarise <onboarding@familiarise.com>",
      to: email,
      subject: "Verify your Familiarise email address",
      html,
    };

    const data = await resend.emails.send(sentMessage);
    // #474 — Resend resolves (does not throw) on API-level errors, returning a
    // non-null `error`. Throw so the catch below dead-letters the message
    // instead of reporting a false success.
    if (data.error) throw new Error(data.error.message || "Resend API error");

    return { success: true, data };
  } catch (error) {
    console.error("Failed to send verification email:", error);
    // #474 — dead-letter the rendered message so the worker can replay it.
    if (sentMessage)
      await recordFailedEmail(sentMessage, "EMAIL_VERIFICATION", error);
    return { success: false, error };
  }
}

/**
 * Send account linked notification email
 * @param params User email, name, OAuth provider, and optional dashboard URL
 * @returns Response from Resend
 */
export async function sendAccountLinkedEmail({
  email,
  name,
  provider,
  dashboardUrl = `${baseUrl}/dashboard`,
}: {
  email: string;
  name: string;
  provider: string;
  dashboardUrl?: string;
}) {
  let sentMessage: RenderedEmail | undefined;
  try {
    const resend = getResendClient();

    if (!resend) {
      console.error(
        "RESEND_API_KEY is not configured. Cannot send account linked email.",
      );
      return {
        success: false,
        error: "Email service not configured",
      };
    }

    const html = await render(
      AccountLinkedEmail({ name, provider, dashboardUrl }),
    );

    sentMessage = {
      from: "Familiarise Security <security@familiarise.com>",
      to: email,
      subject: `Your Familiarise account now linked with ${provider}`,
      html,
    };

    const data = await resend.emails.send(sentMessage);
    // #474 — Resend resolves (does not throw) on API-level errors, returning a
    // non-null `error`. Throw so the catch below dead-letters the message
    // instead of reporting a false success.
    if (data.error) throw new Error(data.error.message || "Resend API error");

    return { success: true, data };
  } catch (error) {
    console.error("Failed to send account linked email:", error);
    // #474 — dead-letter the rendered message so the worker can replay it.
    if (sentMessage)
      await recordFailedEmail(sentMessage, "ACCOUNT_LINKED", error);
    return { success: false, error };
  }
}

/**
 * Send payment link email when consultant approves request
 * @param params Payment details including amount, consultant name, and payment URL
 * @returns Response from Resend
 */
export async function sendPaymentLinkEmail({
  email,
  name,
  consultantName,
  appointmentType,
  amount,
  currency,
  paymentUrl,
  expiresAt,
}: {
  email: string;
  name: string;
  consultantName: string;
  appointmentType: "consultation" | "subscription" | "webinar" | "class";
  amount: number;
  currency: string;
  paymentUrl: string;
  expiresAt: Date;
}) {
  let sentMessage: RenderedEmail | undefined;
  try {
    const resend = getResendClient();

    if (!resend) {
      console.error(
        "RESEND_API_KEY is not configured. Cannot send payment link email.",
      );
      return {
        success: false,
        error: "Email service not configured",
      };
    }

    const html = await render(
      PaymentLinkEmail({
        name,
        consultantName,
        appointmentType,
        amount,
        currency,
        paymentUrl,
        expiresAt: expiresAt.toISOString(),
      }),
    );

    const appointmentLabel =
      appointmentType.charAt(0).toUpperCase() + appointmentType.slice(1);

    sentMessage = {
      from: "Familiarise Payments <payments@familiarise.com>",
      to: email,
      subject: `Payment Required - ${appointmentLabel} with ${consultantName}`,
      html,
    };

    console.log(
      `Sending payment link email to ${email} for ${appointmentType} with ${consultantName}`,
    );

    const data = await resend.emails.send(sentMessage);
    // #474 — Resend resolves (does not throw) on API-level errors, returning a
    // non-null `error`. Throw so the catch below dead-letters the message
    // instead of reporting a false success.
    if (data.error) throw new Error(data.error.message || "Resend API error");

    console.log(
      "Payment link email sent successfully:",
      data.data?.id ?? "unknown",
    );
    return { success: true, data };
  } catch (error) {
    console.error("Failed to send payment link email:", error);
    // #474 — dead-letter the rendered message so the worker can replay it.
    if (sentMessage)
      await recordFailedEmail(sentMessage, "PAYMENT_LINK", error);
    return { success: false, error };
  }
}

/**
 * Send payment success confirmation email
 * @param params Payment confirmation details
 * @returns Response from Resend
 */
export async function sendPaymentSuccessEmail({
  email,
  name,
  consultantName,
  appointmentType,
  amount,
  currency,
  receiptUrl,
  dashboardUrl = `${baseUrl}/dashboard`,
}: {
  email: string;
  name: string;
  consultantName: string;
  appointmentType: "consultation" | "subscription" | "webinar" | "class";
  amount: number;
  currency: string;
  receiptUrl?: string;
  dashboardUrl?: string;
}) {
  let sentMessage: RenderedEmail | undefined;
  try {
    const resend = getResendClient();

    if (!resend) {
      console.error(
        "RESEND_API_KEY is not configured. Cannot send payment success email.",
      );
      return {
        success: false,
        error: "Email service not configured",
      };
    }

    const html = await render(
      PaymentSuccessEmail({
        name,
        consultantName,
        appointmentType,
        amount,
        currency,
        receiptUrl,
        dashboardUrl,
      }),
    );

    const appointmentLabel =
      appointmentType.charAt(0).toUpperCase() + appointmentType.slice(1);

    sentMessage = {
      from: "Familiarise Payments <payments@familiarise.com>",
      to: email,
      subject: `Payment Confirmed - ${appointmentLabel} with ${consultantName}`,
      html,
    };

    console.log(
      `Sending payment success email to ${email} for ${appointmentType} with ${consultantName}`,
    );

    const data = await resend.emails.send(sentMessage);
    // #474 — Resend resolves (does not throw) on API-level errors, returning a
    // non-null `error`. Throw so the catch below dead-letters the message
    // instead of reporting a false success.
    if (data.error) throw new Error(data.error.message || "Resend API error");

    console.log(
      "Payment success email sent successfully:",
      data.data?.id ?? "unknown",
    );
    return { success: true, data };
  } catch (error) {
    console.error("Failed to send payment success email:", error);
    // #474 — dead-letter the rendered message so the worker can replay it.
    if (sentMessage)
      await recordFailedEmail(sentMessage, "PAYMENT_SUCCESS", error);
    return { success: false, error };
  }
}

/**
 * Send payment failure notification email
 * @param params Payment failure details including retry link
 * @returns Response from Resend
 */
export async function sendPaymentFailedEmail({
  email,
  name,
  consultantName,
  appointmentType,
  amount,
  currency,
  retryUrl,
  failureReason = "Payment could not be processed",
  expiresAt,
}: {
  email: string;
  name: string;
  consultantName: string;
  appointmentType: "consultation" | "subscription" | "webinar" | "class";
  amount: number;
  currency: string;
  retryUrl: string;
  failureReason?: string;
  expiresAt?: Date;
}) {
  let sentMessage: RenderedEmail | undefined;
  try {
    const resend = getResendClient();

    if (!resend) {
      console.error(
        "RESEND_API_KEY is not configured. Cannot send payment failed email.",
      );
      return {
        success: false,
        error: "Email service not configured",
      };
    }

    const html = await render(
      PaymentFailedEmail({
        name,
        consultantName,
        appointmentType,
        amount,
        currency,
        retryUrl,
        failureReason,
        expiresAt: expiresAt?.toISOString(),
      }),
    );

    const appointmentLabel =
      appointmentType.charAt(0).toUpperCase() + appointmentType.slice(1);

    sentMessage = {
      from: "Familiarise Payments <payments@familiarise.com>",
      to: email,
      subject: `Payment Failed - ${appointmentLabel} with ${consultantName}`,
      html,
    };

    console.log(
      `Sending payment failed email to ${email} for ${appointmentType} with ${consultantName}`,
    );

    const data = await resend.emails.send(sentMessage);
    // #474 — Resend resolves (does not throw) on API-level errors, returning a
    // non-null `error`. Throw so the catch below dead-letters the message
    // instead of reporting a false success.
    if (data.error) throw new Error(data.error.message || "Resend API error");

    console.log(
      "Payment failed email sent successfully:",
      data.data?.id ?? "unknown",
    );
    return { success: true, data };
  } catch (error) {
    console.error("Failed to send payment failed email:", error);
    // #474 — dead-letter the rendered message so the worker can replay it.
    if (sentMessage)
      await recordFailedEmail(sentMessage, "PAYMENT_FAILED", error);
    return { success: false, error };
  }
}

/**
 * Send organization invitation email
 */
export async function sendOrgInvitationEmail({
  email,
  inviterName,
  orgName,
  role,
  inviteUrl,
  expiresAt,
}: {
  email: string;
  inviterName: string;
  orgName: string;
  role: string;
  inviteUrl: string;
  expiresAt?: string;
}) {
  let sentMessage: RenderedEmail | undefined;
  try {
    const resend = getResendClient();
    if (!resend) {
      console.error(
        "RESEND_API_KEY not configured. Cannot send org invitation email.",
      );
      return { success: false, error: "Email service not configured" };
    }

    const html = await render(
      OrgInvitationEmail({ inviterName, orgName, role, inviteUrl, expiresAt }),
    );

    sentMessage = {
      from: "Familiarise <notifications@familiarise.com>",
      to: email,
      subject: `You're invited to join ${orgName} on Familiarise`,
      html,
    };

    const data = await resend.emails.send(sentMessage);
    // #474 — Resend resolves (does not throw) on API-level errors, returning a
    // non-null `error`. Throw so the catch below dead-letters the message
    // instead of reporting a false success.
    if (data.error) throw new Error(data.error.message || "Resend API error");

    console.log(`Org invitation email sent to ${email}:`, data);
    return { success: true, data };
  } catch (error) {
    console.error("Failed to send org invitation email:", error);
    // #474 — dead-letter the rendered message so the worker can replay it.
    if (sentMessage)
      await recordFailedEmail(sentMessage, "ORG_INVITATION", error);
    return { success: false, error };
  }
}

// ============================================================================
// Newsletter
// ============================================================================

const NEWSLETTER_FROM_ADDRESS = "Familiarise <newsletter@familiarise.com>";

/**
 * Double opt-in confirmation. The link carries its own issue time so it can
 * expire without a token column — see lib/waitlist/tokens.ts.
 */
export async function sendWaitlistConfirmEmail({
  email,
  name,
  issuedAt,
}: {
  email: string;
  name?: string | null;
  issuedAt: number;
}) {
  let sentMessage: RenderedEmail | undefined;
  try {
    // Signing lives inside the boundary: it throws when
    // WAITLIST_HMAC_SECRET is unset in production, and a sender must never
    // throw into its caller.
    const confirmLink = buildConfirmUrl(email, issuedAt);

    // Dev affordance so the flow is testable without a Resend key. Gated on
    // NODE_ENV, not on the key being absent: a misconfigured production would
    // otherwise print a live confirmation link, and that link is a bearer
    // token — anyone reading the logs could confirm the address.
    if (process.env.NODE_ENV === "development") {
      console.log(`[waitlist-confirm] ${email} -> ${confirmLink}`);
    }

    const resend = getResendClient();
    if (!resend) {
      return { success: false, error: "Email service not configured" };
    }

    const html = await render(WaitlistConfirmEmail({ name, confirmLink }));

    sentMessage = {
      from: NEWSLETTER_FROM_ADDRESS,
      to: email,
      subject: "Confirm your Familiarise subscription",
      html,
    };

    const data = await resend.emails.send(sentMessage);
    if (data.error) throw new Error(data.error.message || "Resend API error");

    return { success: true, data };
  } catch (error) {
    console.error("Failed to send waitlist confirmation email:", error);
    if (sentMessage)
      await recordFailedEmail(sentMessage, "WAITLIST_CONFIRM", error);
    return { success: false, error };
  }
}

/** Sent once the confirm link is clicked. */
export async function sendWaitlistWelcomeEmail({
  email,
  name,
}: {
  email: string;
  name?: string | null;
}) {
  let sentMessage: RenderedEmail | undefined;
  try {
    const resend = getResendClient();
    if (!resend) {
      return { success: false, error: "Email service not configured" };
    }

    const unsubscribeLink = buildUnsubscribeUrl(email);
    const html = await render(WaitlistWelcomeEmail({ name, unsubscribeLink }));

    sentMessage = {
      from: NEWSLETTER_FROM_ADDRESS,
      to: email,
      subject: "You are on the Familiarise waitlist",
      html,
    };

    const data = await resend.emails.send(sentMessage);
    if (data.error) throw new Error(data.error.message || "Resend API error");

    return { success: true, data };
  } catch (error) {
    console.error("Failed to send waitlist welcome email:", error);
    if (sentMessage)
      await recordFailedEmail(sentMessage, "WAITLIST_WELCOME", error);
    return { success: false, error };
  }
}

/**
 * #1132 — contact / enterprise-sales inquiry.
 *
 * The /contactus form previously had no submit handler and no route behind it:
 * every inquiry, including every enterprise lead the /enterprise CTAs sent
 * there, was silently discarded. This routes them to the ops inbox with the
 * sender on Reply-To, and inherits the FailedEmail retry path so a transient
 * Resend outage does not lose the lead.
 */
export async function sendContactInquiryEmail({
  firstName,
  lastName,
  email,
  phone,
  subject,
  message,
  category,
}: {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string | null;
  subject: string;
  message: string;
  category?: string | null;
}) {
  let sentMessage: RenderedEmail | undefined;
  try {
    const to = process.env.CONTACT_INBOX_ADDRESS || "support@familiarise.com";
    const name = `${firstName} ${lastName}`.trim();
    const esc = (s: string) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    const rows: Array<[string, string]> = [
      ["Name", name],
      ["Email", email],
      ["Phone", phone || "—"],
      ["Category", category || "—"],
      ["Subject", subject],
    ];

    const html = `
      <h2>New contact inquiry</h2>
      <table cellpadding="6" style="border-collapse:collapse">
        ${rows
          .map(
            ([k, v]) =>
              `<tr><td style="font-weight:600">${esc(k)}</td><td>${esc(v)}</td></tr>`,
          )
          .join("")}
      </table>
      <h3>Message</h3>
      <p style="white-space:pre-wrap">${esc(message)}</p>
    `;

    sentMessage = {
      from: DEFAULT_FROM_ADDRESS,
      to,
      subject: `[Contact] ${subject}`,
      html,
      // Ops replies go straight to the person who wrote in.
      replyTo: email,
    };

    // #1132 — the client lookup happens AFTER the message is built, so an
    // unconfigured Resend still lands the inquiry in FailedEmail for the retry
    // worker. Returning before `sentMessage` existed meant the catch could not
    // record it, and a missing key silently discarded the lead — contradicting
    // what app/api/contact/route.ts tells the sender.
    const resend = getResendClient();
    if (!resend) {
      throw new Error("Email service not configured");
    }

    const data = await resend.emails.send(sentMessage);
    if (data.error) throw new Error(data.error.message || "Resend API error");

    return { success: true, data };
  } catch (error) {
    console.error("Failed to send contact inquiry email:", error);
    if (sentMessage)
      await recordFailedEmail(sentMessage, "CONTACT_INQUIRY", error);
    return { success: false, error };
  }
}
