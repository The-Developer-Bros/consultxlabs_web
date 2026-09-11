"use client";

import * as Sentry from "@sentry/nextjs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  signUp,
  useSession,
  sendVerificationEmail,
  getSession,
} from "@/lib/auth-client";
import { safeSameOriginPath } from "@/lib/safe-callback-url";
import { setPendingReferral } from "@/lib/pending-referral";
import { ssoSigninWithGuard } from "@/lib/sso/signin-with-toast";
import { GlobeIcon } from "@/components/auth/auth-icons";
import { SocialLoginButtons } from "@/components/auth/social-login-buttons";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { AuthFormSkeleton } from "../AuthFormSkeleton";

export default function SignUp() {
  return (
    <Suspense fallback={<AuthFormSkeleton />}>
      <SignUpContent />
    </Suspense>
  );
}

function SignUpContent() {
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const referralCode = searchParams.get("ref");
  const callbackUrl = searchParams.get("callbackUrl");
  const { data: session, isPending } = useSession();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [refCode, setRefCode] = useState(referralCode || "");
  const [ssoCheck, setSsoCheck] = useState<{
    enforceSSO: boolean;
    organizationName: string;
    ssoBody: { providerId: string; domain: string; callbackURL: string };
  } | null>(null);
  const [ssoChecking, setSsoChecking] = useState(false);
  const [verificationSent, setVerificationSent] = useState(false);
  const [resending, setResending] = useState(false);

  // Validate the callbackUrl once and reuse the safe value across onboarding,
  // verification, and social login. safeSameOriginPath rejects backslash /
  // scheme-relative escapes that naive prefix checks let through.
  const safeCallbackUrl = safeSameOriginPath(callbackUrl);

  // Build onboarding URL with optional callbackUrl passthrough (for org invite flow)
  const onboardingUrl = safeCallbackUrl
    ? `/form/onboarding?callbackUrl=${encodeURIComponent(safeCallbackUrl)}`
    : "/form/onboarding";

  // Thread the validated callbackUrl through the verification link so an
  // invite/deep-link destination survives email verification.
  const verificationCallbackUrl = safeCallbackUrl
    ? `/auth/verify-email?callbackUrl=${encodeURIComponent(safeCallbackUrl)}`
    : "/auth/verify-email";

  // Thread it back to sign-in too, so toggling sign-up ↔ sign-in preserves the
  // destination in both directions (only the org-invite deep-link set it before).
  const signInUrl = safeCallbackUrl
    ? `/auth/signin?callbackUrl=${encodeURIComponent(safeCallbackUrl)}`
    : "/auth/signin";

  // Redirect authenticated users based on onboarding status.
  //
  // `useSession()` can serve the ≤5-min cookie-cache payload; acting on a
  // stale `onboardingCompleted` sent the client one way while the server
  // guard (always force-fresh) bounced the user back — an intermittent
  // flicker. Re-verify with a force-fresh read before committing, and keep
  // the navigation idempotent (single replace, never push: leaving /auth/*
  // in history made Back from the dashboard ping-pong forward again).
  const navigatedRef = useRef<string | null>(null);
  useEffect(() => {
    if (isPending || !session?.user) return;

    let cancelled = false;
    const resolveAndGo = (completed: boolean) => {
      if (cancelled) return;
      const target = completed
        ? safeCallbackUrl || "/dashboard"
        : onboardingUrl;
      if (navigatedRef.current === target) return;
      navigatedRef.current = target;
      router.replace(target);
    };

    getSession({ query: { disableCookieCache: true } })
      .then(({ data }) => {
        // Session revoked between paint and check — no protected redirect.
        if (!data?.user) return;
        resolveAndGo(!!data.user.onboardingCompleted);
      })
      .catch(() => {
        resolveAndGo(!!session.user?.onboardingCompleted);
      });

    return () => {
      cancelled = true;
    };
  }, [session, isPending, router, safeCallbackUrl, onboardingUrl]);

  // Persist the referral code at first touch so it survives the OAuth redirect
  // and the email-verification gap; it is applied after authentication on the
  // onboarding landing. #880
  // #891 — landing here WITHOUT ?ref= must not wipe a previously-stashed code;
  // an explicit different code simply overwrites the stash.
  useEffect(() => {
    if (refCode) setPendingReferral(refCode);
  }, [refCode]);

  // Show loading while checking session status (fallback for when middleware doesn't catch)
  if (isPending) {
    return <AuthFormSkeleton />;
  }

  // If already logged in, show redirecting message
  if (session?.user) {
    const destination = session.user.onboardingCompleted
      ? "dashboard"
      : "onboarding";
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-950">
        <p className="text-white">Redirecting to {destination}...</p>
      </div>
    );
  }

  const handleResendVerification = async () => {
    setResending(true);
    try {
      await sendVerificationEmail({
        email,
        callbackURL: verificationCallbackUrl,
      });
      toast({
        title: "Verification email sent",
        description: `Check ${email} for the link.`,
      });
    } catch {
      toast({
        title: "Couldn't resend the email",
        description: "Please try again in a moment.",
        variant: "destructive",
      });
    } finally {
      setResending(false);
    }
  };

  // After a verification-required signup there is no session yet — show a
  // check-your-email panel with a resend instead of the form.
  if (verificationSent) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-950 p-6">
        <div className="w-full max-w-md text-center text-white">
          <h2 className="mb-3 text-fluid-3xl font-semibold tracking-tight">
            Check your email
          </h2>
          <p className="mb-6 text-sm text-zinc-400 md:text-base">
            We sent a verification link to{" "}
            <span className="font-medium text-white">{email}</span>. Click it to
            activate your account. The link expires in 1 hour.
          </p>
          <Button
            onClick={handleResendVerification}
            disabled={resending}
            className="w-full bg-zinc-800 hover:bg-zinc-700"
          >
            {resending ? "Resending…" : "Resend verification email"}
          </Button>
          <p className="mt-4 text-xs text-zinc-400">
            Already verified?{" "}
            <Link
              href={signInUrl}
              className="font-medium text-zinc-300 underline-offset-4 hover:text-white hover:underline"
            >
              Sign in
            </Link>
          </p>
        </div>
      </div>
    );
  }

  const handleEmailBlur = async () => {
    if (!email || !email.includes("@")) return;
    setSsoChecking(true);
    try {
      const res = await fetch(
        `/api/auth/sso/domain-check?email=${encodeURIComponent(email)}`,
      );
      if (res.ok) {
        const data = await res.json();
        setSsoCheck(
          data.enforceSSO
            ? {
                enforceSSO: true,
                organizationName: data.organizationName,
                ssoBody: data.ssoBody,
              }
            : null,
        );
      }
    } catch {
      // ignore — fall through to normal signup
    } finally {
      setSsoChecking(false);
    }
  };

  /**
   * Translate BetterAuth's developer-facing validation errors into
   * user-friendly messages. Raw errors look like:
   *   "[body.email] Invalid email address; [body.password] Too small: ..."
   */
  const handleSSOSignIn = async () => {
    if (!ssoCheck) return;
    // Use the guarded wrapper around signIn.sso() so SSO failures
    // (resolve-with-error, 500-with-empty-body, no-redirect-after-2s)
    // surface as a destructive toast instead of a silent dead-end on
    // the signup form. See `lib/sso/signin-with-toast.ts` + audit B.1.
    const result = await ssoSigninWithGuard({
      providerId: ssoCheck.ssoBody.providerId,
      domain: ssoCheck.ssoBody.domain,
      callbackURL: ssoCheck.ssoBody.callbackURL,
    });
    if (!result.ok && result.errorMessage) {
      toast({
        title: "SSO sign-in failed",
        description: result.errorMessage,
        variant: "destructive",
      });
    }
  };

  const friendlyAuthError = (raw: string | undefined): string => {
    if (!raw) return "An unexpected error occurred. Please try again.";
    const lower = raw.toLowerCase();
    const issues: string[] = [];
    if (
      lower.includes("email") &&
      (lower.includes("invalid") || lower.includes("required"))
    )
      issues.push("Please enter a valid email address.");
    if (
      lower.includes("password") &&
      (lower.includes("too small") ||
        lower.includes(">=") ||
        lower.includes("required"))
    )
      issues.push("Password must be at least 8 characters.");
    if (lower.includes("already") || lower.includes("exists"))
      return "An account with this email already exists. Try signing in instead.";
    if (issues.length > 0) return issues.join(" ");
    // Strip "[body.field]" prefixes for anything we didn't catch
    return (
      raw.replace(/\[body\.\w+\]\s*/g, "").trim() ||
      "An unexpected error occurred."
    );
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      toast({ title: "Passwords do not match", variant: "destructive" });
      return;
    }
    setIsLoading(true);
    toast({ title: "Creating account..." });

    try {
      const { data, error } = await signUp.email({
        name,
        email,
        password,
        callbackURL: verificationCallbackUrl,
      });

      if (error) {
        toast({
          title: "Sign Up Failed",
          description: friendlyAuthError(error.message),
          variant: "destructive",
        });
      } else if (data && !data.token) {
        // requireEmailVerification: the account is created but no session is
        // issued until the email is verified. Show the check-your-email panel.
        setVerificationSent(true);
        toast({
          title: "Check your email",
          description: `We sent a verification link to ${email}.`,
        });
      } else if (data) {
        // Session created (verification-disabled fallback). The referral code
        // was persisted at first touch and is applied on the onboarding landing
        // (covers OAuth + verified-email paths uniformly). #880
        toast({
          title: "Account Created Successfully!",
          description: "Redirecting to onboarding...",
        });
        router.push(onboardingUrl);
      }
    } catch (error: unknown) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "auth" } },
      );
      console.error("Sign up error:", error);
      const message =
        error instanceof Error
          ? error.message
          : "An unexpected error occurred.";
      toast({
        title: "Sign Up Failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <div className="hidden flex-col justify-between bg-pearl p-6 text-black md:flex md:w-1/2 md:p-12">
        <Link href="/">
          <div className="flex items-center justify-start space-x-2">
            <GlobeIcon className="h-5 w-5 text-black md:h-6 md:w-6" />
            <h1 className="text-2xl font-semibold tracking-tight md:text-4xl">
              Familiarise
            </h1>
          </div>
        </Link>
        <div className="my-8 md:my-0">
          <blockquote className="text-fluid-lg leading-relaxed text-neutral-700">
            &ldquo;Joining Familiarise was the best decision for my startup.
            Access to top-tier mentors gave us the clarity and direction we
            desperately needed.&rdquo;
          </blockquote>
          <p className="mt-4 text-sm font-medium md:text-base">
            Priya Sharma, Founder @ TechNova
          </p>
        </div>
        <div className="text-xs text-neutral-600 md:text-sm">
          Start your journey with Familiarise today. Sign up to unlock a world
          of expert mentorship.
        </div>
      </div>
      <div className="flex flex-1 flex-col justify-center bg-neutral-950 p-6 text-white md:w-1/2 md:p-12">
        <div className="mx-auto flex w-full max-w-md flex-col">
          <h2 className="mb-2 text-fluid-3xl font-semibold tracking-tight">
            Create your account
          </h2>
          <p className="mb-6 text-sm text-zinc-400 md:text-base">
            Enter your details below to get started.
          </p>
          <form onSubmit={handleSignUp}>
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                placeholder="Your Name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                disabled={isLoading}
              />
            </div>
            <div className="grid gap-2 mt-4">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                placeholder="name@example.com"
                type="email"
                autoCapitalize="none"
                autoComplete="email"
                autoCorrect="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={handleEmailBlur}
                required
                disabled={isLoading || ssoChecking}
              />
            </div>
            {!ssoCheck?.enforceSSO && (
              <>
                <div className="grid gap-2 mt-4">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    disabled={isLoading}
                  />
                </div>
                <div className="grid gap-2 mt-4">
                  <Label htmlFor="confirm-password">Confirm Password</Label>
                  <Input
                    id="confirm-password"
                    type="password"
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    disabled={isLoading}
                  />
                </div>
              </>
            )}
            {!referralCode && !ssoCheck?.enforceSSO && (
              <div className="grid gap-2 mt-4">
                <Label htmlFor="referral-code">Referral Code (optional)</Label>
                <Input
                  id="referral-code"
                  placeholder="Enter referral code"
                  type="text"
                  value={refCode}
                  onChange={(e) => setRefCode(e.target.value)}
                  disabled={isLoading}
                />
              </div>
            )}
            {referralCode && !ssoCheck?.enforceSSO && (
              <div className="mt-4 p-3 rounded-md bg-green-900/30 border border-green-700">
                <p className="text-sm text-green-400">
                  Referral code{" "}
                  <span className="font-semibold">{referralCode}</span> applied!
                  You&apos;ll receive a welcome bonus after signing up.
                </p>
              </div>
            )}
            {!ssoCheck?.enforceSSO && (
              <Button
                type="submit"
                className="mt-4 w-full bg-white text-black hover:bg-white/90"
                disabled={isLoading}
              >
                {isLoading ? "Creating Account..." : "Create Account"}
              </Button>
            )}
          </form>

          {ssoCheck?.enforceSSO && (
            <div className="mt-4 rounded-md border border-white/15 bg-white/5 p-4">
              <p className="mb-3 text-sm text-zinc-400">
                Your organization requires SSO sign-in. Use the button below to
                authenticate.
              </p>
              <Button
                type="button"
                className="w-full bg-white text-black hover:bg-white/90"
                onClick={handleSSOSignIn}
              >
                Sign in with {ssoCheck.organizationName} SSO &rarr;
              </Button>
            </div>
          )}

          {!ssoCheck?.enforceSSO && (
            <>
              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-white/15" />
                </div>
                <div className="relative flex justify-center text-sm">
                  <span className="bg-neutral-950 px-2 text-zinc-400">
                    OR CONTINUE WITH
                  </span>
                </div>
              </div>

              <SocialLoginButtons
                callbackURL={safeCallbackUrl || "/dashboard"}
                newUserCallbackURL={onboardingUrl}
                isLoading={isLoading}
                ssoEnforced={false}
              />
            </>
          )}

          <p className="mt-6 text-xs text-zinc-400">
            Already have an account?{" "}
            <Link
              href={signInUrl}
              className="font-medium text-white underline-offset-4 hover:underline"
            >
              Sign in
            </Link>
          </p>
          <p className="mt-2 text-xs text-zinc-400">
            By clicking Create Account, you agree to our Terms of Service and
            Privacy Policy.
          </p>
        </div>
        <div />
      </div>
    </div>
  );
}
