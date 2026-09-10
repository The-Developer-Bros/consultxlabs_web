"use client";

import * as Sentry from "@sentry/nextjs";
import React, { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ChevronLeft, Loader2, Shield, Info } from "lucide-react";
import {
  VerificationDocumentUpload,
  type UploadedDocument,
} from "@/components/verification/VerificationDocumentUpload";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import TermsAndPrivacyAgreement from "./TermsAndPrivacyAgreement";
import type { OnboardingFormData } from "@/utils/onboarding";
import { IndiaOnlyPayoutNotice } from "@/components/payouts/IndiaOnlyPayoutNotice";

interface ConsultantAgreementAndVerificationStepProps {
  onNext: (data: Partial<OnboardingFormData>) => void;
  onBack: () => void;
  formData: Partial<OnboardingFormData>;
}

export default function ConsultantAgreementAndVerificationStep({
  onNext,
  onBack,
  formData,
}: ConsultantAgreementAndVerificationStepProps) {
  // Agreement state
  const [termsChecked, setTermsChecked] = useState(
    formData.termsAccepted || false,
  );
  const [privacyChecked, setPrivacyChecked] = useState(
    formData.privacyAccepted || false,
  );

  // Verification state
  const [linkedinUrl, setLinkedinUrl] = useState(
    formData.verificationLinkedinUrl || "",
  );
  const [notes, setNotes] = useState(formData.verificationNotes || "");
  const [documents, setDocuments] = useState<UploadedDocument[]>(
    // Schema uses z.array(z.any()) for verification documents; cast to concrete type
    (formData.verificationDocuments as UploadedDocument[]) || [],
  );
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validateLinkedIn = (url: string) => {
    if (!url) return true;
    const linkedinRegex = /^https?:\/\/(www\.)?linkedin\.com\/in\/[\w-]+\/?$/i;
    return linkedinRegex.test(url);
  };

  const handleUpload = useCallback(
    async (file: File): Promise<UploadedDocument> => {
      setIsUploading(true);
      setError(null);

      try {
        const uploadFormData = new FormData();
        uploadFormData.append("file", file);
        uploadFormData.append("onboarding", "true");

        const response = await fetch("/api/verification/documents", {
          method: "POST",
          body: uploadFormData,
        });

        const result = await response.json();

        if (!result.success) {
          throw new Error(result.error || "Upload failed");
        }

        // API response boundary — would need a response schema to avoid this
        return result.data as UploadedDocument;
      } finally {
        setIsUploading(false);
      }
    },
    [],
  );

  const handleRemove = useCallback(async (documentId: string) => {
    try {
      await fetch(`/api/verification/documents?id=${documentId}`, {
        method: "DELETE",
      });
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "client" } });
      console.error("Failed to delete verification document:", error);
    }
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validate agreement
    if (!termsChecked || !privacyChecked) {
      setError("You must accept both terms and privacy policy to continue.");
      return;
    }

    // Validate LinkedIn URL if provided
    if (linkedinUrl && !validateLinkedIn(linkedinUrl)) {
      setError("Please enter a valid LinkedIn profile URL");
      return;
    }

    // LinkedIn and documents are OPTIONAL at submission (#onboarding-ux):
    // verification itself is asynchronous anyway, so blocking onboarding on it
    // only adds drop-off. A deferred consultant lands on the dashboard with
    // PENDING_VERIFICATION and finishes from Settings → Verification; the
    // server enforces the same policy via shouldSubmitVerification().
    // Format validation above still guards whatever was entered.

    // Merge all data and submit
    const finalData = {
      ...formData,
      termsAccepted: true,
      privacyAccepted: true,
      verificationLinkedinUrl: linkedinUrl,
      verificationNotes: notes,
      verificationDocuments: documents.filter((d) => d.status === "uploaded"),
    };

    onNext(finalData);
  };

  const hasInProgressUploads = documents.some((d) => d.status === "uploading");

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      {/* Payout eligibility comes before verification deliberately: a
          consultant who cannot receive INR into an Indian account should learn
          that here, not after building a profile and earning money. */}
      <IndiaOnlyPayoutNotice />

      {/* Verification Section */}
      <div className="space-y-6">
        <Alert className="border-border bg-muted">
          <Shield className="h-4 w-4 text-muted-foreground" />
          <AlertTitle className="text-foreground">
            Profile Verification
          </AlertTitle>
          <AlertDescription className="text-muted-foreground">
            We verify all consultant profiles before they appear in the
            directory. You can add your LinkedIn URL and documents now, or
            finish this later from your dashboard — your profile is saved either
            way.
          </AlertDescription>
        </Alert>

        {/* LinkedIn URL */}
        <div className="space-y-2">
          <Label htmlFor="linkedinUrl" className="flex items-center gap-1">
            LinkedIn Profile URL{" "}
            <span className="text-muted-foreground/70 text-xs font-normal">
              (needed to get listed)
            </span>
          </Label>
          <Input
            id="linkedinUrl"
            type="url"
            placeholder="https://linkedin.com/in/yourprofile"
            value={linkedinUrl}
            onChange={(e) => setLinkedinUrl(e.target.value)}
            className={
              linkedinUrl && !validateLinkedIn(linkedinUrl)
                ? "border-red-500"
                : ""
            }
          />
          <p className="text-xs text-muted-foreground">
            We use your LinkedIn profile to verify your professional background.
          </p>
          {linkedinUrl && !validateLinkedIn(linkedinUrl) && (
            <p className="text-xs text-red-500">
              Please enter a valid LinkedIn URL (e.g.,
              https://linkedin.com/in/username)
            </p>
          )}
        </div>

        {/* Document Upload */}
        <div className="space-y-2">
          <Label className="flex items-center gap-1">
            Supporting Documents{" "}
            <span className="text-muted-foreground/70 text-xs font-normal">
              (needed to get listed)
            </span>
          </Label>
          <div className="bg-muted p-1 rounded-lg border border-border mb-2">
            <div className="flex items-start gap-2 p-2 text-xs text-muted-foreground">
              <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <p>
                Upload at least one document that verifies your expertise:
                professional certifications, degrees, licenses, or government
                ID. You can also add these after signing up.
              </p>
            </div>
          </div>
          <VerificationDocumentUpload
            documents={documents}
            onDocumentsChange={setDocuments}
            onUpload={handleUpload}
            onRemove={handleRemove}
            maxFiles={5}
            disabled={isUploading}
          />
          <p className="text-xs text-muted-foreground">
            Accepted formats: PDF, PNG, JPG, JPEG (max 10MB per file)
          </p>
        </div>

        {/* Additional Notes */}
        <div className="space-y-2">
          <Label htmlFor="notes" className="flex items-center gap-1">
            Additional Notes{" "}
            <span className="text-muted-foreground/70 text-xs font-normal">
              (Optional)
            </span>
          </Label>
          <Textarea
            id="notes"
            placeholder="Any additional information about your professional background..."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            maxLength={500}
          />
          <p className="text-xs text-muted-foreground text-right">
            {notes.length}/500 characters
          </p>
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-border" />

      {/* Agreement Section */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Terms and Conditions
        </h3>
        <p className="text-sm text-muted-foreground">
          Please review and accept our terms to complete your profile setup
        </p>
        <TermsAndPrivacyAgreement
          onTermsChange={setTermsChecked}
          onPrivacyChange={setPrivacyChecked}
          termsChecked={termsChecked}
          privacyChecked={privacyChecked}
        />
        {(!termsChecked || !privacyChecked) && (
          <p className="text-sm text-muted-foreground">
            You must accept both agreements to continue.
          </p>
        )}
      </div>

      {/* Verification Timeline Info */}
      <div className="bg-muted rounded-lg p-4 border border-border">
        <h4 className="font-medium text-sm text-foreground mb-2">
          What happens next?
        </h4>
        <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
          <li>Our team will review your LinkedIn profile and documents</li>
          <li>
            You&apos;ll receive an email notification once the review is complete
          </li>
          <li>
            Once verified, your profile will be visible in the consultant
            directory
          </li>
        </ol>
        <p className="text-xs text-muted-foreground mt-2">
          Verification typically takes 1-2 business days. Skipping it now keeps
          your profile unlisted until you finish from Settings → Verification.
        </p>
      </div>

      {/* Error Display */}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Navigation Buttons */}
      <div className="flex justify-between pt-4 border-t border-border">
        <Button type="button" variant="outline" onClick={onBack}>
          <ChevronLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <Button
          type="submit"
          disabled={
            isUploading ||
            hasInProgressUploads ||
            !termsChecked ||
            !privacyChecked
          }
        >
          {isUploading || hasInProgressUploads ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Uploading...
            </>
          ) : (
            "Continue to Review"
          )}
        </Button>
      </div>
    </form>
  );
}
