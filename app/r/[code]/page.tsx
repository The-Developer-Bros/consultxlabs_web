import { redirect } from "next/navigation";
import {
  validateReferralCode,
  applyReferralCode,
} from "@/lib/referrals/service";
import { getSession } from "@/lib/auth-server";
import { reportSentryError } from "@/lib/observability/report";

interface ReferralLandingProps {
  params: Promise<{ code: string }>;
}

export default async function ReferralLandingPage({
  params,
}: ReferralLandingProps) {
  const { code } = await params;

  const referralCode = await validateReferralCode(code);

  if (!referralCode) {
    // Invalid code - redirect to signup without ref
    redirect("/auth/signup");
  }

  // Check if user is already authenticated
  const session = await getSession();

  if (session?.user?.id) {
    // Authenticated user: apply the referral code directly and redirect to dashboard.
    //
    // The catch used to claim it was absorbing "already referred, self-referral,
    // etc." — it never was. applyReferralCode RETURNS NULL for every one of those
    // (self-referral, already referred, cap reached, code invalid) and only
    // THROWS on a genuine fault: a serializable retry giving up, the 10s
    // transaction timeout, the pooler. So the catch fires exclusively on faults
    // and was exclusively silent. (#1125)
    let applied = false;
    try {
      applied = (await applyReferralCode(session.user.id, code)) !== null;
    } catch (error) {
      reportSentryError(error, {
        subsystem: "referrals",
        op: "applyReferralCode",
        extra: { code },
      });
    }
    // Only claim it was applied when it was. Nothing renders off this flag
    // today, but a URL the referred user can read should not assert a reward
    // they did not get.
    redirect(applied ? "/dashboard?ref_applied=true" : "/dashboard");
  }

  // Unauthenticated user: redirect to signup with ref param
  redirect(`/auth/signup?ref=${encodeURIComponent(code)}`);
}
