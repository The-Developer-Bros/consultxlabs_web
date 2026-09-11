"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import {
  ArrowLeft,
  AlertTriangle,
  Loader2,
  AlertCircle,
  Clock,
  CheckCircle,
  XCircle,
  CreditCard,
  User,
  Calendar,
  FileText,
  Lock,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatCurrencyAmount } from "@/utils/formatting";
import type { DisputeDetails } from "@/types/disputes";

const getStatusColor = (status: string) => {
  switch (status.toUpperCase()) {
    case "WON":
      return "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300";
    case "LOST":
      return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
    case "NEEDS_RESPONSE":
    case "WARNING_NEEDS_RESPONSE":
      return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300";
    case "UNDER_REVIEW":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
};

const getStatusIcon = (status: string) => {
  switch (status.toUpperCase()) {
    case "WON":
      return <CheckCircle className="h-4 w-4" />;
    case "LOST":
      return <XCircle className="h-4 w-4" />;
    case "NEEDS_RESPONSE":
    case "WARNING_NEEDS_RESPONSE":
      return <AlertTriangle className="h-4 w-4" />;
    case "UNDER_REVIEW":
      return <Clock className="h-4 w-4" />;
    default:
      return null;
  }
};

const formatDate = (dateString: string) => {
  return new Date(dateString).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const getDaysUntilDue = (dueBy: string | null) => {
  if (!dueBy) return null;
  const now = new Date();
  const due = new Date(dueBy);
  const diffDays = Math.ceil(
    (due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
  );
  return diffDays;
};

async function fetchDisputeDetails(
  apiEndpoint: string,
  disputeId: string,
): Promise<DisputeDetails> {
  const response = await fetch(`${apiEndpoint}/${disputeId}`);
  if (!response.ok) {
    throw new Error("Failed to fetch dispute details");
  }
  return response.json() as Promise<DisputeDetails>;
}

async function submitEvidence(data: {
  disputeId: string;
  evidence: Record<string, string | undefined>;
}): Promise<DisputeDetails> {
  const response = await fetch("/api/payments/disputes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to submit evidence");
  }

  return response.json() as Promise<DisputeDetails>;
}

export interface DisputeDetailPageProps {
  /** Dispute ID from URL params */
  disputeId: string;
  /** Base URL for back navigation (e.g. "/dashboard/admin", "/dashboard/staff/abc") */
  basePath: string;
  /** API endpoint for fetching this dispute (without trailing /id). Defaults to /api/admin/disputes */
  apiEndpoint?: string;
  /** Whether to show the evidence submission form (admin-only) */
  allowEvidenceSubmission?: boolean;
  /** React Query key prefix */
  queryKeyPrefix?: string;
}

export function DisputeDetailPage({
  disputeId,
  basePath,
  apiEndpoint = "/api/admin/disputes",
  allowEvidenceSubmission = false,
  queryKeyPrefix = "dispute",
}: DisputeDetailPageProps) {
  const { toast } = useToast();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [productDescription, setProductDescription] = useState("");
  const [customerSignature, setCustomerSignature] = useState("");
  const [refundPolicy, setRefundPolicy] = useState("");
  const [refundPolicyDisclosure, setRefundPolicyDisclosure] = useState("");
  const [cancellationPolicy, setCancellationPolicy] = useState("");
  const [cancellationRebuttal, setCancellationRebuttal] = useState("");
  const [additionalEvidence, setAdditionalEvidence] = useState("");
  const [showEvidenceForm, setShowEvidenceForm] = useState(false);

  const {
    data: dispute,
    isLoading,
    error,
  } = useQuery({
    queryKey: [queryKeyPrefix, disputeId],
    queryFn: () => fetchDisputeDetails(apiEndpoint, disputeId),
    staleTime: 30 * 1000,
  });

  const evidenceMutation = useMutation({
    mutationFn: submitEvidence,
    onSuccess: () => {
      toast({
        title: "Evidence Submitted",
        description: "Dispute evidence has been submitted successfully.",
      });
      queryClient.invalidateQueries({
        queryKey: [queryKeyPrefix, disputeId],
      });
      setShowEvidenceForm(false);
    },
    onError: (err: Error) => {
      toast({
        title: "Submission Failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const handleSubmitEvidence = () => {
    if (!dispute) return;

    const evidence = {
      customerName: customerName || undefined,
      customerEmailAddress: customerEmail || undefined,
      productDescription: productDescription || undefined,
      customerSignature: customerSignature || undefined,
      refundPolicy: refundPolicy || undefined,
      refundPolicyDisclosure: refundPolicyDisclosure || undefined,
      cancellationPolicy: cancellationPolicy || undefined,
      cancellationRebuttal: cancellationRebuttal || undefined,
      uncategorizedText: additionalEvidence || undefined,
    };

    evidenceMutation.mutate({
      disputeId: dispute.disputeId,
      evidence,
    });
  };

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-red-600">Error</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-gray-700">
              {error instanceof Error
                ? error.message
                : "Failed to load dispute details"}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading || !dispute) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
      </div>
    );
  }

  const daysUntilDue = getDaysUntilDue(dispute.dueBy);
  const isUrgent =
    daysUntilDue !== null && daysUntilDue <= 3 && daysUntilDue >= 0;
  const needsResponse =
    dispute.status === "NEEDS_RESPONSE" ||
    dispute.status === "WARNING_NEEDS_RESPONSE";
  const canSubmitEvidence =
    allowEvidenceSubmission &&
    [
      "NEEDS_RESPONSE",
      "WARNING_NEEDS_RESPONSE",
      "UNDER_REVIEW",
    ].includes(dispute.status);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            onClick={() => router.push(`${basePath}/disputes`)}
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
              Dispute Details
            </h1>
            <p className="text-zinc-500 dark:text-zinc-400 font-mono">
              {dispute.disputeId || dispute.id.slice(-12).toUpperCase()}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            className={`${getStatusColor(dispute.status)} gap-1 text-sm px-3 py-1`}
            variant="secondary"
          >
            {getStatusIcon(dispute.status)}
            {dispute.status.toLowerCase().replace(/_/g, " ")}
          </Badge>
          {canSubmitEvidence && !showEvidenceForm && (
            <Button onClick={() => setShowEvidenceForm(true)}>
              Submit Evidence
            </Button>
          )}
        </div>
      </div>

      {/* Urgent Alert */}
      {isUrgent && needsResponse && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Urgent: Response Required</AlertTitle>
          <AlertDescription>
            This dispute is due{" "}
            {daysUntilDue === 0 ? "today" : `in ${daysUntilDue} days`}.
            {allowEvidenceSubmission
              ? " Submit evidence as soon as possible."
              : " Please escalate to an admin immediately for evidence submission."}
          </AlertDescription>
        </Alert>
      )}

      {/* Read-Only Notice (staff view) */}
      {!allowEvidenceSubmission && (
        <Alert>
          <Lock className="h-4 w-4" />
          <AlertTitle>Staff View (Read-Only)</AlertTitle>
          <AlertDescription>
            As a staff member, you can view dispute details but cannot submit
            evidence. Please escalate to an admin if action is required.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Dispute Information */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-yellow-600" />
              Dispute Information
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-sm text-zinc-500">Dispute Amount</p>
                <p className="text-xl font-bold">
                  {formatCurrencyAmount(dispute.amountPaise, dispute.currency)}
                </p>
              </div>
              <div>
                <p className="text-sm text-zinc-500">Payment Gateway</p>
                <p className="font-medium">{dispute.paymentGateway}</p>
              </div>
            </div>

            <Separator />

            <div>
              <p className="text-sm text-zinc-500">Reason</p>
              <p className="font-medium">{dispute.reason || "Not specified"}</p>
            </div>

            {dispute.dueBy && (
              <div
                className={
                  isUrgent ? "p-3 rounded-lg bg-red-50 dark:bg-red-950/20" : ""
                }
              >
                <p className="text-sm text-zinc-500">Response Due By</p>
                <p className={`font-medium ${isUrgent ? "text-red-600" : ""}`}>
                  {formatDate(dispute.dueBy)}
                </p>
                {daysUntilDue !== null && daysUntilDue >= 0 && (
                  <p
                    className={`text-sm ${isUrgent ? "text-red-500" : "text-zinc-400"}`}
                  >
                    {daysUntilDue === 0
                      ? "Due today!"
                      : `${daysUntilDue} days remaining`}
                  </p>
                )}
              </div>
            )}

            <Separator />

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-sm text-zinc-500">Created</p>
                <p className="font-medium">{formatDate(dispute.createdAt)}</p>
              </div>
              <div>
                <p className="text-sm text-zinc-500">Last Updated</p>
                <p className="font-medium">{formatDate(dispute.updatedAt)}</p>
              </div>
            </div>

            <div>
              <p className="text-sm text-zinc-500">Charge Refundable</p>
              <p className="font-medium">
                {dispute.isChargeRefundable ? "Yes" : "No"}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Payment Information */}
        {dispute.payment && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <CreditCard className="h-5 w-5 text-blue-600" />
                Payment Information
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <p className="text-sm text-zinc-500">Payment ID</p>
                <p className="font-mono text-sm">
                  {dispute.payment.paymentIntent}
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-sm text-zinc-500">Amount</p>
                  <p className="font-medium">
                    {formatCurrencyAmount(
                      dispute.payment.amount,
                      dispute.payment.currency,
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-zinc-500">Payment Method</p>
                  <p className="font-medium">
                    {dispute.payment.paymentMethod || "N/A"}
                  </p>
                </div>
              </div>

              <Separator />

              <div className="flex items-center gap-3">
                <User className="h-5 w-5 text-zinc-400" />
                <div>
                  <p className="font-medium">
                    {dispute.payment.user?.name || "Unknown User"}
                  </p>
                  <p className="text-sm text-zinc-500">
                    {dispute.payment.user?.email}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Calendar className="h-5 w-5 text-zinc-400" />
                <div>
                  <p className="text-sm text-zinc-500">Payment Date</p>
                  <p className="font-medium">
                    {formatDate(dispute.payment.createdAt)}
                  </p>
                </div>
              </div>

              <a
                href={`${basePath}/payments/${dispute.paymentId}`}
                className="block text-blue-600 hover:text-blue-700 font-medium"
              >
                View Full Payment Details →
              </a>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Existing Evidence */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <FileText className="h-5 w-5 text-purple-600" />
            Evidence
          </CardTitle>
        </CardHeader>
        <CardContent>
          {dispute.evidence ? (
            <div className="space-y-4">
              <Alert className="bg-green-50 dark:bg-green-950/20 border-green-200">
                <CheckCircle className="h-4 w-4 text-green-600" />
                <AlertTitle>Evidence Submitted</AlertTitle>
                <AlertDescription>
                  {/* This block is already gated on `dispute.evidence`, so the
                      submission is a fact; only its timestamp can be missing,
                      and only for disputes recorded before the column existed.
                      Saying "submitted on N/A" made a known fact look like
                      missing data. */}
                  {dispute.evidenceSubmittedAt
                    ? `Evidence was submitted on ${formatDate(dispute.evidenceSubmittedAt)}`
                    : "Evidence was submitted. The submission time was not recorded for this dispute."}
                </AlertDescription>
              </Alert>
              <div className="p-4 rounded-lg bg-zinc-50 dark:bg-zinc-900">
                <pre className="text-sm whitespace-pre-wrap overflow-auto">
                  {typeof dispute.evidence === "object"
                    ? JSON.stringify(dispute.evidence, null, 2)
                    : String(dispute.evidence)}
                </pre>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-zinc-500">
              <FileText className="h-12 w-12 mb-4 text-zinc-300" />
              <p className="font-medium">No evidence submitted yet</p>
              {needsResponse && !allowEvidenceSubmission && (
                <p className="text-sm text-zinc-400 mt-2">
                  Please escalate to an admin to submit evidence
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Evidence Submission Form (admin only) */}
      {showEvidenceForm && canSubmitEvidence && (
        <Card className="border-blue-200">
          <CardHeader>
            <CardTitle className="text-blue-600">Submit Evidence</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="customerName">Customer Name</Label>
                <Textarea
                  id="customerName"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  rows={2}
                />
              </div>
              <div>
                <Label htmlFor="customerEmail">Customer Email</Label>
                <Textarea
                  id="customerEmail"
                  value={customerEmail}
                  onChange={(e) => setCustomerEmail(e.target.value)}
                  rows={2}
                />
              </div>
            </div>

            <div>
              <Label htmlFor="productDescription">
                Product/Service Description
              </Label>
              <Textarea
                id="productDescription"
                value={productDescription}
                onChange={(e) => setProductDescription(e.target.value)}
                rows={3}
              />
            </div>

            <div>
              <Label htmlFor="customerSignature">
                Customer Signature/Acknowledgment
              </Label>
              <Textarea
                id="customerSignature"
                value={customerSignature}
                onChange={(e) => setCustomerSignature(e.target.value)}
                rows={3}
              />
            </div>

            <div>
              <Label htmlFor="refundPolicy">Refund Policy</Label>
              <Textarea
                id="refundPolicy"
                value={refundPolicy}
                onChange={(e) => setRefundPolicy(e.target.value)}
                rows={3}
              />
            </div>

            <div>
              <Label htmlFor="refundPolicyDisclosure">
                Refund Policy Disclosure
              </Label>
              <Textarea
                id="refundPolicyDisclosure"
                value={refundPolicyDisclosure}
                onChange={(e) => setRefundPolicyDisclosure(e.target.value)}
                rows={3}
              />
            </div>

            <div>
              <Label htmlFor="cancellationPolicy">Cancellation Policy</Label>
              <Textarea
                id="cancellationPolicy"
                value={cancellationPolicy}
                onChange={(e) => setCancellationPolicy(e.target.value)}
                rows={3}
              />
            </div>

            <div>
              <Label htmlFor="cancellationRebuttal">
                Cancellation Rebuttal
              </Label>
              <Textarea
                id="cancellationRebuttal"
                value={cancellationRebuttal}
                onChange={(e) => setCancellationRebuttal(e.target.value)}
                rows={3}
              />
            </div>

            <div>
              <Label htmlFor="additionalEvidence">
                Additional Evidence/Notes
              </Label>
              <Textarea
                id="additionalEvidence"
                value={additionalEvidence}
                onChange={(e) => setAdditionalEvidence(e.target.value)}
                rows={4}
              />
            </div>

            <div className="flex gap-2">
              <Button
                onClick={handleSubmitEvidence}
                disabled={evidenceMutation.isPending}
              >
                {evidenceMutation.isPending
                  ? "Submitting..."
                  : "Submit Evidence"}
              </Button>
              <Button
                onClick={() => setShowEvidenceForm(false)}
                variant="outline"
                disabled={evidenceMutation.isPending}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Gateway-specific Notes (admin only) */}
      {allowEvidenceSubmission && (
        <Card>
          <CardHeader>
            <CardTitle>Important Notes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-gray-600">
            <p>
              • Stripe disputes: You can submit evidence directly through this
              form.
            </p>
            <p>
              • Razorpay disputes: Evidence submission is handled automatically
              via webhooks. Contact Razorpay support for manual intervention.
            </p>
            <p>
              • Always respond before the due date to avoid automatic loss of
              the dispute.
            </p>
            <p>
              • Be thorough and provide all relevant documentation to support
              your case.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
