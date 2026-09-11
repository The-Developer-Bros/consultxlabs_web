"use client";

import { useState } from "react";
import { cn } from "@/utils/tailwind";
import {
  Clock,
  AlertCircle,
  XCircle,
  Shield,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  FileText,
  CheckCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import type { VerificationStatus } from "./VerificationStatusBadge";

interface DocumentFeedback {
  documentId: string;
  fileName: string;
  originalName?: string;
  isValid: boolean | null;
  staffFeedback?: string | null;
}

interface VerificationPendingOverlayProps {
  status: VerificationStatus;
  rejectionReason?: string;
  feedbackDetails?: string;
  documentFeedback?: DocumentFeedback[];
  resubmitUrl?: string;
  className?: string;
}

const statusContent: Record<
  Exclude<VerificationStatus, "VERIFIED">,
  {
    icon: typeof Clock;
    title: string;
    description: string;
    iconBg: string;
    iconColor: string;
  }
> = {
  // PENDING_VERIFICATION is ACTIONABLE: the consultant still has to
  // complete/submit their verification from Settings. The old passive
  // "Awaiting Verification" copy contradicted the Settings page (which
  // says "Submit for Verification") and stranded new consultants.
  PENDING_VERIFICATION: {
    icon: Clock,
    title: "Complete your verification",
    description:
      "Your profile isn't visible to clients yet. Submit your verification details from Settings so clients can find and book you — reviews typically take 1-2 business days.",
    iconBg: "bg-amber-100",
    iconColor: "text-amber-600",
  },
  UNDER_REVIEW: {
    icon: Shield,
    title: "Verification Under Review",
    description:
      "Our team is currently reviewing your profile. This usually takes 1-2 business days. You'll receive an email once the review is complete.",
    iconBg: "bg-blue-100",
    iconColor: "text-blue-600",
  },
  REJECTED: {
    icon: XCircle,
    title: "Verification Not Approved",
    description:
      "Unfortunately, your verification was not approved. Please review the feedback below and update your profile.",
    iconBg: "bg-red-100",
    iconColor: "text-red-600",
  },
};

export function VerificationPendingOverlay({
  status,
  rejectionReason,
  feedbackDetails,
  documentFeedback,
  resubmitUrl = "/settings/verification",
  className,
}: VerificationPendingOverlayProps) {
  const [showDetails, setShowDetails] = useState(false);

  // Don't show overlay for verified consultants
  if (status === "VERIFIED") {
    return null;
  }

  const content = statusContent[status];
  const Icon = content.icon;
  const hasDetailedFeedback =
    feedbackDetails || (documentFeedback && documentFeedback.length > 0);
  const invalidDocuments =
    documentFeedback?.filter((doc) => doc.isValid === false) || [];

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center bg-white/95 backdrop-blur-sm overflow-y-auto py-8",
        className,
      )}
    >
      <div className="max-w-lg mx-auto p-8 text-center">
        <div
          className={cn(
            "w-16 h-16 mx-auto mb-6 rounded-full flex items-center justify-center",
            content.iconBg,
          )}
        >
          <Icon className={cn("w-8 h-8", content.iconColor)} />
        </div>

        <h2 className="text-2xl font-bold text-zinc-900 mb-3">
          {content.title}
        </h2>

        <p className="text-zinc-600 mb-6">{content.description}</p>

        {status === "REJECTED" && rejectionReason && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4 text-left">
            <p className="text-sm font-medium text-red-800 mb-1">
              Reason for rejection:
            </p>
            <p className="text-sm text-red-700">{rejectionReason}</p>
          </div>
        )}

        {/* Detailed feedback section */}
        {status === "REJECTED" && hasDetailedFeedback && (
          <div className="mb-6">
            <button
              onClick={() => setShowDetails(!showDetails)}
              className="flex items-center justify-center gap-2 w-full py-2 text-sm font-medium text-zinc-600 hover:text-zinc-900 transition-colors"
            >
              {showDetails ? (
                <>
                  <ChevronUp className="w-4 h-4" />
                  Hide detailed feedback
                </>
              ) : (
                <>
                  <ChevronDown className="w-4 h-4" />
                  View detailed feedback
                </>
              )}
            </button>

            {showDetails && (
              <div className="mt-3 space-y-4 text-left">
                {/* Detailed feedback text */}
                {feedbackDetails && (
                  <div className="bg-zinc-50 border border-zinc-200 rounded-lg p-4">
                    <p className="text-sm font-medium text-zinc-700 mb-2">
                      Additional feedback from reviewer:
                    </p>
                    <p className="text-sm text-zinc-600 whitespace-pre-wrap">
                      {feedbackDetails}
                    </p>
                  </div>
                )}

                {/* Per-document feedback */}
                {invalidDocuments.length > 0 && (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                    <p className="text-sm font-medium text-amber-800 mb-3">
                      Documents requiring attention:
                    </p>
                    <ul className="space-y-3">
                      {invalidDocuments.map((doc) => (
                        <li
                          key={doc.documentId}
                          className="flex items-start gap-3 text-sm"
                        >
                          <FileText className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
                          <div>
                            <p className="font-medium text-amber-900">
                              {doc.originalName || doc.fileName}
                            </p>
                            {doc.staffFeedback && (
                              <p className="text-amber-700 mt-0.5">
                                {doc.staffFeedback}
                              </p>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Valid documents */}
                {documentFeedback &&
                  documentFeedback.filter((doc) => doc.isValid === true)
                    .length > 0 && (
                    <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                      <p className="text-sm font-medium text-green-800 mb-2">
                        Verified documents:
                      </p>
                      <ul className="space-y-2">
                        {documentFeedback
                          .filter((doc) => doc.isValid === true)
                          .map((doc) => (
                            <li
                              key={doc.documentId}
                              className="flex items-center gap-2 text-sm text-green-700"
                            >
                              <CheckCircle className="w-4 h-4 flex-shrink-0" />
                              <span>{doc.originalName || doc.fileName}</span>
                            </li>
                          ))}
                      </ul>
                    </div>
                  )}
              </div>
            )}
          </div>
        )}

        {(status === "PENDING_VERIFICATION" || status === "UNDER_REVIEW") && (
          <div className="space-y-4">
            {status === "UNDER_REVIEW" && (
              <div className="flex items-center justify-center gap-2 text-sm text-zinc-500">
                <AlertCircle className="w-4 h-4" />
                <span>
                  You&apos;ll receive an email once the review is complete
                </span>
              </div>
            )}
            <Button asChild className="gap-2">
              <Link href={resubmitUrl}>
                {status === "PENDING_VERIFICATION"
                  ? "Complete Verification"
                  : "View Settings"}
                <ArrowRight className="w-4 h-4" />
              </Link>
            </Button>
          </div>
        )}

        {status === "REJECTED" && (
          <Button asChild className="gap-2">
            <Link href={resubmitUrl}>
              Update Profile & Resubmit
              <ArrowRight className="w-4 h-4" />
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Compact banner variant for the dashboard shell's banner slot.
 *
 * Gating policy (product decision, dashboard redesign): the waiting states
 * (PENDING_VERIFICATION / UNDER_REVIEW) must NOT wall off the dashboard —
 * an unverified consultant can't take bookings anyway, so the pages are
 * harmless empty states and walling them just hides the product. Only
 * REJECTED keeps the full-screen `VerificationPendingOverlay` (with the
 * reviewer feedback threaded in) because it demands an action before the
 * consultant can operate.
 */
export function VerificationBanner({
  status,
  resubmitUrl = "/settings/verification",
}: {
  status: VerificationStatus;
  resubmitUrl?: string;
}) {
  if (status !== "PENDING_VERIFICATION" && status !== "UNDER_REVIEW") {
    return null;
  }

  const isActionable = status === "PENDING_VERIFICATION";
  const Icon = isActionable ? Clock : Shield;

  return (
    <div
      className={cn(
        "border-b px-4 sm:px-6 py-2.5 flex items-start gap-3 text-sm",
        isActionable
          ? "bg-amber-50 border-amber-200 text-amber-900"
          : "bg-blue-50 border-blue-200 text-blue-900",
      )}
    >
      <Icon className="w-4 h-4 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        {isActionable ? (
          <>
            <span className="font-semibold">Complete your verification.</span>{" "}
            <span>
              Your profile isn&apos;t visible to clients until you submit your
              verification details.
            </span>
          </>
        ) : (
          <>
            <span className="font-semibold">Verification under review.</span>{" "}
            <span>
              Our team is reviewing your profile — you&apos;ll receive an email
              once the review is complete (usually 1-2 business days).
            </span>
          </>
        )}
      </div>
      {isActionable && (
        <Link
          href={resubmitUrl}
          className="shrink-0 inline-flex items-center gap-1 font-semibold text-amber-900 hover:text-amber-700 transition-colors"
        >
          Complete verification
          <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      )}
    </div>
  );
}

// Card variant for embedding in pages
export function VerificationPendingCard({
  status,
  rejectionReason,
  feedbackDetails,
  documentFeedback,
  resubmitUrl = "/settings/verification",
  className,
}: VerificationPendingOverlayProps) {
  const [showDetails, setShowDetails] = useState(false);

  if (status === "VERIFIED") {
    return null;
  }

  const content = statusContent[status];
  const Icon = content.icon;
  const hasDetailedFeedback =
    feedbackDetails || (documentFeedback && documentFeedback.length > 0);
  const invalidDocuments =
    documentFeedback?.filter((doc) => doc.isValid === false) || [];

  return (
    <div
      className={cn(
        "rounded-xl border-2 border-dashed p-6",
        status === "PENDING_VERIFICATION" && "border-amber-300 bg-amber-50",
        status === "UNDER_REVIEW" && "border-blue-300 bg-blue-50",
        status === "REJECTED" && "border-red-300 bg-red-50",
        className,
      )}
    >
      <div className="flex items-start gap-4">
        <div
          className={cn(
            "flex-shrink-0 w-12 h-12 rounded-full flex items-center justify-center",
            content.iconBg,
          )}
        >
          <Icon className={cn("w-6 h-6", content.iconColor)} />
        </div>

        <div className="flex-1">
          <h3 className="font-semibold text-zinc-900 mb-1">{content.title}</h3>
          <p className="text-sm text-zinc-600 mb-3">{content.description}</p>

          {status === "REJECTED" && rejectionReason && (
            <div className="bg-red-100 border border-red-200 rounded-lg p-3 mb-3 text-left">
              <p className="text-xs font-medium text-red-800 mb-0.5">Reason:</p>
              <p className="text-sm text-red-700">{rejectionReason}</p>
            </div>
          )}

          {/* Detailed feedback section */}
          {status === "REJECTED" && hasDetailedFeedback && (
            <div className="mb-3">
              <button
                onClick={() => setShowDetails(!showDetails)}
                className="flex items-center gap-1.5 text-xs font-medium text-zinc-600 hover:text-zinc-900 transition-colors"
              >
                {showDetails ? (
                  <>
                    <ChevronUp className="w-3.5 h-3.5" />
                    Hide details
                  </>
                ) : (
                  <>
                    <ChevronDown className="w-3.5 h-3.5" />
                    View details
                  </>
                )}
              </button>

              {showDetails && (
                <div className="mt-2 space-y-2">
                  {feedbackDetails && (
                    <div className="bg-zinc-100 rounded-lg p-3">
                      <p className="text-xs font-medium text-zinc-700 mb-1">
                        Additional feedback:
                      </p>
                      <p className="text-xs text-zinc-600 whitespace-pre-wrap">
                        {feedbackDetails}
                      </p>
                    </div>
                  )}

                  {invalidDocuments.length > 0 && (
                    <div className="bg-amber-100 rounded-lg p-3">
                      <p className="text-xs font-medium text-amber-800 mb-2">
                        Documents to fix:
                      </p>
                      <ul className="space-y-1.5">
                        {invalidDocuments.map((doc) => (
                          <li
                            key={doc.documentId}
                            className="flex items-start gap-2 text-xs"
                          >
                            <FileText className="w-3.5 h-3.5 text-amber-600 mt-0.5 flex-shrink-0" />
                            <div>
                              <span className="font-medium text-amber-900">
                                {doc.originalName || doc.fileName}
                              </span>
                              {doc.staffFeedback && (
                                <span className="text-amber-700">
                                  : {doc.staffFeedback}
                                </span>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {status === "REJECTED" && (
            <Button asChild size="sm" className="gap-1.5">
              <Link href={resubmitUrl}>
                Update Profile & Resubmit
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
