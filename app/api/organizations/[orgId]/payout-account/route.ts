/**
 * GET /api/organizations/[orgId]/payout-account
 * PUT /api/organizations/[orgId]/payout-account
 *
 * Hosting-side bank/payout credentials (canHost=true orgs). The record is
 * 1:1 with Organization — a PUT either creates or updates. Full account
 * numbers are encrypted before storage; the public-readable last-four and
 * status flow is what UI surfaces render.
 *
 * Verification lifecycle (`status`) moves PENDING_VERIFICATION → VERIFIED
 * through a side-channel (Razorpay contact + fund-account creation). This
 * endpoint only writes the raw record; the verification job flips status.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess, requireOrgOwner } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { encodeAccountEnvelope } from "@/lib/payments/payouts/account-crypto";
import {
  getRazorpayPayoutsService,
  isRazorpayPayoutsConfigured,
} from "@/lib/payments/payouts/razorpay-payouts";
import { transitionOrgPayoutAccount } from "@/lib/enterprise/transitions";

const UpsertBodySchema = z.object({
  accountHolderName: z.string().min(1).max(200),
  // Full account number — stored encrypted. Last-four is derived.
  accountNumber: z.string().min(4).max(34),
  bankName: z.string().min(1).max(120),
  ifscCode: z.string().length(11).optional(),
  routingNumber: z.string().min(1).max(20).nullable().optional(),
  swiftCode: z.string().min(8).max(11).nullable().optional(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "MANAGER");
  if (access.error) return access.error;

  if (!access.org.canHost) {
    return NextResponse.json(
      { error: "Organization does not host (canHost=false)" },
      { status: 404 },
    );
  }

  const payoutAccount = await prisma.organizationPayoutAccount.findUnique({
    where: { organizationId: orgId },
    select: {
      id: true,
      accountHolderName: true,
      accountNumberLast4: true,
      bankName: true,
      ifscCode: true,
      routingNumber: true,
      swiftCode: true,
      stripeConnectId: true,
      razorpayContactId: true,
      razorpayFundAccountId: true,
      status: true,
      verifiedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!payoutAccount) {
    return NextResponse.json(
      { payoutAccount: null, exists: false },
      { status: 200 },
    );
  }
  return NextResponse.json({ payoutAccount, exists: true });
}

/**
 * S3776 — provisioning + penny-drop extracted from the PUT handler. Behavior
 * unchanged: demote VERIFIED before re-provisioning, create contact/fund
 * account, penny-drop, bind ids to the bank-detail revision, and verify via
 * the guarded CAS on "valid". All failures are non-fatal by design.
 */
