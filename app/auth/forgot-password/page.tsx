"use client";

import * as Sentry from "@sentry/nextjs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { authClient, useSession } from "@/lib/auth-client";
import { GlobeIcon } from "@/components/auth/auth-icons";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useEffect, useRef } from "react";

export default function ForgotPassword() {
  const { toast } = useToast();
  const router = useRouter();
  const { data: session, isPending } = useSession();
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState("");

  // Redirect authenticated users away from forgot-password. `replace` (not
  // push) so /auth/* never lands in history — Back from the dashboard used to
  // remount this page and bounce forward again. Idempotency ref keeps
  // duplicate session-store emissions from queueing repeat navigations.
  const navigatedRef = useRef(false);
  useEffect(() => {
    if (!isPending && session?.user?.id && !navigatedRef.current) {
      navigatedRef.current = true;
      router.replace("/dashboard");
    }
  }, [isPending, session, router]);

  const handleRequestReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setMessage(""); // Clear previous messages
    toast({ title: "Sending reset link..." });

    try {
      const { error } = await authClient.requestPasswordReset({
        email,
        redirectTo: "/auth/reset-password",
      });
      if (error) {
        setMessage(error.message || "An unexpected error occurred.");
        toast({
          title: "Error Sending Request",
          description: error.message || "An unexpected error occurred.",
          variant: "destructive",
        });
      } else {
        const successMessage =
          "If an account with that email exists, a password reset link has been sent.";
        setMessage(successMessage);
        toast({ title: "Request Sent", description: successMessage });
      }
    } catch (error: unknown) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "auth" } },
      );
      console.error("Forgot password error:", error);
      const errorMessage =
        error instanceof Error
          ? error.message
          : "An unexpected error occurred.";
      setMessage(errorMessage);
      toast({
        title: "Error Sending Request",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 p-6 text-white">
      <div className="mx-auto flex w-full max-w-md flex-col">
        <div className="text-center">
          <GlobeIcon className="mx-auto h-10 w-auto text-white" />
          <h2 className="mt-6 text-fluid-3xl font-semibold tracking-tight">
            Forgot your password?
          </h2>
          <p className="mt-2 text-sm text-zinc-400 md:text-base">
            Enter your email address and we&apos;ll send you a link to reset it.
          </p>
        </div>
        <form className="mt-8 space-y-6" onSubmit={handleRequestReset}>
          <div className="grid gap-2">
            <Label htmlFor="email" className="sr-only">
              Email address
            </Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={isLoading}
            />
          </div>

          {message && (
            <p
              className={`text-sm ${message.includes("Error") ? "text-red-400" : "text-green-400"}`}
            >
              {message}
            </p>
          )}

          <Button
            type="submit"
            className="w-full bg-white text-black hover:bg-white/90"
            disabled={isLoading}
          >
            {isLoading ? "Sending..." : "Send Reset Link"}
          </Button>
        </form>
        <div className="mt-6 text-center text-sm">
          <Link
            href="/auth/signin"
            className="font-medium text-zinc-300 underline-offset-4 hover:text-white hover:underline"
          >
            Remembered your password? Sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
