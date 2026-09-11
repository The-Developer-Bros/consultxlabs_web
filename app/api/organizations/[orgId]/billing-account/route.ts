/**
 * GET   /api/organizations/[orgId]/billing-account
 * PATCH /api/organizations/[orgId]/billing-account
 *
 * One BillingAccount per sponsoring org. This endpoint manages the
 * top-level account record — funding source, billing email, credit
 * limit. The wallet ledger lives under /wallet, invoices under
 * /invoices, purchase orders under /purchase-orders.
 *
 * A funding-source change is a serious lifecycle event — it switches
 * which downstream flow runs at checkout (WALLET→wallet debit,
 * INVOICE→accrual, LICENSE→no charge). Only OWNERs can change it, and
 * we only allow the change when there are no outstanding invoices or
 * non-zero wallet balance that would be orphaned.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
// Why: PATCH on the billing account (funding-source / credit-limit edits)
// is a finance-team action, not an org-admin one. The shared
// `requireOrgBillingAdminOrOwner` helper allows OWNER and BILLING_ADMIN
// only — explicitly NOT MAINTAINER — so the gate matches the role
// description in `lib/labels/org-labels.ts`.
import { requireOrgBillingAdminOrOwner } from "@/lib/auth/billing-admin-gate";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { assertVerifiedDomainOrThrow } from "@/lib/enterprise/governance";

// PROJECT is reserved in the Prisma enum for v2 project-billing; the
// API layer rejects it so callers can't quietly land a BillingAccount
// shape checkout can't honour. See note in app/api/organizations/route.ts.
const FundingSourceSchema = z.enum([
  "PERSONAL",
  "LICENSE",
  "WALLET",
  "INVOICE",
]);

// #1396 — the `Currency` enum stays on the column (ADR 15 keeps the type), but
// this API refuses to write anything except INR. `BillingAccount.currency` is
// forwarded verbatim into `createRazorpayOrder` by the wallet top-up route, and
// every amount the platform stores is INR paise, so a USD account priced a
// ₹1,000 top-up as a $1,000 order.
const CurrencySchema = z.literal("INR");

// #777 §C — wallet minimum-balance + auto-top-up config. NOTIFY-ONLY floor for
// now (cron emails finance below the minimum); the mandate charge lands later.
const PatchBodySchema = z
  .object({
    billingEmail: z.string().email().optional(),
    currency: CurrencySchema.optional(),
    fundingSource: FundingSourceSchema.optional(),
    creditLimit: z.coerce.number().int().min(0).nullable().optional(),
    minBalancePaise: z.coerce.number().int().min(0).nullable().optional(),
    autoTopUpEnabled: z.boolean().optional(),
    autoTopUpAmountPaise: z.coerce.number().int().positive().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "PATCH body must contain at least one field",
  });

// #777 §C — the three wallet-alert fields are only meaningful for WALLET
// funding; presence of any lets the handler reject non-WALLET accounts.
const WALLET_ALERT_FIELDS = [
  "minBalancePaise",
  "autoTopUpEnabled",
  "autoTopUpAmountPaise",
] as const;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { permission: "billing.read", canSponsor: true });
  if (access.error) return access.error;

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      billingAccount: {
        include: {
          subscription: true,
          _count: {
            select: {
              invoices: true,
              contracts: true,
              walletTopUps: true,
            },
          },
        },
      },
    },
  });
  if (!org?.billingAccount) {
    return NextResponse.json(
      { error: "Organization does not have a BillingAccount (canSponsor=false)" },
      { status: 404 },
    );
  }
  return NextResponse.json({ billingAccount: org.billingAccount });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgBillingAdminOrOwner(orgId, { canSponsor: true });
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = PatchBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const ba = await tx.billingAccount.findFirst({
        where: { ownerOrgId: orgId },
      });
      if (!ba) {
        throw Object.assign(
          new Error(
            "Organization does not have a BillingAccount. Enable canSponsor first.",
          ),
          { httpStatus: 404 },
        );
      }

      // #777 §C — wallet-alert config guards. The effective funding source
      // is the incoming one if being changed, else the stored one. These
      // fields only apply to WALLET funding, and enabling auto-top-up needs
      // both the floor and the charge amount set so the cron has a target.
      const walletAlertTouched = WALLET_ALERT_FIELDS.some(
        (f) => body[f] !== undefined,
      );
      if (walletAlertTouched) {
        const effectiveFunding = body.fundingSource ?? ba.fundingSource;
        if (effectiveFunding !== "WALLET") {
          throw Object.assign(
            new Error(
              "Balance alerts and auto-top-up only apply to WALLET-funded accounts.",
            ),
            { httpStatus: 400, code: "WALLET_ONLY" },
          );
        }
        const nextEnabled = body.autoTopUpEnabled ?? ba.autoTopUpEnabled;
        const nextMin =
          body.minBalancePaise !== undefined
            ? body.minBalancePaise
            : ba.minBalancePaise;
        const nextAmount =
          body.autoTopUpAmountPaise !== undefined
            ? body.autoTopUpAmountPaise
            : ba.autoTopUpAmountPaise;
        if (nextEnabled && (nextMin == null || nextAmount == null)) {
          throw Object.assign(
            new Error(
              "Enabling auto-top-up requires both a minimum balance and a top-up amount.",
            ),
            { httpStatus: 400 },
          );
        }
      }

      // Funding-source change guards. We only refuse the change when
      // moving away from WALLET with a non-zero balance or away from
      // INVOICE with outstanding invoices — either would orphan money
      // in the old mode. The reverse transitions (INTO WALLET/INVOICE)
      // are always fine because we're starting fresh in the new mode.
      if (
        body.fundingSource &&
        body.fundingSource !== ba.fundingSource
      ) {
        if (
          ba.fundingSource === "WALLET" &&
          (ba.walletBalance ?? 0) > 0
        ) {
          throw Object.assign(
            new Error(
              "Cannot switch funding source with a non-zero wallet balance. Drain or refund the wallet first.",
            ),
            { httpStatus: 409 },
          );
        }
        if (ba.fundingSource === "INVOICE") {
          const outstanding = await tx.organizationInvoice.count({
            where: {
              billingAccountId: ba.id,
              status: { in: ["ISSUED", "OVERDUE"] },
            },
          });
          if (outstanding > 0) {
            throw Object.assign(
              new Error(
                `Cannot switch funding source with ${outstanding} outstanding invoice(s). Settle or void them first.`,
              ),
              { httpStatus: 409 },
            );
          }
        }
        // K-02 / #687 — enabling INVOICE funding requires a verified domain
        // (governance.ts documents this gate for the fundingSource→INVOICE
        // transition). tx-scoped read: TOCTOU-safe against a concurrent
        // verification rollback.
        if (body.fundingSource === "INVOICE") {
          await assertVerifiedDomainOrThrow(tx, orgId, "INVOICE_FUNDING");
        }
      }

      const next = await tx.billingAccount.update({
        where: { id: ba.id },
        data: {
          ...(body.billingEmail !== undefined && {
            billingEmail: body.billingEmail,
          }),
          ...(body.currency !== undefined && { currency: body.currency }),
          ...(body.fundingSource !== undefined && {
            fundingSource: body.fundingSource,
            // Initialize walletBalance when moving TO wallet, clear
            // when moving AWAY. Keeps the column NULL for non-wallet
            // accounts so callers can't accidentally read it.
            walletBalance:
              body.fundingSource === "WALLET"
                ? ba.walletBalance ?? 0
                : null,
          }),
          ...(body.creditLimit !== undefined && {
            creditLimit: body.creditLimit,
          }),
          ...(body.minBalancePaise !== undefined && {
            minBalancePaise: body.minBalancePaise,
          }),
          ...(body.autoTopUpEnabled !== undefined && {
            autoTopUpEnabled: body.autoTopUpEnabled,
          }),
          ...(body.autoTopUpAmountPaise !== undefined && {
            autoTopUpAmountPaise: body.autoTopUpAmountPaise,
          }),
        },
      });

      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "SETTINGS",
          action: AUDIT_ACTIONS.SETTINGS.SETTINGS_CHANGED,
          description: "BillingAccount updated",
          details: {
            from: {
              fundingSource: ba.fundingSource,
              currency: ba.currency,
              creditLimit: ba.creditLimit,
              minBalancePaise: ba.minBalancePaise,
              autoTopUpEnabled: ba.autoTopUpEnabled,
              autoTopUpAmountPaise: ba.autoTopUpAmountPaise,
            },
            to: {
              fundingSource: next.fundingSource,
              currency: next.currency,
              creditLimit: next.creditLimit,
              minBalancePaise: next.minBalancePaise,
              autoTopUpEnabled: next.autoTopUpEnabled,
              autoTopUpAmountPaise: next.autoTopUpAmountPaise,
            },
          },
        },
      });

      return next;
    });

    return NextResponse.json({ billingAccount: updated });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      const code =
        "code" in err && typeof err.code === "string" ? err.code : undefined;
      return NextResponse.json(
        { error: err.message, ...(code && { code }) },
        { status },
      );
    }
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "enterprise" } });
    throw err;
  }
}
