"use client";

import { use, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { TableSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { fetchDocuments, type DocumentFetchError } from "../../utils/fetchHelpers";
import { DocumentsTab } from "./DocumentsTab";
import {
  RefreshCw,
  WifiOff,
  Database,
  ShieldX,
  HelpCircle,
  AlertCircle,
} from "lucide-react";

const DEFAULT_PAGE_SIZE = 10;

export default function DocumentsPage({
  params,
}: {
  params: Promise<{ consultantId: string }>;
}) {
  const { consultantId } = use(params);

  // Pagination + filter state lifted up from DocumentsTab so the React Query
  // key depends on them. This is what makes server-side pagination work with
  // `keepPreviousData` for smooth Previous/Next transitions (issue #346).
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");

  const apiStatus = statusFilter === "all" ? undefined : statusFilter;
  const apiType = typeFilter === "all" ? undefined : typeFilter;
  const offset = (page - 1) * pageSize;

  const {
    data: documentsPage,
    isLoading,
    error,
    refetch,
    isRefetching,
    isPlaceholderData,
  } = useQuery({
    queryKey: [
      "documents",
      consultantId,
      { page, pageSize, status: apiStatus, type: apiType },
    ],
    queryFn: () =>
      fetchDocuments(consultantId, {
        limit: pageSize,
        offset,
        status: apiStatus,
        appointmentType: apiType,
      }),
    placeholderData: keepPreviousData,
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: (failureCount, error) => {
      // Don't retry on authentication or permission errors
      if (
        error instanceof Error &&
        (error.message.includes("sign in") ||
          error.message.includes("permission") ||
          error.message.includes("Access denied"))
      ) {
        return false;
      }
      // Retry up to 2 times for other errors
      return failureCount < 2;
    },
  });

  const getErrorIcon = (error: Error) => {
    if (
      error.message.includes("connection") ||
      error.message.includes("Network")
    ) {
      return <WifiOff className="h-5 w-5" />;
    } else if (
      error.message.includes("temporarily unavailable") ||
      error.message.includes("Database")
    ) {
      return <Database className="h-5 w-5" />;
    } else if (
      error.message.includes("permission") ||
      error.message.includes("Access denied")
    ) {
      return <ShieldX className="h-5 w-5" />;
    } else if (
      error.message.includes("not found") ||
      error.message.includes("check the URL")
    ) {
      return <HelpCircle className="h-5 w-5" />;
    }
    return <AlertCircle className="h-5 w-5" />;
  };

  const getErrorActions = (error: Error) => {
    const actions = [];

    // Always show retry button unless it's a permission error
    if (
      !error.message.includes("permission") &&
      !error.message.includes("Access denied")
    ) {
      actions.push(
        <Button
          key="retry"
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isRefetching}
        >
          <RefreshCw
            className={`h-4 w-4 mr-1 ${isRefetching ? "animate-spin" : ""}`}
          />
          {isRefetching ? "Retrying..." : "Try Again"}
        </Button>,
      );
    }

    // Show different additional actions based on error type
    if (error.message.includes("sign in")) {
      actions.push(
        <Button
          key="signin"
          size="sm"
          onClick={() => (window.location.href = "/auth/signin")}
        >
          Sign In
        </Button>,
      );
    } else if (
      error.message.includes("Network") ||
      error.message.includes("connection")
    ) {
      actions.push(
        <Button
          key="refresh"
          variant="outline"
          size="sm"
          onClick={() => window.location.reload()}
        >
          Refresh Page
        </Button>,
      );
    }

    return actions;
  };

  if (isLoading) {
    return <TableSkeleton />;
  }

  if (error) {
    return (
      <DashboardErrorBoundary>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="max-w-lg w-full">
            <Alert variant="destructive" className="mb-4">
              <div className="flex items-start space-x-2">
                {getErrorIcon(error)}
                <div className="flex-1">
                  <AlertTitle className="text-base font-semibold mb-2">
                    Unable to Load Documents
                  </AlertTitle>
                  <AlertDescription className="text-sm mb-4">
                    {error.message}
                  </AlertDescription>

                  {/* Technical details for debugging (only show in development) */}
                  {process.env.NODE_ENV === "development" &&
                    (error as DocumentFetchError).technicalMessage && (
                      <details className="mt-3 text-xs opacity-75">
                        <summary className="cursor-pointer">
                          Technical Details
                        </summary>
                        <pre className="mt-2 whitespace-pre-wrap">
                          {(error as DocumentFetchError).technicalMessage}
                        </pre>
                      </details>
                    )}

                  <div className="flex flex-wrap gap-2 mt-4">
                    {getErrorActions(error)}
                  </div>
                </div>
              </div>
            </Alert>

            {/* Helpful tips based on error type */}
            {error.message.includes("Network") && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mt-4">
                <h4 className="text-sm font-medium text-blue-800 mb-2">
                  Connection Troubleshooting
                </h4>
                <ul className="text-sm text-blue-700 space-y-1">
                  <li>• Check your internet connection</li>
                  <li>• Try refreshing the page</li>
                  <li>
                    • Contact your IT administrator if on a corporate network
                  </li>
                </ul>
              </div>
            )}

            {error.message.includes("temporarily unavailable") && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mt-4">
                <h4 className="text-sm font-medium text-yellow-800 mb-2">
                  System Status
                </h4>
                <p className="text-sm text-yellow-700">
                  The document system is temporarily experiencing issues. Please
                  try again in a few moments. If the problem persists, contact
                  support.
                </p>
              </div>
            )}
          </div>
        </div>
      </DashboardErrorBoundary>
    );
  }

  return (
    <DashboardErrorBoundary>
      <div className="min-w-0 overflow-x-hidden">
        <DocumentsTab
          documentsPage={documentsPage}
          isPlaceholderData={isPlaceholderData}
          onRefresh={refetch}
          page={page}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(next) => {
            setPageSize(next);
            setPage(1);
          }}
          statusFilter={statusFilter}
          typeFilter={typeFilter}
          onStatusFilterChange={(next) => {
            setStatusFilter(next);
            setPage(1);
          }}
          onTypeFilterChange={(next) => {
            setTypeFilter(next);
            setPage(1);
          }}
        />
      </div>
    </DashboardErrorBoundary>
  );
}
