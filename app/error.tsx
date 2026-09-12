"use client";

import { useEffect, useState } from "react";
import * as Sentry from "@sentry/nextjs";
import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatEta } from "@/utils/formatting";

import familiariseLogo from "@/public/avif/static/assets/logos/images/logos/Familiarise-logos_transparent.avif";

type MaintenancePhase = "OFF" | "DEGRADED" | "OFFLINE";

interface MaintenanceInfo {
  phase: MaintenancePhase | null;
  reason: string | null;
  estimatedEnd: string | null;
}

export default function GlobalError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>) {
  const [maintenance, setMaintenance] = useState<MaintenanceInfo | null>(null);

  useEffect(() => {
    console.error("[GlobalError]", error);
    // Report client-boundary errors to Sentry — server render errors are already
    // captured by onRequestError, but a client error caught here was silent.
    Sentry.captureException(error);
  }, [error]);

  useEffect(() => {
    // #1554-follow — a single check, not the /maintenance page's polling loop:
    // this boundary only needs to know whether an active maintenance phase
    // explains the render it is already showing, not to track the phase over
    // time. /api/health is exempt from the maintenance gate (middleware.ts).
    let cancelled = false;
    fetch("/api/health")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        setMaintenance({
          phase: data?.maintenance?.phase ?? null,
          reason: data?.maintenance?.reason ?? null,
          estimatedEnd: data?.maintenance?.estimatedEnd ?? null,
        });
      })
      .catch(() => {
        // A failed health call means the phase is genuinely unknown, so the
        // generic card below stays the honest default.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const isMaintenance =
    maintenance?.phase === "DEGRADED" || maintenance?.phase === "OFFLINE";

  if (isMaintenance) {
    return (
      <div className="container mx-auto pt-24 py-8 px-4 min-h-[calc(100vh-400px)] flex items-center justify-center">
        <div
          data-testid="maintenance-error"
          className="mx-auto max-w-md px-6 text-center"
        >
          <div className="mb-8">
            <Image
              src={familiariseLogo}
              alt="Familiarise"
              width={180}
              height={40}
              className="mx-auto"
              priority
            />
          </div>
          <h1 className="mb-3 text-fluid-3xl font-semibold tracking-tight text-foreground">
            We&apos;re doing scheduled maintenance
          </h1>
          <p className="mb-6 text-muted-foreground">
            {maintenance.reason ||
              "Familiarise is undergoing scheduled maintenance. We'll be back shortly with a better experience."}
          </p>
          {maintenance.estimatedEnd && (
            <div className="mb-8 rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm">
              <span className="font-medium">Estimated return:</span>{" "}
              {formatEta(maintenance.estimatedEnd)}
            </div>
          )}
          <div className="flex justify-center gap-4">
            <Button variant="outline" onClick={() => reset()}>
              Try Again
            </Button>
            <Button variant="outline" asChild>
              <Link href="/">Return Home</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="generic-error"
      className="container mx-auto pt-24 py-8 px-4 min-h-[calc(100vh-400px)]"
    >
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
