"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function GlobalError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>) {
  useEffect(() => {
    console.error("[GlobalError]", error);
    // Report client-boundary errors to Sentry — server render errors are already
    // captured by onRequestError, but a client error caught here was silent.
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="container mx-auto pt-24 py-8 px-4 min-h-[calc(100vh-400px)]">
      <Card className="max-w-2xl mx-auto text-center">
        <CardHeader>
          <CardTitle>Something went wrong</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            {process.env.NODE_ENV === "development"
              ? error.message || "An unexpected error occurred."
              : "An unexpected error occurred. Please try again."}
          </p>
          {error.digest && (
            <p className="text-xs text-muted-foreground mt-2">
              Error ID: {error.digest}
            </p>
          )}
        </CardContent>
        <CardFooter className="justify-center space-x-4">
          <Button variant="outline" onClick={() => reset()}>
            Try Again
          </Button>
          <Button variant="outline" asChild>
            <Link href="/">Return Home</Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
