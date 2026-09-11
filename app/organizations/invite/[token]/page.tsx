"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { Building2, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/auth-client";
import { MEMBER_ROLE_LABEL, MemberRoleSchema } from "@/lib/labels/org-labels";

interface AcceptResponse {
  organization: { id: string; name: string };
  role?: string;
  alreadyMember?: boolean;
}

type PreviewState =
  | { phase: "loading" }
  | { phase: "valid"; orgName: string; orgLogo: string | null; role: string }
  | { phase: "invalid"; message: string };

// The preview API returns `role` as a free-form string (Invitation.role on
// the BetterAuth table). Narrow it to a MemberRole before label lookup;
// fall back to the raw value when the string doesn't match the enum.
function roleLabel(role: string): string {
  const parsed = MemberRoleSchema.safeParse(role);
  return parsed.success ? MEMBER_ROLE_LABEL[parsed.data] : role;
}

/**
 * Public invitation acceptance page.
 *
 * Flow:
 *   1. Always fetch a public preview of the invitation (org name, role) so the
 *      page shows meaningful context to any visitor, authenticated or not.
 *   2. Unauthenticated → show "Join <OrgName> as <Role>" + Sign in / Create
 *      account buttons. Both preserve the token via callbackUrl so the visitor
 *      lands back here after auth and auto-accepts.
 *   3. Authenticated → POST /api/organizations/invitations/accept. On success,
 *      route to the org dashboard.
 *   4. Expired / already-accepted token → show a clear error from the preview
 *      step before prompting the visitor to sign in.
 *
 * The route lives outside the dashboard group so middleware doesn't gate it
 * behind a session cookie.
 */
