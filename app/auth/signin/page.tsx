"use client";

import * as Sentry from "@sentry/nextjs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  signIn,
  useSession,
  sendVerificationEmail,
  getSession,
} from "@/lib/auth-client";
import { ssoSigninWithGuard } from "@/lib/sso/signin-with-toast";
import { safeSameOriginPath } from "@/lib/safe-callback-url";
import { GlobeIcon } from "@/components/auth/auth-icons";
import { SocialLoginButtons } from "@/components/auth/social-login-buttons";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect, useMemo, useRef, Suspense } from "react";
import { AuthFormSkeleton } from "../AuthFormSkeleton";

/**
 * Resolve the redirect target for an already-authenticated visitor.
 *
 * `useSession()` can serve the ≤5-min cookie-cache payload, and acting on a
 * stale `onboardingCompleted` sent us one way while the server guard (always
 * force-fresh) immediately bounced the user back — the intermittent
 * signin↔dashboard↔onboarding flicker. Re-reading the session with
 * `disableCookieCache` aligns the client's decision with what the server
 * guard will decide.
 *
 * - Fresh read returns a user → trust its onboarding status.
 * - Fresh read FAILS (network) → fall back to the cached value.
 * - Fresh read returns NO user → the session is actually gone/revoked; do NOT
 *   navigate to a protected route (the server would only bounce us back).
 *   Stay put and let the session-store update drive the UI.
 */
function useAuthenticatedRedirectTarget(
  onboardingCompleted: boolean | undefined,
  isPending: boolean,
  callbackUrl: string | null,
  onboardingUrl: string,
) {
  const router = useRouter();
  const navigatedRef = useRef<string | null>(null);

  useEffect(() => {
    if (isPending || onboardingCompleted === undefined) return;

    let cancelled = false;
    const resolveAndGo = (completed: boolean) => {
      if (cancelled) return;
      const target = completed ? callbackUrl || "/dashboard" : onboardingUrl;
      // Idempotency guard: re-renders / Strict-Mode double-invocation /
      // duplicate store emissions must not queue a second navigation.
      // (A delayed-state callbackUrl used to fire this effect twice with
      // different targets — flashing users through /dashboard en route to
      // their real destination.)
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
        resolveAndGo(!!onboardingCompleted);
      });

    return () => {
      cancelled = true;
    };
  }, [onboardingCompleted, isPending, router, callbackUrl, onboardingUrl]);
}

export default function SignIn() {
  return (
    <Suspense fallback={<AuthFormSkeleton />}>
      <SignInContent />
    </Suspense>
  );
}

