"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

import { formatEta } from "@/utils/formatting";

import familiariseLogo from "@/public/avif/static/assets/logos/images/logos/Familiarise-logos_transparent.avif";

const AUTO_REFRESH_INTERVAL = 30_000; // 30 seconds

export default function MaintenancePage() {
  const [eta, setEta] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    // Check maintenance status periodically and refresh when it ends
    const checkStatus = async () => {
      try {
        const res = await fetch("/api/health");
        const data = await res.json();
        if (data.maintenance?.phase === "OFF") {
          window.location.href = "/";
          return;
        }
        setEta(data.maintenance?.estimatedEnd ?? null);
        setReason(data.maintenance?.reason ?? null);
      } catch {
        // Health endpoint is exempt from maintenance — if it fails, just retry
      }
    };

    checkStatus();
    const interval = setInterval(checkStatus, AUTO_REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-gradient-to-br from-gray-50 via-white to-gray-100">
      {/* Animated background shapes */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute -left-40 -top-40 h-80 w-80 animate-pulse rounded-full bg-gray-200/40 blur-3xl" />
        <div className="absolute -bottom-40 -right-40 h-80 w-80 animate-pulse rounded-full bg-gray-200/40 blur-3xl [animation-delay:1s]" />
      </div>

      <div className="relative z-10 mx-auto max-w-md px-6 text-center">
        {/* Logo */}
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

        {/* Icon */}
        <div className="mb-6 flex justify-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
            <svg
              className="h-8 w-8 text-muted-foreground"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M11.42 15.17 17.25 21A2.652 2.652 0 0 0 21 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 1 1-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 0 0 4.486-6.336l-3.276 3.277a3.004 3.004 0 0 1-2.25-2.25l3.276-3.276a4.5 4.5 0 0 0-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085"
              />
            </svg>
          </div>
        </div>

        {/* Messaging */}
        <h1 className="mb-3 text-fluid-3xl font-semibold tracking-tight text-foreground">
          We&apos;re improving things
        </h1>
        <p className="mb-6 text-muted-foreground">
          {reason ||
            "Familiarise is undergoing scheduled maintenance. We'll be back shortly with a better experience."}
        </p>

        {/* ETA */}
        {eta && (
          <div className="mb-8 rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm">
            <span className="font-medium">Estimated return:</span>{" "}
            {formatEta(eta)}
          </div>
        )}

        {/* Progress indicator */}
        <div className="mb-8 flex justify-center gap-1.5">
          <div className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/70 [animation-delay:0ms]" />
          <div className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/70 [animation-delay:150ms]" />
          <div className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/70 [animation-delay:300ms]" />
        </div>

        <p className="text-xs text-muted-foreground/70">
          This page auto-refreshes every 30 seconds
        </p>
      </div>
    </div>
  );
}
