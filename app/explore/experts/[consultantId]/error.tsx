"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import Link from "next/link";

/**
 * Segment error boundary for the expert detail page. Since #1119 the known
 * cross-region transient (#932) is NO LONGER swallowed upstream — degrading gave
 * a 200 that Netlify wrote into the durable cache and replayed to everyone — so
 * this boundary is exactly where a pooler timeout now lands. Give the visitor a
 * retry rather than falling through to the global crash page.
 */
export default function ExpertProfileError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // A server render error already reached Sentry through onRequestError
  // (instrumentation.ts) and arrives here carrying its digest. Capturing it again
  // would file a second issue for every one of those — and since #1119 that is now
  // the common path, not the rare one. Only report errors that originated on the
  // client, which have no digest.
  useEffect(() => {
    if (!error.digest) Sentry.captureException(error);
  }, [error]);

  return (
    <div className="bg-muted min-h-screen">
      <div className="bg-card border-b border-border">
        <div className="w-full px-4 py-4 md:px-8 lg:px-12">
          <Link
            href="/explore/experts"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← Back to experts
          </Link>
        </div>
      </div>
      <div className="flex w-full items-center justify-center px-4 py-24 md:px-8 lg:px-12">
        <div className="max-w-md space-y-4 text-center">
          <h1 className="text-2xl font-semibold text-foreground">
            Something went wrong
          </h1>
          <p className="text-muted-foreground">
            We hit an unexpected error loading this profile. Please try again.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            className="mt-2 inline-flex items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}
