"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { sendVerificationEmail, useSession } from "@/lib/auth-client";
import { safeSameOriginPath } from "@/lib/safe-callback-url";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AuthCardSkeleton } from "../AuthCardSkeleton";

export default function VerifyEmail() {
  return (
    <Suspense fallback={<AuthCardSkeleton />}>
      <VerifyEmailContent />
    </Suspense>
  );
}

// Friendly copy for the error codes BetterAuth appends to the callbackURL when
// the verification link is bad (see api/routes/email-verification redirectOnError).
function errorMessage(code: string | null): string | null {
  if (!code) return null;
  if (code === "TOKEN_EXPIRED")
    return "That verification link has expired. Request a fresh one below.";
  if (code === "INVALID_TOKEN")
    return "That verification link is invalid. Request a fresh one below.";
  return "We couldn't verify that link. Request a fresh one below.";
}

function VerifyEmailContent() {
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session, isPending } = useSession();
  const error = errorMessage(searchParams.get("error"));
  // Preserve an upstream invite/deep-link destination through verification.
  // E2E-audit fix — hardened validator: the naive prefix check passed
  // "/\attacker.example" (WHATWG backslash normalization → off-origin).
  const safeCallbackUrl = safeSameOriginPath(searchParams.get("callbackUrl"));
  const onboardingUrl = safeCallbackUrl
    ? `/form/onboarding?callbackUrl=${encodeURIComponent(safeCallbackUrl)}`
    : "/form/onboarding";
  const [email, setEmail] = useState("");
  const [resending, setResending] = useState(false);

  // Success path: after the link is clicked, BetterAuth verifies + auto-signs-in
  // (autoSignInAfterVerification) and redirects here authenticated. Send the
  // user on to onboarding — the referral capture (if any) is applied there.
  useEffect(() => {
    if (!isPending && session?.user) {
      router.replace(
        session.user.onboardingCompleted
          ? safeCallbackUrl || "/dashboard"
          : onboardingUrl,
      );
    }
  }, [isPending, session, router, safeCallbackUrl, onboardingUrl]);

  const handleResend = async () => {
    if (!email || !email.includes("@")) {
      toast({ title: "Enter your email address", variant: "destructive" });
      return;
    }
    setResending(true);
    try {
      const verificationCallbackUrl = safeCallbackUrl
        ? `/auth/verify-email?callbackUrl=${encodeURIComponent(safeCallbackUrl)}`
        : "/auth/verify-email";
      await sendVerificationEmail({ email, callbackURL: verificationCallbackUrl });
      toast({
        title: "Verification email sent",
        description: `Check ${email} for the link. It expires in 1 hour.`,
      });
    } catch {
      toast({
        title: "Couldn't send the email",
        description: "Please try again in a moment.",
        variant: "destructive",
      });
    } finally {
      setResending(false);
    }
  };

  if (isPending || session?.user) {
    return <AuthCardSkeleton />;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-950 p-6">
      <div className="w-full max-w-md text-white">
        <h1 className="mb-3 text-fluid-3xl font-semibold tracking-tight">
          {error ? "Link expired or invalid" : "Verify your email"}
        </h1>
        <p className="text-sm md:text-base text-zinc-400 mb-6">
          {error ??
            "Check your inbox for the verification link we sent. It expires in 1 hour. Enter your email below to send a new one."}
        </p>

        <div className="grid gap-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="name@example.com"
            autoCapitalize="none"
            autoComplete="email"
            autoCorrect="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={resending}
          />
        </div>
        <Button
          type="button"
          className="w-full mt-4 bg-zinc-800 hover:bg-zinc-700"
          onClick={handleResend}
          disabled={resending}
        >
          {resending ? "Sending…" : "Resend verification email"}
        </Button>

        <p className="mt-6 text-xs text-zinc-400">
          Already verified?{" "}
          <Link
            href="/auth/signin"
            className="font-medium text-zinc-300 underline-offset-4 hover:text-white hover:underline"
          >
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