function SignInContent() {
  const { toast } = useToast();
  const searchParams = useSearchParams();
  const { data: session, isPending } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [ssoCheck, setSsoCheck] = useState<{
    enforceSSO: boolean;
    organizationName: string;
    ssoBody: { providerId: string; domain: string; callbackURL: string };
  } | null>(null);
  const [ssoChecking, setSsoChecking] = useState(false);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [resending, setResending] = useState(false);

  // Validate callbackUrl synchronously from the URL. safeSameOriginPath
  // resolves against a probe origin to reject backslash/scheme-relative
  // escapes ("/\attacker.example" passes naive prefix checks but parses to an
  // external origin) and returns the canonical same-origin path.
  const callbackUrl = useMemo(
    () => safeSameOriginPath(searchParams.get("callbackUrl")),
    [searchParams],
  );

  // #booking-journey — is this sign-in a detour out of a purchase? Derived
  // from the ALREADY-VALIDATED callbackUrl, never the raw param, so a crafted
  // "/\\evil.example/checkout/..." cannot light up a trust banner. Drives
  // only reassurance copy; nothing is authorized on the strength of it.
  const isPurchaseReturn = useMemo(
    () => callbackUrl?.startsWith("/checkout/") ?? false,
    [callbackUrl],
  );

  // Thread the validated callbackUrl through the onboarding + sign-up hand-offs
  // so a first-timer who came here to book/buy returns to their destination
  // after finishing onboarding, instead of being dropped on the dashboard
  // (mirrors the sign-up page, which already does this).
  const onboardingUrl = callbackUrl
    ? `/form/onboarding?callbackUrl=${encodeURIComponent(callbackUrl)}`
    : "/form/onboarding";
  const signUpUrl = callbackUrl
    ? `/auth/signup?callbackUrl=${encodeURIComponent(callbackUrl)}`
    : "/auth/signup";

  useAuthenticatedRedirectTarget(
    session?.user?.onboardingCompleted,
    isPending,
    callbackUrl,
    onboardingUrl,
  );

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

  const handleEmailBlur = async () => {
    if (!email || !email.includes("@")) return;
    setSsoChecking(true);
    try {
      const res = await fetch(
        `/api/auth/sso/domain-check?email=${encodeURIComponent(email)}`,
      );
      if (res.ok) {
        const data = await res.json();
        // Why: the domain-check route returns `providerMisconfigured: true`
        // when the stored SAML cert fails parse. Surface a friendly toast
        // and leave `ssoCheck` null so the user falls back to credentials
        // (which they may also have for legacy reasons). Without this
        // branch, clicking "Sign in with SSO" would crash BetterAuth and
        // present a blank 500.
        if (data.enforceSSO && data.providerMisconfigured) {
          toast({
            title: "Single sign-on is misconfigured",
            description:
              "Your SSO provider's certificate is invalid. Contact your IT admin to re-paste the X.509 PEM.",
            variant: "destructive",
          });
          setSsoCheck(null);
        } else {
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
      }
    } catch {
      // ignore — fall through to normal login
    } finally {
      setSsoChecking(false);
    }
  };

  const handleSSOSignIn = async () => {
    if (!ssoCheck) return;
    // Use the guarded wrapper around signIn.sso() so the call goes
    // through the ssoClient plugin (OIDC PKCE verifier persists before
    // the IdP redirect) AND so failure modes surface as toasts instead
    // of silent dead-ends. See `lib/sso/signin-with-toast.ts` for the
    // three failure modes this guards: BetterAuth's resolve-with-error
    // shape, 500-with-empty-body crashes, and no-redirect-after-2s.
    // Audit Phase B.1.
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

  // Manual SSO trigger for IT admins testing their setup before enforcement
  // is turned on. Same domain-check logic as the email blur handler, but
  // immediately fires the redirect if a provider is found.
  const handleManualSSOClick = async () => {
    if (!email || !email.includes("@")) {
      toast({
        title: "Enter your work email first",
        description: "Type your corporate email address above, then try again.",
      });
      return;
    }
    setSsoChecking(true);
    try {
      const res = await fetch(
        `/api/auth/sso/domain-check?email=${encodeURIComponent(email)}`,
      );
      if (!res.ok) throw new Error("check failed");
      const data = await res.json();
      // Same misconfigured-cert short-circuit as the blur handler — see
      // its comment above for the failure mode this guards against.
      if (data.enforceSSO && data.providerMisconfigured) {
        toast({
          title: "Single sign-on is misconfigured",
          description:
            "Your SSO provider's certificate is invalid. Contact your IT admin to re-paste the X.509 PEM.",
          variant: "destructive",
        });
        return;
      }
      if (data.enforceSSO) {
        setSsoCheck({
          enforceSSO: true,
          organizationName: data.organizationName,
          ssoBody: data.ssoBody,
        });
        const result = await ssoSigninWithGuard({
          providerId: data.ssoBody.providerId,
          domain: data.ssoBody.domain,
          callbackURL: data.ssoBody.callbackURL,
        });
        if (!result.ok && result.errorMessage) {
          toast({
            title: "SSO sign-in failed",
            description: result.errorMessage,
            variant: "destructive",
          });
        }
      } else {
        toast({
          title: "No SSO provider found",
          description:
            "No corporate SSO is configured for this email domain. Contact your IT admin.",
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: "SSO check failed",
        description: "Could not verify SSO for this domain. Please try again.",
        variant: "destructive",
      });
    } finally {
      setSsoChecking(false);
    }
  };

  const friendlyAuthError = (raw: string | undefined): string => {
    if (!raw) return "Invalid email or password.";
    const lower = raw.toLowerCase();
    if (
      lower.includes("email") &&
      (lower.includes("invalid") || lower.includes("required"))
    )
      return "Please enter a valid email address.";
    if (
      lower.includes("password") &&
      (lower.includes("too small") ||
        lower.includes(">=") ||
        lower.includes("required"))
    )
      return "Please enter your password.";
    if (lower.includes("invalid") && lower.includes("credentials"))
      return "Invalid email or password.";
    if (lower.includes("not found") || lower.includes("no user"))
      return "No account found with this email. Check the address or sign up.";
    return (
      raw.replace(/\[body\.\w+\]\s*/g, "").trim() ||
      "Invalid email or password."
    );
  };

  const handleResendVerification = async () => {
    if (!email || !email.includes("@")) {
      toast({
        title: "Enter your email address first",
        variant: "destructive",
      });
      return;
    }
    setResending(true);
    try {
      // Preserve the validated callbackUrl so the original destination survives
      // verification (callbackUrl state is only set for relative paths).
      const verificationCallbackUrl = callbackUrl
        ? `/auth/verify-email?callbackUrl=${encodeURIComponent(callbackUrl)}`
        : "/auth/verify-email";
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

  const handleEmailSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    // Clear any stale "verify your email" banner from a previous attempt.
    setNeedsVerification(false);
    setIsLoading(true);
    toast({ title: "Signing in..." });

    try {
      const { data, error } = await signIn.email({
        email,
        password,
      });

      if (error) {
        const code = (error as { code?: string }).code;
        if (
          code === "EMAIL_NOT_VERIFIED" ||
          /verif/i.test(error.message ?? "")
        ) {
          setNeedsVerification(true);
          toast({
            title: "Verify your email",
            description:
              "Your email isn't verified yet — resend the link below.",
          });
        } else {
          toast({
            title: "Sign In Failed",
            description: friendlyAuthError(error.message),
            variant: "destructive",
          });
        }
      } else if (data) {
        Sentry.setUser({ id: data.user.id });
        toast({
          title: "Sign In Successful",
          description: callbackUrl
            ? "Redirecting to your destination..."
            : "Redirecting to dashboard...",
        });
        // Defer the redirect to the useSession-driven effect above so it honours
        // onboarding status — a non-onboarded user signing in from a booking/trial
        // callback must go through onboarding first, not straight to callbackUrl.
      }
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "auth" } },
      );
      console.error("Sign in error:", error);
      toast({
        title: "Sign In Error",
        description: "An unexpected error occurred. Please try again.",
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
            &ldquo;The mentors on this platform have been incredible. Their deep
            industry expertise and personalized guidance helped me navigate
            complex career decisions and accelerate my professional growth. The
            insights I gained were truly transformative.&rdquo;
          </blockquote>
          <p className="mt-4 text-sm font-medium md:text-base">
            Shubham, Software Engineer
          </p>
        </div>
        <div className="text-xs text-neutral-600 md:text-sm">
          Connect with experienced mentors who can guide you towards your
          professional goals.
        </div>
      </div>
      <div className="flex flex-1 flex-col justify-center bg-neutral-950 p-6 text-white md:w-1/2 md:p-12">
        <div className="mx-auto flex w-full max-w-md flex-col">
          <h2 className="mb-2 text-fluid-3xl font-semibold tracking-tight">
            Sign in to your account
          </h2>
          {/* #booking-journey — when the callback is a checkout return, say
              so: a guest bounced from a Buy/Subscribe click must see that
              their purchase survived the detour, or they read this page as an
              error and abandon. */}
          {isPurchaseReturn && (
            <div className="mb-4 rounded-md border border-emerald-600/60 bg-emerald-900/30 p-3">
              <p className="text-sm text-emerald-300">
                You&apos;re almost there — sign in to continue your booking.
                Your selection is saved and will resume right where you left
                off.
              </p>
            </div>
          )}
          {needsVerification && (
            <div className="mb-4 rounded-md border border-yellow-600 bg-yellow-900/40 p-3">
              <p className="mb-2 text-sm text-yellow-300">
                Your email isn&apos;t verified yet. Check your inbox, or resend
                the link.
              </p>
              <Button
                type="button"
                onClick={handleResendVerification}
                disabled={resending}
                className="bg-zinc-800 hover:bg-zinc-700"
              >
                {resending ? "Resending…" : "Resend verification email"}
              </Button>
            </div>
          )}
          <p className="mb-6 text-sm text-zinc-400 md:text-base">
            Enter your email and password below to sign in.
          </p>
          <form onSubmit={handleEmailSignIn}>
            <div className="grid gap-2">
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
              <div className="grid gap-2 mt-4">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">Password</Label>
                  <Link
                    href="/auth/forgot-password"
                    className="text-sm font-medium text-zinc-300 underline-offset-4 hover:text-white hover:underline"
                  >
                    Forgot password?
                  </Link>
                </div>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={isLoading}
                />
              </div>
            )}
            {ssoCheck?.enforceSSO ? (
              <Button
                type="button"
                className="mt-4 w-full bg-white text-black hover:bg-white/90"
                onClick={handleSSOSignIn}
              >
                Sign in with {ssoCheck.organizationName} SSO &rarr;
              </Button>
            ) : (
              <Button
                type="submit"
                className="mt-4 w-full bg-white text-black hover:bg-white/90"
                disabled={isLoading}
              >
                {isLoading ? "Signing In..." : "Sign In with Email"}
              </Button>
            )}
          </form>
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
                callbackURL={callbackUrl || "/dashboard"}
                newUserCallbackURL={onboardingUrl}
                isLoading={isLoading}
                ssoEnforced={false}
                onSSOClick={handleManualSSOClick}
                ssoChecking={ssoChecking}
              />
            </>
          )}
          <p className="mt-6 text-xs text-zinc-400">
            Don't have an account?{" "}
            <Link
              href={signUpUrl}
              className="font-medium text-white underline-offset-4 hover:underline"
            >
              Sign up
            </Link>
          </p>
          <p className="mt-2 text-xs text-zinc-400">
            By clicking continue, you agree to our Terms of Service and Privacy
            Policy.
          </p>
        </div>
        <div />
      </div>
    </div>
  );
}
