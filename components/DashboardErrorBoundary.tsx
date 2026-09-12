"use client";

import React from "react";
import * as Sentry from "@sentry/nextjs";
import ErrorBoundary from "./ErrorBoundary";
import { Button } from "@/components/ui/button";

interface DashboardErrorFallbackProps {
  error: Error | null;
  resetError: () => void;
}

function DashboardErrorFallback({
  error,
  resetError,
}: DashboardErrorFallbackProps) {
  return (
    <div className="flex items-center justify-center min-h-[50vh] p-6">
      <div className="text-center max-w-lg">
        <div className="bg-orange-50 border border-orange-200 rounded-lg p-6">
          <div className="text-orange-600 mb-4">
            <svg
              className="w-16 h-16 mx-auto mb-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
              />
            </svg>
          </div>
          <h3 className="text-xl font-semibold text-orange-800 mb-2">
            Dashboard Error
          </h3>
          <p className="text-orange-700 mb-4">
            There was a problem loading your dashboard. This might be due to a
            temporary issue with the data or a network connection problem.
          </p>
          <p className="text-sm text-orange-600 mb-6">
            {error?.message ||
              "An unexpected error occurred while loading the dashboard"}
          </p>
          <div className="space-y-3">
            <Button
              onClick={resetError}
              variant="outline"
              className="w-full border-orange-300 text-orange-700 hover:bg-orange-50"
            >
              <svg
                className="w-4 h-4 mr-2"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              Retry loading
            </Button>
            <Button
              onClick={() => window.location.reload()}
              className="w-full bg-orange-600 hover:bg-orange-700"
            >
              <svg
                className="w-4 h-4 mr-2"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              Refresh page
            </Button>
          </div>
          <div className="mt-4 pt-4 border-t border-orange-200">
            <p className="text-xs text-orange-600">
              If this problem persists, please contact support or try again
              later.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

interface DashboardErrorBoundaryProps {
  children: React.ReactNode;
}

export function DashboardErrorBoundary({
  children,
}: DashboardErrorBoundaryProps) {
  return (
    <ErrorBoundary
      fallback={DashboardErrorFallback}
      onError={(error, errorInfo) => {
        // #1580: a dashboard crash reached here with no Sentry issue.
        // Capture it so a repeat is visible instead of console-only.
        console.error("Dashboard error:", error, errorInfo);
        Sentry.captureException(error, {
          tags: { subsystem: "dashboard", boundary: "DashboardErrorBoundary" },
          extra: { componentStack: errorInfo.componentStack },
        });
      }}
    >
      {children}
    </ErrorBoundary>
  );
}
