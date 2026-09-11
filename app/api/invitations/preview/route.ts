/**
 * Public invitation preview — no authentication required.
 *
 * GET ?token=<invitation-id>
 *
 * Returns enough context for the invite landing page to show a meaningful
 * "You've been invited to join Acme Corp as a Learner" message before the
 * visitor signs in. The token is 64-char random hex (256-bit entropy) so
 * exposing org name + role to the token-holder is safe.
 *
 * Deliberately returns the minimum: orgName, orgLogo, role, expiresAt.
 * Does NOT expose inviter identity, member counts, or billing info.
 *
 * Security — uniform error response for all invalid states:
 * Whether the token never existed, has expired, or was already accepted,
 * the response is identical (same HTTP status, same message). This prevents
 * state enumeration: a caller cannot distinguish "never issued" from "already
 * used" from "expired", limiting information leakage to the happy path only.
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

// Factory — a Response body is a one-shot stream; never reuse a Response instance
// across multiple requests. Also sets Cache-Control: no-store so browsers and
// CDNs don't cache the 410 and serve stale error messages on subsequent navigations.
function invalidResponse() {
  return NextResponse.json(
    { error: "This invitation link is no longer valid. Please ask your organization admin for a new invite." },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token || token.length < 16) {
    return invalidResponse();
  }

  const invitation = await prisma.invitation.findUnique({
    where: { id: token },
    select: {
      status: true,
      expiresAt: true,
      role: true,
      organization: {
        select: {
          name: true,
          brandingProfile: { select: { logo: true } },
        },
      },
    },
  });

  // Uniform 410 for all invalid states — do not distinguish between
  // not-found, expired, accepted, or cancelled to prevent state enumeration.
  if (
    !invitation ||
    invitation.status !== "pending" ||
    invitation.expiresAt < new Date()
  ) {
    return invalidResponse();
  }

  return NextResponse.json(
    {
      orgName: invitation.organization.name,
      orgLogo: invitation.organization.brandingProfile?.logo ?? null,
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
