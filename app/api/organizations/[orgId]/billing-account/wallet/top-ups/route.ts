/**
 * GET  /api/organizations/[orgId]/billing-account/wallet/top-ups
 * POST /api/organizations/[orgId]/billing-account/wallet/top-ups
 *
 * POST mints two correlated ids:
 *   1. `topUpId` (`we_<uuid>`) — our wallet-entry idempotency key,
 *      stored as `WalletEntry.providerOrderId @unique` and used as the
 *      URL parameter for `GET /top-ups/{topUpId}` polling.
 *   2. `razorpayOrderId` (`order_<…>`) — the gateway-side order minted
 *      by `createRazorpayOrder`. The dashboard opens Razorpay checkout
 *      with this id; Razorpay echoes the order's `notes` back on
 *      capture, so the webhook handler at /api/webhooks/razorpay (see
 *      `handleOrgPaymentSuccess`) reads `notes.type ===
 *      "credit_purchase"` + `notes.walletEntryOrderId` and calls
 *      `confirmTopUp` to settle the entry into a real balance increase.
 *
 * Idempotency: WalletEntry.providerOrderId @unique guarantees two
 * concurrent POSTs can't both mint an entry for the same client token,
 * and webhook redelivery can't double-credit the wallet.
 *
 * When RAZORPAY_KEY_ID/SECRET are missing (preview / CI / dev without
 * gateway), the route returns 503 so the client can surface a
 * "payment gateway not configured" message instead of pretending
 * money was charged.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
// Why: wallet top-ups mint external Razorpay/Stripe orders — finance-team
// action. BILLING_ADMIN should be able to fund the wallet without
// escalating to OWNER. The existing pre-Arch-4 comment above said
// "with the person who pays the bill", which is now BILLING_ADMIN.
import { requireOrgBillingAdminOrOwner } from "@/lib/auth/billing-admin-gate";
import { initiateTopUp } from "@/lib/api/organizations/wallet";
import { Prisma } from "@prisma/client";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { createRazorpayOrder } from "@/lib/payments/core/razorpay";
import { PaymentError } from "@/lib/payments/core/types";

const TopUpBodySchema = z.object({
  // Minimum top-up of ₹100 (10000 paise) so gateway fees don't dwarf
  // the credit. No hard maximum — enterprise orgs routinely top up
  // in lakhs; we rely on the admin-role gate to authorize.
  amountPaise: z.coerce.number().int().min(10_000),
  // Optional idempotency key from the client. If supplied, reuse a
  // pending WalletEntry instead of minting a new Razorpay order on
  // a double-click.
  clientIdempotencyKey: z.string().min(8).max(128).optional(),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { permission: "billing.read", canSponsor: true });
  if (access.error) return access.error;

  const ba = await prisma.billingAccount.findFirst({
    where: { ownerOrgId: orgId },
    select: { id: true, fundingSource: true },
  });
  if (!ba || ba.fundingSource !== "WALLET") {
    return NextResponse.json(
      { error: "Wallet top-ups require WALLET funding" },
      { status: 404 },
    );
  }

  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const perPage = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("perPage") ?? 20)),
  );

  const where = { billingAccountId: ba.id };
  const [total, topUps] = await prisma.$transaction([
    prisma.walletTopUp.count({ where }),
    prisma.walletTopUp.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ]);

  return NextResponse.json({
    data: topUps,
    meta: { total, page, perPage },
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  // OWNER-only: top-up moves real money. A MAINTAINER can queue
  // invites and edit programs, but spinning up an external Razorpay
  // charge should live with the person who pays the bill.
  // Also gated on org status=ACTIVE — a pre-verification org cannot
  // charge a card, so we reject before minting a Razorpay order.
  const access = await requireOrgBillingAdminOrOwner(orgId, {
    canSponsor: true,
    requireActive: true,
  });
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = TopUpBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { amountPaise, clientIdempotencyKey } = parsed.data;

  const ba = await prisma.billingAccount.findFirst({
    where: { ownerOrgId: orgId },
  });
  if (!ba) {
    return NextResponse.json(
      { error: "Organization does not have a BillingAccount" },
      { status: 404 },
    );
  }
  if (ba.fundingSource !== "WALLET") {
    return NextResponse.json(
      { error: "Top-ups are only allowed on WALLET funding" },
      { status: 409 },
    );
  }

  // Idempotent by client key: reuse an open pending entry instead of
  // minting a second Razorpay order on a duplicate POST. The
  // WalletEntry row itself is keyed by providerOrderId (@unique), so
  // even without the client key a retry of the same physical request
  // can't create a duplicate. If we already minted a Razorpay order
  // for this entry, persist the gateway order id alongside the entry
  // (in notes/`razorpayOrderId`) so the client can resume checkout
  // without us minting a fresh order on the gateway side.
  if (clientIdempotencyKey) {
    const existing = await prisma.walletTopUp.findUnique({
      where: { providerOrderId: clientIdempotencyKey },
      select: { providerOrderId: true, billingAccount: { select: { ownerOrgId: true } } },
    });
    if (existing) {
      // Cross-tenant guard: providerOrderId is globally unique, so without
      // this check org B could probe the existence of org A's pending
      // top-up ids (reused:true vs 201) — or pre-claim a predictable key and
      // block the victim's funding POST entirely. A collision with another
      // org's key is a conflict, not a reuse.
      if (existing.billingAccount.ownerOrgId !== orgId) {
        return NextResponse.json(
          { error: "A top-up with this idempotency key already exists" },
          { status: 409 },
        );
      }
      // We can't retrieve the original Razorpay order id here without
      // a dedicated column, so a "resume" path requires a fresh order.
      // To stay strictly idempotent, surface the existing pending entry
      // and instruct the client to retry without the same key.
      return NextResponse.json(
        {
          topUpId: existing.providerOrderId,
          amountPaise,
          status: "pending",
          reused: true,
          error:
            "A top-up with this idempotency key already exists. Retry without the key to launch a new gateway order.",
        },
        { status: 200 },
      );
    }
  }

  const walletEntryOrderId =
    clientIdempotencyKey ?? `we_${randomUUID().replace(/-/g, "")}`;

  // Order of operations (fixes "orphaned gateway order" leak):
  //   (1) Persist the pending WalletEntry placeholder FIRST — if
  //       something later fails, we know this DB row exists and the
  //       abandoned-top-ups cleanup cron can reap it.
  //   (2) Mint the Razorpay order SECOND. If this fails, delete the
  //       placeholder (no gateway side-effect to compensate).
  //   (3) Append the `razorpay_order=<id>` to notes so operators can
  //       trace the placeholder back to the gateway order.
  //
  // The previous order (create Razorpay order → persist WalletEntry)
  // leaked orders into Razorpay whenever the DB write failed, and the
  // gateway order would linger until its 24h TTL with no DB trace.
  try {
    await prisma.$transaction(async (tx) => {
      await initiateTopUp(tx, {
        billingAccountId: ba.id,
        amountPaise,
        providerOrderId: walletEntryOrderId,
        notes: `Top-up initiated by membership ${access.member.id}; razorpay_order=pending`,
      });
    });
  } catch (err) {
    // #1205-triage — the preflight lookup is not atomic with this insert. If
    // a concurrent request from ANY org claimed the same global key between
    // our lookup and here, the insert dies with P2002. Re-run the
    // ownership-aware lookup: same-org → surface as reuse; cross-org → 409.
    // Falling through to the generic error path would leak a 500 where a
    // deterministic idempotency answer exists.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const winner = await prisma.walletTopUp.findUnique({
        where: { providerOrderId: walletEntryOrderId },
        select: { providerOrderId: true, billingAccount: { select: { ownerOrgId: true } } },
      });
      if (winner?.billingAccount.ownerOrgId === orgId) {
        return NextResponse.json(
          {
            topUpId: winner.providerOrderId,
            amountPaise,
            status: "pending",
            reused: true,
            error:
              "A top-up with this idempotency key already exists. Retry without the key to launch a new gateway order.",
          },
          { status: 200 },
        );
      }
      return NextResponse.json(
        { error: "A top-up with this idempotency key already exists" },
        { status: 409 },
      );
    }
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "enterprise" } });
    console.error(
      "[wallet/top-ups] placeholder WalletEntry persistence failed:",
      err,
    );
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to record pending top-up",
      },
      { status: 500 },
    );
  }

  let razorpayOrderId: string;
  try {
    const order = await createRazorpayOrder({
      amount: amountPaise,
      currency: ba.currency,
      paymentGateway: "RAZORPAY",
      // PaymentIntentParams.metadata insists on appointmentId/Type for
      // booking flows; org-level payments don't have an appointment so
      // we pass empty strings. The webhook routes purely off
      // `notes.type === "credit_purchase"`, never on appointment fields.
      metadata: {
        appointmentId: "",
        appointmentType: "",
        type: "credit_purchase",
        walletEntryOrderId,
        organizationId: orgId,
        billingAccountId: ba.id,
        // amountPaise duplicated in notes so the webhook can pass it
        // to confirmTopUp without a separate DB lookup.
        amountPaise: String(amountPaise),
      },
    });
    razorpayOrderId = order.id;
  } catch (err) {
    // Razorpay refused — reap the placeholder so abandoned-cleanup
    // doesn't have to. If this delete fails too, the cron will eventually
    // pick it up; the user sees a clean error either way.
    await prisma.walletTopUp
      .delete({ where: { providerOrderId: walletEntryOrderId } })
      .catch((cleanupErr) =>
        console.error(
          "[wallet/top-ups] failed to reap orphan WalletTopUp:",
          cleanupErr,
        ),
      );
    if (err instanceof PaymentError && err.code === "RAZORPAY_NOT_INITIALIZED") {
      Sentry.logger.warn("[wallet/top-ups] payment gateway not configured", { tags: { subsystem: "enterprise" } });
      return NextResponse.json(
        {
          error:
            "Payment gateway not configured. Set RAZORPAY_KEY_ID and RAZORPAY_SECRET to enable top-ups.",
          errorType: err.code,
        },
        { status: 503 },
      );
    }
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "enterprise" } });
    console.error("[wallet/top-ups] createRazorpayOrder failed:", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to initiate Razorpay order",
        errorType:
          err instanceof PaymentError ? err.code : "RAZORPAY_ORDER_FAILED",
      },
      { status: 502 },
    );
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.walletTopUp.update({
        where: { providerOrderId: walletEntryOrderId },
        data: {
          notes: `Top-up initiated by membership ${access.member.id}; razorpay_order=${razorpayOrderId}`,
        },
      });
      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "WALLET",
          action: AUDIT_ACTIONS.WALLET.WALLET_TOPUP,
          description: `Top-up initiated: ₹${(amountPaise / 100).toLocaleString("en-IN")}`,
          details: {
            walletEntryOrderId,
            razorpayOrderId,
            amountPaise,
          },
        },
      });
    });
  } catch (err) {
    // Notes/audit-log write failed, but the WalletEntry already exists
    // and the Razorpay order is live — the top-up will still settle on
    // webhook capture. Return 201 and log for operators.
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "enterprise" } });
    console.error(
      "[wallet/top-ups] notes/audit-log write failed (top-up still valid):",
      err,
    );
  }

  return NextResponse.json(
    {
      // `topUpId` is our wallet-entry idempotency key (`we_<uuid>`) —
      // the same value used as `WalletEntry.providerOrderId` and as the
      // URL parameter for `GET /top-ups/{topUpId}` polling.
      topUpId: walletEntryOrderId,
      // `razorpayOrderId` (`order_<…>`) drives Razorpay checkout
      // (`new Razorpay({ order_id })`); Razorpay echoes the order's
      // `notes` back on capture so the webhook can route the
      // confirmation without the client forwarding anything itself.
      razorpayOrderId,
      keyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
      amountPaise,
      currency: ba.currency,
      status: "pending",
      reused: false,
    },
    { status: 201 },
  );
}
