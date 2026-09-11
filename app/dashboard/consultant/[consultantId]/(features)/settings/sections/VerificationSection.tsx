"use client";

import { useState } from "react";
import { Button } from "components/ui/button";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import { useToast } from "components/ui/use-toast";
import ConsultantVerificationForm from "@/app/form/onboarding/components/ConsultantVerificationForm";
import {
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Clock,
  FileText,
  Loader2,
  RefreshCw,
  Shield,
  XCircle,
} from "lucide-react";
import type { ConsultantVerificationStatus } from "@prisma/client";
import type { TConsultantProfile } from "types/consultant";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { verificationStatusBadge } from "@/lib/labels/session-labels";
import { useVerificationStatus } from "../../../hooks/useVerificationStatus";
import { useSession } from "@/lib/auth-client";

interface VerificationDocument {
  id?: string;
  status: string;
}

interface VerificationSubmitData {
  verificationLinkedinUrl?: string;
  verificationNotes?: string;
  verificationDocuments?: VerificationDocument[];
}

// One tone entry per status replaces the 4-way ternary walls that used to
// repeat for every color decision in the monolith.
const STATUS_TONE: Record<
  ConsultantVerificationStatus,
  {
    icon: typeof CheckCircle;
    card: string;
    iconWrap: string;
    icon_: string;
    heading: string;
    body: string;
    title: string;
    description: string;
  }
> = {
  VERIFIED: {
    icon: CheckCircle,
    card: "border-green-200 bg-green-50",
    iconWrap: "bg-green-100",
    icon_: "text-green-600",
    heading: "text-green-900",
    body: "text-green-700",
    title: "Profile Verified",
    description:
      "Great job! Your profile has been verified. You are now visible in the consultant directory and can accept bookings.",
  },
  PENDING_VERIFICATION: {
    icon: Clock,
    card: "border-amber-200 bg-amber-50",
    iconWrap: "bg-amber-100",
    icon_: "text-amber-600",
    heading: "text-amber-900",
    body: "text-amber-700",
    title: "Verification Required",
    description:
      "Action is needed on your profile. Please review any feedback below, make necessary updates, and submit for verification.",
  },
  UNDER_REVIEW: {
    icon: Shield,
    card: "border-blue-200 bg-blue-50",
    iconWrap: "bg-blue-100",
    icon_: "text-blue-600",
    heading: "text-blue-900",
    body: "text-blue-700",
    title: "Verification Under Review",
    description:
      "Hold tight! Our team is currently reviewing your profile details and documents. This typically takes 1-2 business days.",
  },
  REJECTED: {
    icon: XCircle,
    card: "border-red-200 bg-red-50",
    iconWrap: "bg-red-100",
    icon_: "text-red-600",
    heading: "text-red-900",
    body: "text-red-700",
    title: "Verification Not Approved",
    description:
      "Your profile verification was not approved. Please review the feedback below, update your profile as needed, and resubmit for review.",
  },
};

/**
 * Verification tab of the consultant settings page. Consumes the shared
 * ["verification-status"] query (same one the dashboard layout's banner /
 * REJECTED gate reads) so the two surfaces can never disagree, and owns the
 * resubmission modal flow.
 */