export default function InviteAcceptPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const router = useRouter();
  const { data: session, isPending } = useSession();

  const [preview, setPreview] = useState<PreviewState>({ phase: "loading" });
  const [status, setStatus] = useState<
    "idle" | "accepting" | "success" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AcceptResponse | null>(null);

  // Fetch invitation preview on mount — no auth required.
  // This gives the page enough context to show org name, role, and an
  // expired/invalid error before prompting the visitor to sign in.
  useEffect(() => {
    fetch(`/api/invitations/preview?token=${encodeURIComponent(token)}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) {
          setPreview({ phase: "invalid", message: body.error ?? "This invitation is no longer valid." });
        } else {
          setPreview({ phase: "valid", orgName: body.orgName, orgLogo: body.orgLogo, role: body.role });
        }
      })
      .catch(() => {
        setPreview({ phase: "invalid", message: "Could not load invitation details." });
      });
  }, [token]);

  // Store the token in localStorage so new users signing up via this link
  // can be auto-redirected back here after completing onboarding.
  // This bridges the signup → onboarding → dashboard redirect chain where
  // the callbackUrl would otherwise be lost.
  useEffect(() => {
    if (!isPending && !session?.user?.id) {
      try {
        localStorage.setItem("pendingOrgInviteToken", token);
      } catch {
        // localStorage unavailable — callbackUrl in the links below is the fallback
      }
    }
  }, [isPending, session, token]);

  // Auto-accept once session is ready — runs regardless of preview phase.
  // Preview only gates the unauthenticated sign-in prompt; authenticated users
  // always attempt accept so the accept API can surface specific, verified errors
  // (e.g. "you're already a member → go to dashboard" vs. generic "no longer valid").
  useEffect(() => {
    if (isPending) return;
    if (!session?.user?.id) return;
    if (status !== "idle") return;

    setStatus("accepting");
    fetch("/api/organizations/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invitationId: token }),
    })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) {
          throw new Error(body.error || "Failed to accept invitation");
        }
        return body as AcceptResponse;
      })
      .then((body) => {
        setResult(body);
        setStatus("success");
      })
      .catch((err: Error) => {
        setError(err.message);
        setStatus("error");
      });
  }, [isPending, session, token, preview, status]);

  // Auto-route on success after a brief confirmation flash.
  useEffect(() => {
    if (status === "success" && result) {
      const t = setTimeout(() => {
        router.push(
          `/dashboard/organization/${result.organization.id}/home`,
        );
      }, 1200);
      return () => clearTimeout(t);
    }
  }, [status, result, router]);

  // Derive org name + logo from whichever source is available:
  // preview (always) or accept response (after success).
  const orgName =
    status === "success" && result
      ? result.organization.name
      : preview.phase === "valid"
        ? preview.orgName
        : null;

  const orgLogo = preview.phase === "valid" ? preview.orgLogo : null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-zinc-100 flex items-center justify-center overflow-hidden">
            {orgLogo ? (
              <Image src={orgLogo} alt={orgName ?? "Organization"} width={48} height={48} className="object-cover" />
            ) : (
              <Building2 className="w-6 h-6 text-zinc-600" />
            )}
          </div>
          <CardTitle>
            {orgName ? `Join ${orgName}` : "Organization invitation"}
          </CardTitle>
          {preview.phase === "valid" && (
            <CardDescription>
              You&apos;ve been invited as a{" "}
              <span className="font-medium text-zinc-700">
                {roleLabel(preview.role)}
              </span>
            </CardDescription>
          )}
          {preview.phase === "loading" && (
            <CardDescription>Loading invitation details…</CardDescription>
          )}
        </CardHeader>
        <CardContent>
          {/* Session or preview still loading — match card anatomy */}
          {(preview.phase === "loading" || isPending) && (
            <div className="space-y-3 py-2" aria-busy="true">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-11 w-full rounded-lg" />
              <Skeleton className="h-11 w-full rounded-lg" />
            </div>
          )}

          {/* Authenticated users — always run through the accept flow.
              The accept API is identity-verified so it can surface specific,
              helpful errors (e.g. "you're already a member → go to dashboard")
              rather than the generic message the public preview uses. */}
          {!isPending && session?.user?.id && (
            <>
              {status === "accepting" || status === "idle" ? (
                <div className="flex flex-col items-center py-6 gap-2">
                  <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
                  <p className="text-sm text-zinc-500">Accepting invitation…</p>
                </div>
              ) : status === "success" && result ? (
                <div className="text-center space-y-2 py-2">
                  <CheckCircle2 className="h-10 w-10 text-emerald-500 mx-auto" />
                  <p className="text-base font-medium text-zinc-900">
                    {result.alreadyMember ? "You're already a member!" : "You're in!"}
                  </p>
                  <p className="text-sm text-zinc-500">
                    {result.alreadyMember
                      ? `Taking you to ${result.organization.name}…`
                      : `Welcome to ${result.organization.name}. Redirecting you now…`}
                  </p>
                </div>
              ) : (
                <div className="text-center space-y-3 py-2">
                  <AlertCircle className="h-10 w-10 text-red-500 mx-auto" />
                  <p className="text-sm text-zinc-700">
                    {error ?? "We could not accept this invitation."}
                  </p>
                  <Link href="/dashboard">
                    <Button variant="outline" size="sm">
                      Go to dashboard
                    </Button>
                  </Link>
                </div>
              )}
            </>
          )}

          {/* Unauthenticated users — preview determines what they see.
              Generic error for all invalid states prevents state enumeration. */}
          {!isPending && !session?.user?.id && preview.phase !== "loading" && (
            <>
              {preview.phase === "invalid" ? (
                <div className="text-center space-y-3 py-2">
                  <AlertCircle className="h-10 w-10 text-red-500 mx-auto" />
                  <p className="text-sm text-zinc-700">{preview.message}</p>
                  <Link href="/">
                    <Button variant="outline" size="sm">
                      Go to homepage
                    </Button>
                  </Link>
                </div>
              ) : (
                <div className="text-center space-y-3">
                  <p className="text-sm text-zinc-600">
                    Sign in or create an account to accept this invitation.
                  </p>
                  <div className="flex flex-col gap-2">
                    <Link
                      href={`/auth/signin?callbackUrl=${encodeURIComponent(
                        `/organizations/invite/${token}`,
                      )}`}
                    >
                      <Button className="w-full">Sign in</Button>
                    </Link>
                    <Link
                      href={`/auth/signup?callbackUrl=${encodeURIComponent(
                        `/organizations/invite/${token}`,
                      )}`}
                    >
                      <Button variant="outline" className="w-full">
                        Create account
                      </Button>
                    </Link>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