async function provisionAndVerifyOrgPayoutAccount(ctx: {
  orgId: string;
  actorMembershipId: string;
  upsertedId: string;
  upsertedVersion: number;
  currentStatus: string;
  accountHolderName: string;
  billingEmail: string;
  ifscCode: string | null;
  accountNumber: string;
  last4: string;
}): Promise<void> {
  const {
    orgId,
    actorMembershipId,
    upsertedId,
    upsertedVersion,
    currentStatus,
    accountHolderName,
    billingEmail,
    ifscCode,
    accountNumber,
    last4,
  } = ctx;
  if (!isRazorpayPayoutsConfigured() || !ifscCode) return;

  // A re-provisioning attempt must not leave the row VERIFIED while its new
  // fund account is still unproven: demote first (VERIFIED→PENDING is a
  // legal edge), then provision.
  if (currentStatus === "VERIFIED") {
    await prisma.$transaction(async (tx) => {
      await transitionOrgPayoutAccount(tx, {
        where: { id: upsertedId, version: upsertedVersion },
        to: "PENDING_VERIFICATION",
        data: { verifiedAt: null },
      });
    });
  }
  try {
    const svc = getRazorpayPayoutsService();
    const contact = await svc.createContact({
      name: accountHolderName,
      email: billingEmail,
      type: "vendor",
      referenceId: orgId,
    });
    const fund = await svc.createFundAccount({
      contactId: contact.id,
      accountType: "bank_account",
      bankAccount: {
        name: accountHolderName,
        ifsc: ifscCode,
        accountNumber,
      },
    });
    const validation = await svc.validateBankAccount(fund.id);

    // Bind BOTH writes to the bank-detail revision this request created: a
    // second PUT landing while our Razorpay calls are in flight must never
    // receive stale ids or an unearned VERIFIED stamp.
    await prisma.organizationPayoutAccount.updateMany({
      where: { id: upsertedId, version: upsertedVersion },
      data: {
        razorpayContactId: contact.id,
        razorpayFundAccountId: fund.id,
      },
    });
    if (validation.accountStatus === "valid") {
      await prisma.$transaction(async (tx) => {
        await transitionOrgPayoutAccount(tx, {
          where: { id: upsertedId, version: upsertedVersion },
          to: "VERIFIED",
          data: { verifiedAt: new Date() },
          audit: {
            organizationId: orgId,
            actorMembershipId,
            category: "SETTINGS",
            action: AUDIT_ACTIONS.SETTINGS.SETTINGS_CHANGED,
            description: "Payout account verified via RazorpayX penny-drop",
            details: { fundAccountId: fund.id, last4 },
          },
        });
      });
    }
  } catch (err) {
    // Non-fatal: bank-detail upsert succeeded; verification retries later.
    console.error("[org-payout-account] penny-drop error:", err);
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  if (!access.org.canHost) {
    return NextResponse.json(
      {
        error: "Organization does not host. Enable canHost before setting a payout account.",
      },
      { status: 409 },
    );
  }

  const raw = await req.json().catch(() => null);
  const parsed = UpsertBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const last4 = body.accountNumber.slice(-4);
  let encrypted: string;
  try {
    encrypted = encodeAccountEnvelope(body.accountNumber);
  } catch (err) {
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "organizations" } });
    return NextResponse.json(
      {
        error: "Payout encryption is not configured on this server",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }

  const upserted = await prisma.$transaction(async (tx) => {
    const existing = await tx.organizationPayoutAccount.findUnique({
      where: { organizationId: orgId },
    });

    // Changing bank details resets verification. A different account
    // number means the side-channel verification artifacts no longer
    // correspond to this record.
    const next = await tx.organizationPayoutAccount.upsert({
      where: { organizationId: orgId },
      create: {
        organizationId: orgId,
        accountHolderName: body.accountHolderName,
        accountNumberEncrypted: encrypted,
        accountNumberLast4: last4,
        bankName: body.bankName,
        ifscCode: body.ifscCode ?? null,
        routingNumber: body.routingNumber ?? null,
        swiftCode: body.swiftCode ?? null,
        status: "PENDING_VERIFICATION",
      },
      update: {
        accountHolderName: body.accountHolderName,
        accountNumberEncrypted: encrypted,
        accountNumberLast4: last4,
        bankName: body.bankName,
        ifscCode: body.ifscCode ?? null,
        routingNumber: body.routingNumber ?? null,
        swiftCode: body.swiftCode ?? null,
        // CR #1234 r3.5 — each PUT revision gets a distinct version, or the
        // id+version CAS predicates below cannot tell revisions apart.
        version: { increment: 1 },
        // Force re-verification on any verification-relevant change (CR
        // #1234 r2 — holder name and IFSC identify the destination as much
        // as the last-4 does; comparing last4 alone let a same-last-4
        // different-bank edit keep a stale VERIFIED stamp).
        ...(existing &&
        (existing.accountNumberLast4 !== last4 ||
          existing.accountHolderName !== body.accountHolderName ||
          (existing.ifscCode ?? null) !== (body.ifscCode ?? null))
          ? {
              status: "PENDING_VERIFICATION" as const,
              verifiedAt: null,
              razorpayContactId: null,
              razorpayFundAccountId: null,
            }
          : {}),
      },
    });

    await tx.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        category: "SETTINGS",
        action: AUDIT_ACTIONS.SETTINGS.SETTINGS_CHANGED,
        description: existing
          ? "Payout account updated"
          : "Payout account created",
        details: {
          accountLast4: last4,
          bankName: body.bankName,
          ifscCode: body.ifscCode ?? null,
          verificationReset: existing?.accountNumberLast4 !== last4,
        },
      },
    });

    return next;
  });

  // #1230 — wire the dormant verification loop (see helper below).
  await provisionAndVerifyOrgPayoutAccount({
    orgId,
    actorMembershipId: access.member.id,
    upsertedId: upserted.id,
    upsertedVersion: upserted.version,
    currentStatus: upserted.status,
    accountHolderName: body.accountHolderName,
    billingEmail: access.org.billingEmail ?? "",
    ifscCode: body.ifscCode ?? null,
    accountNumber: body.accountNumber,
    last4,
  });

  // CR #1234 r2 — respond with the POST-verification row: the transition
  // above may have flipped status/verifiedAt after `upserted` was read.
  const fresh = await prisma.organizationPayoutAccount.findUniqueOrThrow({
    where: { organizationId: orgId },
  });

  return NextResponse.json(
    {
      payoutAccount: {
        id: fresh.id,
        accountHolderName: fresh.accountHolderName,
        accountNumberLast4: fresh.accountNumberLast4,
        bankName: fresh.bankName,
        ifscCode: fresh.ifscCode,
        routingNumber: fresh.routingNumber,
        swiftCode: fresh.swiftCode,
        status: fresh.status,
        verifiedAt: fresh.verifiedAt,
        createdAt: fresh.createdAt,
        updatedAt: fresh.updatedAt,
      },
    },
    { status: 200 },
  );
}
