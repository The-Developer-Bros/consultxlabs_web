/**
 * Consultant Payout Account Management API
 * Update/Delete specific payout accounts
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

import { getSession } from "@/lib/auth-server";
import {
  getRazorpayPayoutsService,
  isRazorpayPayoutsConfigured,
} from "@/lib/payments/payouts/razorpay-payouts";
interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * PATCH /api/consultant/payout-accounts/[id]
 * Set as default account
 */
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const body = await req.json();

    // Get consultant profile
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 404 },
      );
    }

    // Verify account belongs to consultant
    const account = await prisma.payoutAccount.findUnique({
      where: { id },
    });

    if (!account || account.consultantProfileId !== consultantProfile.id) {
      return NextResponse.json(
        { error: "Payout account not found" },
        { status: 404 },
      );
    }

    // #1230 — retry the penny-drop for an unverified Razorpay account. The
    // creation-time validation can come back async ("created") or fail
    // transiently; without this action the account stayed isVerified:false
    // forever while payout selection filters on the flag.
    if (body.action === "reverify") {
      if (account.provider !== "RAZORPAY" || !account.razorpayFundAccId) {
        return NextResponse.json(
          {
            error:
              "Re-verification requires a Razorpay account with a fund account",
            code: "NOT_RAZORPAY_ACCOUNT",
          },
          { status: 400 },
        );
      }
      if (!isRazorpayPayoutsConfigured()) {
        return NextResponse.json(
          {
            error: "RazorpayX payouts are not configured on the platform yet",
            code: "RAZORPAYX_UNCONFIGURED",
          },
          { status: 503 },
        );
      }
      try {
        const validation =
          await getRazorpayPayoutsService().validateBankAccount(
            account.razorpayFundAccId,
          );
        const verified = validation.accountStatus === "valid";
        const updated = await prisma.payoutAccount.update({
          where: { id: account.id },
          data: { isVerified: verified },
        });
        return NextResponse.json({
          success: true,
          accountStatus: validation.accountStatus,
          verification: validation.status,
          account: updated,
        });
      } catch (err) {
        console.error("[payout-account] reverify failed:", err);
        return NextResponse.json(
          {
            error:
              "Bank verification is temporarily unavailable; try again later.",
          },
          { status: 502 },
        );
      }
    }

    // Handle setting as default (use transaction for atomicity)
    if (body.isDefault === true) {
      await prisma.$transaction(async (tx) => {
        // Unset other defaults
        await tx.payoutAccount.updateMany({
          where: {
            consultantProfileId: consultantProfile.id,
            isDefault: true,
          },
          data: { isDefault: false },
        });

        // Set this as default
        await tx.payoutAccount.update({
          where: { id },
          data: { isDefault: true },
        });
      });
    }

    const updatedAccount = await prisma.payoutAccount.findUnique({
      where: { id },
    });

    return NextResponse.json({
      success: true,
      account: updatedAccount,
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "consultant" } });
    console.error("Error updating payout account:", error);
    return NextResponse.json(
      { error: "Failed to update payout account" },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/consultant/payout-accounts/[id]
 * Remove a payout account
 */
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    // Get consultant profile
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 404 },
      );
    }

    // Verify account belongs to consultant
    const account = await prisma.payoutAccount.findUnique({
      where: { id },
    });

    if (!account || account.consultantProfileId !== consultantProfile.id) {
      return NextResponse.json(
        { error: "Payout account not found" },
        { status: 404 },
      );
    }

    // Don't allow deletion if there are pending payouts using this account
    const pendingPayouts = await prisma.consultantPayout.count({
      where: {
        consultantProfileId: consultantProfile.id,
        status: { in: ["PENDING", "APPROVED", "PROCESSING"] },
      },
    });

    if (pendingPayouts > 0) {
      return NextResponse.json(
        { error: "Cannot delete account with pending payouts" },
        { status: 400 },
      );
    }

    // Delete the account and reassign default if needed (use transaction for atomicity)
    await prisma.$transaction(async (tx) => {
      // Delete the account
      await tx.payoutAccount.delete({
        where: { id },
      });

      // If this was default, set another as default
      if (account.isDefault) {
        const anotherAccount = await tx.payoutAccount.findFirst({
          where: { consultantProfileId: consultantProfile.id },
          orderBy: { createdAt: "desc" },
        });

        if (anotherAccount) {
          await tx.payoutAccount.update({
            where: { id: anotherAccount.id },
            data: { isDefault: true },
          });
        }
      }
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "consultant" } });
    console.error("Error deleting payout account:", error);
    return NextResponse.json(
      { error: "Failed to delete payout account" },
      { status: 500 },
    );
  }
}
