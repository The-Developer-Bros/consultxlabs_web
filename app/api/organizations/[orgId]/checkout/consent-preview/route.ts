import { NextResponse, type NextRequest } from "next/server";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { checkConsent } from "@/lib/compliance/dpdp";
import { PURPOSE_CODES } from "@/lib/compliance/purpose-codes";

/**
 * #1430 — read-only consent pre-flight for the org-funded booking surface.
 * `handleCheckout` (lib/payments/operations/checkout.ts) already fails
 * closed on a missing SESSION_BOOKING consent artifact for the caller; this
 * route lets the payer selector warn about that BEFORE the member picks
 * "Bill to org" and hits the wall at pay time. No transaction is open here,
 * so the default `prisma` client `checkConsent` falls back to is fine.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { canSponsor: true });
  if (access.error) return access.error;

  const hasConsent = await checkConsent({
    userId: access.session.user.id,
    purposeCode: PURPOSE_CODES.SESSION_BOOKING,
  });

  return NextResponse.json({ hasConsent });
}
