/**
 * Consultant Payout Accounts API
 * Manages bank accounts and UPI IDs for receiving payouts
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { PaymentGateway, PayoutAccountType } from "@prisma/client";
import { z } from "zod";
import { getSession } from "@/lib/auth-server";
import {
  getRazorpayPayoutsService,
  isRazorpayPayoutsConfigured,
} from "@/lib/payments/payouts";

// Validation schemas
const createBankAccountSchema = z.object({
  provider: z.enum(["RAZORPAY", "STRIPE"]),
  accountType: z.enum(["BANK_ACCOUNT", "UPI"]),
  accountHolderName: z.string().min(2),
  bankName: z.string().optional(),
  accountNumber: z.string().optional(),
  ifscCode: z.string().optional(),
  upiId: z.string().optional(),
});

/**
 * GET /api/consultant/payout-accounts
 * List consultant's payout accounts
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get consultant profile
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
      include: {
        payoutAccounts: {
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      accounts: consultantProfile.payoutAccounts,
    });
  } catch (error) {
    console.error("Error fetching payout accounts:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "consultant" } });
    return NextResponse.json(
      { error: "Failed to fetch payout accounts" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/consultant/payout-accounts
 * Add a new payout account
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const data = createBankAccountSchema.parse(body);

    // Get consultant profile with user info
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
      include: {
        user: true,
        payoutAccounts: true,
      },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 404 },
      );
    }

    // Validate provider/accountType compatibility
    if (data.provider === "STRIPE" && data.accountType !== "BANK_ACCOUNT") {
      // Stripe Connect requires separate onboarding flow, not BANK_ACCOUNT/UPI creation
      return NextResponse.json(
        {
          error:
            "Stripe payouts require Stripe Connect onboarding. Use the Stripe Connect flow instead.",
        },
        { status: 400 },
      );
    }

    // Validate based on account type
    if (data.accountType === "BANK_ACCOUNT") {
      if (!data.accountNumber || !data.ifscCode) {
        return NextResponse.json(
          {
            error:
              "Account number and IFSC code are required for bank accounts",
          },
          { status: 400 },
        );
      }
    } else if (data.accountType === "UPI") {
      if (!data.upiId) {
        return NextResponse.json(
          { error: "UPI ID is required for UPI accounts" },
          { status: 400 },
        );
      }
    }

    // CR #1234 round 2 — refuse Razorpay accounts when the gateway rail is
    // down/unconfigured. Persisting one would store isVerified:false with no
    // razorpayFundAccId and no retained full account number — permanently
    // unverifiable, and the reverify action can only 400 it afterwards.
    if (data.provider === "RAZORPAY" && !isRazorpayPayoutsConfigured()) {
      return NextResponse.json(
        {
          error:
            "RazorpayX payouts are not configured on the platform yet; bank details were not saved.",
          code: "RAZORPAYX_UNCONFIGURED",
        },
        { status: 503 },
      );
    }

    let razorpayContactId: string | undefined;
    let razorpayFundAccId: string | undefined;
    // #1230 — the verification loop used to be a dead end: accounts were
    // born isVerified:false and NOTHING ever flipped the flag, while payout
    // selection filters on it (payout-service isVerified:true). Run the
    // penny-drop at creation; when RazorpayX resolves synchronously ("valid")
    // the account verifies immediately, closing the loop for the common case.
    let pennyDropVerified = false;

    // Create RazorpayX contact and fund account if using Razorpay
    // Configuration was asserted above — this branch is purely the
    // Razorpay provisioning path now.
    if (data.provider === "RAZORPAY") {
      const razorpayPayouts = getRazorpayPayoutsService();

      // Check if contact already exists
      const existingAccount = consultantProfile.payoutAccounts.find(
        (acc) => acc.razorpayContactId,
      );

      if (existingAccount?.razorpayContactId) {
        razorpayContactId = existingAccount.razorpayContactId;
      } else {
        // Create new contact
        const contact = await razorpayPayouts.createContact({
          name:
            data.accountHolderName || consultantProfile.user.name || "Unknown",
          email: consultantProfile.user.email || "",
          type: "vendor",
          referenceId: consultantProfile.id,
        });
        razorpayContactId = contact.id;
      }

      // Create fund account
      if (data.accountType === "BANK_ACCOUNT") {
        const fundAccount = await razorpayPayouts.createFundAccount({
          contactId: razorpayContactId,
          accountType: "bank_account",
          bankAccount: {
            name: data.accountHolderName,
            ifsc: data.ifscCode!,
            accountNumber: data.accountNumber!,
          },
        });
        razorpayFundAccId = fundAccount.id;
      } else if (data.accountType === "UPI") {
        const fundAccount = await razorpayPayouts.createFundAccount({
          contactId: razorpayContactId,
          accountType: "vpa",
          vpa: {
            address: data.upiId!,
          },
        });
        razorpayFundAccId = fundAccount.id;
      }

      // Penny-drop the fresh fund account. A "created" (async) or failed
      // validation leaves isVerified:false — the PATCH reverify action
      // retries it; a synchronous "valid" verifies on the spot.
      if (razorpayFundAccId) {
        try {
          const validation =
            await razorpayPayouts.validateBankAccount(razorpayFundAccId);
          pennyDropVerified = validation.accountStatus === "valid";
        } catch (err) {
          // Non-fatal: creation must not fail because the validator did.
          console.error("[payout-account] penny-drop error:", err);
        }
      }
    }

    // Set as default if first account
    const isFirst = consultantProfile.payoutAccounts.length === 0;

    // Create payout account record
    const payoutAccount = await prisma.payoutAccount.create({
      data: {
        consultantProfileId: consultantProfile.id,
        provider: data.provider as PaymentGateway,
        accountType: data.accountType as PayoutAccountType,
        accountHolderName: data.accountHolderName,
        bankName: data.bankName,
        accountNumberLast4: data.accountNumber?.slice(-4),
        ifscCode: data.ifscCode,
        upiId: data.upiId,
        razorpayContactId,
        razorpayFundAccId,
        isDefault: isFirst,
        // #1230 — true when the creation-time penny-drop returned "valid";
        // otherwise false and the PATCH reverify action retries.
        isVerified: pennyDropVerified,
      },
    });

    return NextResponse.json({
      success: true,
      account: payoutAccount,
    });
  } catch (error) {
    console.error("Error creating payout account:", error);
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid data", details: error.errors },
        { status: 400 },
      );
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "consultant" } });
    return NextResponse.json(
      { error: "Failed to create payout account" },
      { status: 500 },
    );
  }
}
