"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckoutResultSkeleton } from "@/app/checkout/CheckoutSkeletons";
import { XCircle, RefreshCw, ArrowLeft, MessageCircle } from "lucide-react";

function CheckoutFailureContent() {
  const [error, setError] = useState<string>("");
  const searchParams = useSearchParams();
  const router = useRouter();

  const paymentIntent = searchParams.get("payment_intent");
  const errorMessage = searchParams.get("error");

  useEffect(() => {
    // Set error message from URL params or default
    setError(errorMessage || "Payment failed. Please try again.");
  }, [errorMessage]);

  const handleRetryPayment = () => {
    // Go back to the previous page to retry
    router.back();
  };

  const handleContactSupport = () => {
    // E2E-audit fix — /support does not exist as a public route; the support
    // hub lives inside the dashboard. Carry the failure context in the query
    // so the dashboard landing can route it onward.
    const supportUrl = `/dashboard?issue=payment_failed${paymentIntent ? `&payment_intent=${paymentIntent}` : ""}`;
    router.push(supportUrl);
  };

  const commonFailureReasons = [
    {
      title: "Card Declined",
      description:
        "Your bank declined the payment. Contact your bank or try a different card.",
    },
    {
      title: "Insufficient Funds",
      description:
        "There may not be enough balance in your account. Check your account balance.",
    },
    {
      title: "Technical Issue",
      description:
        "A temporary technical issue occurred. Please try again in a few minutes.",
    },
    {
      title: "Authentication Failed",
      description:
        "Card authentication failed. Make sure all details are correct and try again.",
    },
  ];

  return (
    <div className="min-h-screen bg-muted py-12">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-8">
          <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-red-100 flex items-center justify-center">
            <XCircle className="h-10 w-10 text-red-600" />
          </div>
          <h1 className="text-fluid-3xl font-bold tracking-tight text-foreground mb-2">
            Payment Failed
          </h1>
          <p className="text-muted-foreground">
            We couldn&apos;t process your payment. Don&apos;t worry, no charges
            were made.
          </p>
        </div>

        <Card className="mb-6 border-border shadow-lg">
          <CardHeader className="border-b border-border">
            <CardTitle className="text-red-600">Error Details</CardTitle>
          </CardHeader>
          <CardContent className="pt-6">
            <p className="text-muted-foreground mb-4">{error}</p>
            {paymentIntent && (
              <div className="text-sm text-muted-foreground/70 border-t border-border pt-4 font-mono break-all">
                Payment Intent ID: {paymentIntent}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="mb-6 border-border shadow-lg">
          <CardHeader className="border-b border-border">
            <CardTitle className="text-foreground">
              Common Reasons for Payment Failure
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="space-y-4">
              {commonFailureReasons.map((reason, index) => (
                <div key={index} className="border-l-4 border-border pl-4">
                  <h4 className="font-medium text-foreground">{reason.title}</h4>
                  <p className="text-sm text-muted-foreground">
                    {reason.description}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Button
            onClick={handleRetryPayment}
            className="flex items-center justify-center gap-2"
          >
            <RefreshCw className="h-4 w-4" />
            Try Again
          </Button>

          <Button
            variant="outline"
            onClick={() => router.push("/dashboard")}
            className="flex items-center justify-center gap-2"
          >
            <ArrowLeft className="h-4 w-4" />
            Go to Dashboard
          </Button>

          <Button
            variant="outline"
            onClick={handleContactSupport}
            className="flex items-center justify-center gap-2"
          >
            <MessageCircle className="h-4 w-4" />
            Contact Support
          </Button>
        </div>

        <div className="mt-8 bg-foreground border border-border rounded-xl p-5">
          <h3 className="font-medium text-background mb-3">
            What happens next?
          </h3>
          <ul className="text-sm text-background/70 space-y-2">
            <li className="flex items-start gap-2">
              <span className="text-background/50">•</span>
              No charges were made to your payment method
            </li>
            <li className="flex items-start gap-2">
              <span className="text-background/50">•</span>
              Your booking slot is still available for a limited time
            </li>
            <li className="flex items-start gap-2">
              <span className="text-background/50">•</span>
              You can retry with the same or different payment method
            </li>
            <li className="flex items-start gap-2">
              <span className="text-background/50">•</span>
              Contact support if you continue to experience issues
            </li>
          </ul>
        </div>

        <div className="mt-6 text-center text-sm text-muted-foreground">
          <p>
            Need immediate assistance?{" "}
            <a
              href="/dashboard"
              className="text-foreground font-medium hover:underline"
            >
              Contact our support team
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function CheckoutFailurePage() {
  return (
    <Suspense fallback={<CheckoutResultSkeleton />}>
      <CheckoutFailureContent />
    </Suspense>
  );
}