export function VerificationSection({
  consultant,
}: Readonly<{ consultant: TConsultantProfile }>) {
  const { toast } = useToast();
  const { data: session } = useSession();
  const status = consultant.verificationStatus as ConsultantVerificationStatus;
  // The endpoint reads the SIGNED-IN user's verification record, so fetch
  // only when the viewer owns this profile (an admin/staff viewing someone
  // else's settings would get their own, mismatched record) — same gating
  // as the dashboard layout's banner.
  const viewerUserId = session?.user?.id;
  const isOwnProfile = !!viewerUserId && viewerUserId === consultant.userId;
  const { data: verification, isLoading: isLoadingVerification } =
    useVerificationStatus(viewerUserId, !!status && isOwnProfile);
  const [showDetails, setShowDetails] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isResubmitting, setIsResubmitting] = useState(false);

  const latest = verification?.latestRequest ?? null;
  const invalidDocuments =
    latest?.documentFeedback?.filter((doc) => doc.isValid === false) ?? [];
  const validDocuments =
    latest?.documentFeedback?.filter((doc) => doc.isValid === true) ?? [];

  const handleVerificationSubmit = async (data: VerificationSubmitData) => {
    setIsResubmitting(true);
    try {
      const documentIds =
        data.verificationDocuments
          ?.filter(
            (doc): doc is Required<VerificationDocument> =>
              doc.status === "completed" && !!doc.id,
          )
          .map((doc) => doc.id) || [];

      const payload = {
        linkedinUrl: data.verificationLinkedinUrl,
        notes: data.verificationNotes,
        documentIds,
      };

      const res = await fetch("/api/verification/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const result = await res.json();

      if (!res.ok) {
        throw new Error(result.error || "Failed to submit verification");
      }

      toast({
        title: "Verification Submitted",
        description: "Your profile has been submitted for review successfully.",
      });

      setIsModalOpen(false);

      // Reload so the layout gate/banner and this section pick up the new
      // status from the server in one shot.
      window.location.reload();
    } catch (error) {
      console.error("Error submitting verification:", error);
      toast({
        title: "Submission Failed",
        description:
          error instanceof Error
            ? error.message
            : "Failed to submit verification",
        variant: "destructive",
      });
    } finally {
      setIsResubmitting(false);
    }
  };

  if (!status) return null;

  const tone = STATUS_TONE[status];
  const Icon = tone.icon;
  const isActionable =
    status === "REJECTED" || status === "PENDING_VERIFICATION";

  return (
    <div className={`border-2 rounded-xl p-6 ${tone.card}`}>
      <div className="flex items-start gap-4">
        <div
          className={`flex-shrink-0 w-12 h-12 rounded-full flex items-center justify-center ${tone.iconWrap}`}
        >
          <Icon className={`w-6 h-6 ${tone.icon_}`} />
        </div>

        <div className="flex-1">
          <div className="flex items-center gap-3 mb-2">
            <h2 className={`text-xl font-bold ${tone.heading}`}>
              {tone.title}
            </h2>
            <StatusBadge {...verificationStatusBadge(status)} />
          </div>
          <p className={`text-sm mb-4 ${tone.body}`}>{tone.description}</p>

          {/* Loading State */}
          {isLoadingVerification ? (
            <div className={`flex items-center gap-2 ${tone.icon_}`}>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-sm">Loading feedback...</span>
            </div>
          ) : latest ? (
            <>
              {latest.rejectionReason && (
                <div
                  className={`border rounded-lg p-4 mb-4 ${
                    status === "REJECTED"
                      ? "bg-red-100 border-red-200"
                      : "bg-amber-100 border-amber-200"
                  }`}
                >
                  <p className={`text-sm font-medium mb-1 ${tone.heading}`}>
                    {status === "REJECTED"
                      ? "Reason for rejection:"
                      : "Changes requested:"}
                  </p>
                  <p className={`text-sm ${tone.body}`}>
                    {latest.rejectionReason}
                  </p>
                </div>
              )}

              {/* Expandable Details - Only show if there are details */}
              {(latest.feedbackDetails ||
                invalidDocuments.length > 0 ||
                validDocuments.length > 0) && (
                <div className="mb-4">
                  <button
                    type="button"
                    onClick={() => setShowDetails(!showDetails)}
                    className={`flex items-center gap-2 text-sm font-medium transition-colors ${tone.body} hover:${tone.heading}`}
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
                    <div className="mt-3 space-y-3">
                      {latest.feedbackDetails && (
                        <div className="bg-white border border-zinc-200 rounded-lg p-4">
                          <p className="text-sm font-medium text-zinc-700 mb-2">
                            Additional feedback from reviewer:
                          </p>
                          <p className="text-sm text-zinc-600 whitespace-pre-wrap">
                            {latest.feedbackDetails}
                          </p>
                        </div>
                      )}

                      {invalidDocuments.length > 0 && (
                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                          <p className="text-sm font-medium text-amber-800 mb-3">
                            Documents requiring attention:
                          </p>
                          <ul className="space-y-2">
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

                      {validDocuments.length > 0 && (
                        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                          <p className="text-sm font-medium text-green-800 mb-2">
                            Verified documents:
                          </p>
                          <ul className="space-y-1">
                            {validDocuments.map((doc) => (
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
            </>
          ) : null}

          {/* Action Buttons */}
          {isActionable && (
            <div className="flex items-center gap-4">
              <Button
                type="button"
                onClick={() => setIsModalOpen(true)}
                disabled={isResubmitting}
                className="gap-2"
                variant={status === "REJECTED" ? "destructive" : "default"}
              >
                {isResubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {status === "REJECTED"
                      ? "Resubmitting..."
                      : "Submitting..."}
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4" />
                    {status === "REJECTED"
                      ? "Resubmit for Verification"
                      : "Submit for Verification"}
                  </>
                )}
              </Button>
              <p className={`text-xs ${tone.body}`}>
                Make sure to update your profile before submitting
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Verification Resubmission Modal */}
      <ResponsiveModal open={isModalOpen} onOpenChange={setIsModalOpen}>
        <ResponsiveModalContent className="max-w-2xl max-h-[90dvh] overflow-hidden flex flex-col">
          <ResponsiveModalHeader className="shrink-0">
            <ResponsiveModalTitle>Verification Details</ResponsiveModalTitle>
          </ResponsiveModalHeader>
          <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-1">
            <ConsultantVerificationForm
              onNext={handleVerificationSubmit}
              onBack={() => setIsModalOpen(false)}
              initialData={{
                verificationLinkedinUrl: consultant.user.linkedinUrl || "",
                verificationNotes: latest?.rejectionReason
                  ? `Regarding your feedback: `
                  : "",
                // Note: We can't easily pre-fill documents as UploadedDocument
                // type differs from the Prisma model, but the user can upload
                // new ones.
              }}
            />
          </div>
        </ResponsiveModalContent>
      </ResponsiveModal>
    </div>
  );
}
