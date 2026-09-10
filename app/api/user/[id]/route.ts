import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { getUserDetails } from "@/lib/data/user-details";
import { NextRequest, NextResponse } from "next/server";
import { UserRole, Gender } from "@prisma/client";

import { getSession } from "@/lib/auth-server";
import { persistProfessionalBackground } from "@/utils/onboarding-server";
import { scrubUser } from "@/lib/compliance/erasure/scrub-user";

/**
 * Convert empty strings to undefined so Prisma skips the field update.
 * For enum fields, also validates against the allowed values.
 */
function emptyToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value;
}

function parseEnumOrUndefined<T extends Record<string, string>>(
  value: unknown,
  enumObj: T,
): T[keyof T] | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const upper = value.toUpperCase();
  if (Object.values(enumObj).includes(upper as T[keyof T])) {
    return upper as T[keyof T];
  }
  return undefined;
}
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getSession();
    if (!session || (session.user.id !== id && session.user.role !== "ADMIN")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await getUserDetails(id);

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    return NextResponse.json({ data: user }, { status: 200 });
  } catch (error) {
    if (error instanceof Error) {
      console.error("Error: ", error.stack);
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "user" } });
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "An error occurred while fetching the user",
      },
      { status: 500 },
    );
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const session = await getSession();
    if (!session || (session.user.id !== id && session.user.role !== "ADMIN")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // PRIVILEGE ESCALATION GUARD. The check above admits a user editing
    // THEMSELVES, and `role` used to flow from the body straight into the
    // update below — so any consultee could PUT their own id with
    // {"role":"ADMIN"} and become a platform admin. Only an ADMIN may set a
    // role, and never on themselves (that would let a compromised admin
    // session quietly re-grant itself after a demotion).
    const isAdmin = session.user.role === "ADMIN";
    const body = await req.json();
    if (body.role !== undefined && (!isAdmin || session.user.id === id)) {
      return NextResponse.json(
        { error: "Forbidden — role cannot be changed here" },
        { status: 403 },
      );
    }
    const {
      name,
      email,
      image,
      phone,
      address,
      onboardingCompleted,
      role,
      currentTimezone,
      // New user fields
      dateOfBirth,
      gender,
      city,
      country,
      linkedinUrl,
      bio,
    } = body;

    // Input validation
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json(
        { error: "Invalid email format" },
        { status: 400 },
      );
    }

    if (role && !Object.values(UserRole).includes(role)) {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }

    // Validate bio length if provided
    if (bio && bio.length > 160) {
      return NextResponse.json(
        { error: "Bio must be 160 characters or less" },
        { status: 400 },
      );
    }

    const updatedUser = await prisma.user.update({
      where: { id: id },
      data: {
        name: emptyToUndefined(name),
        email: emptyToUndefined(email),
        image: emptyToUndefined(image),
        phone: emptyToUndefined(phone),
        address: emptyToUndefined(address),
        onboardingCompleted,
        role: parseEnumOrUndefined(role, UserRole),
        timezone: emptyToUndefined(currentTimezone),
        dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
        gender: parseEnumOrUndefined(gender, Gender),
        city: emptyToUndefined(city),
        country: emptyToUndefined(country),
        linkedinUrl: emptyToUndefined(linkedinUrl),
        bio: emptyToUndefined(bio),
      },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        phone: true,
        address: true,
        onboardingCompleted: true,
        role: true,
        timezone: true,
        // New fields
        dateOfBirth: true,
        gender: true,
        city: true,
        country: true,
        linkedinUrl: true,
        bio: true,
      },
    });

    return NextResponse.json({ data: updatedUser }, { status: 200 });
  } catch (error) {
    console.error("Error updating user:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "user" } });
    return NextResponse.json(
      { error: "An error occurred while updating the user" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const session = await getSession();
    if (!session || (session.user.id !== id && session.user.role !== "ADMIN")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();

    await prisma.$transaction(async (tx) => {
      await persistProfessionalBackground(id, undefined, body, tx);
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error("Error patching user professional background:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "user" } });
    return NextResponse.json(
      { error: "An error occurred while updating professional background" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Allow admins to delete any user, or users to delete their own account
    const isSelfDeletion = session.user.id === id;
    const isAdmin = session.user.role === "ADMIN";
    if (!isSelfDeletion && !isAdmin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const user = await prisma.user.findUnique({ where: { id: id } });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Money-history gate (#781 §B parity with the consultant route). A hard
    // delete cascades Payment → PaymentLeg / BookingUtilization /
    // ReferralCreditUsage away and 500s on the first Restrict (Refund,
    // Dispute) — destroying financial records the schema's own DPDP comment
    // says are retained per IT Act 5–7y obligations. Users whose money ever
    // moved get the §12 erasure scrub instead: PII pseudonymised, erasedAt
    // tombstone set, financial rows intact.
    // Consultant-side money lives on ConsultantProfile (earnings/payouts/TDS
    // Restrict-delete through it), not on Payment — a consultant with payout
    // history but no payer-side rows must also take the scrub path, or the
    // hard delete 500s on the first Restrict (#1205-triage).
    const [paymentCount, referralCreditCount, profile] = await Promise.all([
      prisma.payment.count({ where: { userId: id } }),
      prisma.referralCredit.count({ where: { userId: id } }),
      prisma.consultantProfile.findFirst({
        where: { userId: id },
        select: {
          _count: { select: { earnings: true, payouts: true, tdsRecords: true } },
        },
      }),
    ]);
    const consultantMoneyCount = profile
      ? profile._count.earnings +
        profile._count.payouts +
        profile._count.tdsRecords
      : 0;
    const hasMoneyHistory =
      paymentCount + referralCreditCount + consultantMoneyCount > 0;

    if (hasMoneyHistory) {
      await scrubUser(prisma, id);
      return NextResponse.json({
        message:
          "Account erased (PII scrubbed; financial history retained per statutory retention)",
        softDeleted: true,
      });
    }

    // Revoke all sessions for the user before deletion (atomic)
    await prisma.$transaction([
      prisma.session.deleteMany({ where: { userId: id } }),
      prisma.user.delete({ where: { id: id } }),
    ]);

    return NextResponse.json(
      { message: "User deleted successfully" },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error deleting user:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "user" } });
    return NextResponse.json(
      { error: "An error occurred while deleting the user" },
      { status: 500 },
    );
  }
}
