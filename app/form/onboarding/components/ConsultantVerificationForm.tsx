"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ChevronLeft, ChevronRight, Loader2, Shield, Info } from "lucide-react";
import {
  VerificationDocumentUpload,
  type UploadedDocument,
} from "@/components/verification/VerificationDocumentUpload";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface ConsultantVerificationFormProps {
  onNext: (data: {
    verificationLinkedinUrl?: string;
    verificationNotes?: string;
    verificationDocuments?: UploadedDocument[];
  }) => void;
  onBack: () => void;
  initialData?: {
    verificationLinkedinUrl?: string;
    verificationNotes?: string;
    verificationDocuments?: UploadedDocument[];
  };
}

export default function ConsultantVerificationForm({
  onNext,
  onBack,
  initialData,
}: ConsultantVerificationFormProps) {
  const [linkedinUrl, setLinkedinUrl] = useState(
    initialData?.verificationLinkedinUrl || "",
  );
  const [notes, setNotes] = useState(initialData?.verificationNotes || "");
  const [documents, setDocuments] = useState<UploadedDocument[]>(
    initialData?.verificationDocuments || [],
  );
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validateLinkedIn = (url: string) => {
    if (!url) return true; // Allow empty
    const linkedinRegex = /^https?:\/\/(www\.)?linkedin\.com\/in\/[\w-]+\/?$/i;
    return linkedinRegex.test(url);
  };

  const handleUpload = useCallback(
    async (file: File): Promise<UploadedDocument> => {
      setIsUploading(true);
      setError(null);

      try {
        const formData = new FormData();
        formData.append("file", file);
        // Flag this as an onboarding upload - profile doesn't exist yet
        formData.append("onboarding", "true");

        const response = await fetch("/api/verification/documents", {
          method: "POST",
          body: formData,
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
    } catch {
      // Silently fail, document will still be removed from UI
    }
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validate LinkedIn URL if provided
    if (linkedinUrl && !validateLinkedIn(linkedinUrl)) {
      setError("Please enter a valid LinkedIn profile URL");
      return;
    }

    // LinkedIn URL is required
    if (!linkedinUrl) {
      setError("LinkedIn profile URL is required for verification");
      return;
    }

    // At least one document is required
    const completedDocuments = documents.filter((d) => d.status === "uploaded");
    if (completedDocuments.length === 0) {
      setError(
        "Please upload at least one supporting document (certification, degree, license, or ID)",
      );
      return;
    }

    onNext({
      verificationLinkedinUrl: linkedinUrl,
      verificationNotes: notes,
      verificationDocuments: documents,
    });
  };

  const hasInProgressUploads = documents.some((d) => d.status === "uploading");

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Header Info */}
      <Alert className="border-border bg-muted">
        <Shield className="h-4 w-4 text-muted-foreground" />
        <AlertTitle className="text-foreground">Profile Verification</AlertTitle>
        <AlertDescription className="text-muted-foreground">
          To maintain the quality of our platform, we verify all consultant
          profiles. Your LinkedIn profile and at least one supporting document
          (certification, degree, license, or ID) are required.
        </AlertDescription>
      </Alert>

      {/* LinkedIn URL */}
      <div className="space-y-2">
        <Label htmlFor="linkedinUrl" className="flex items-center gap-1">
          LinkedIn Profile URL <span className="text-red-500">*</span>
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
          Supporting Documents <span className="text-red-500">*</span>
        </Label>
        <div className="bg-muted p-1 rounded-lg border border-border mb-2">
          <div className="flex items-start gap-2 p-2 text-xs text-muted-foreground">
            <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <p>
              Upload at least one document that verifies your expertise:
              professional certifications, degrees, licenses, or government ID.
              This is required to complete verification.
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
      </div>

      {/* Additional Notes */}
      <div className="space-y-2">
        <Label htmlFor="notes" className="flex items-center gap-1">
          Additional Notes{" "}
          <span className="text-muted-foreground/70 text-xs font-normal">(Optional)</span>
        </Label>
        <Textarea
          id="notes"
          placeholder="Any additional information you'd like to share about your professional background..."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          maxLength={500}
        />
        <p className="text-xs text-muted-foreground text-right">
          {notes.length}/500 characters
        </p>
      </div>

      {/* Error Display */}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Verification Timeline Info */}
      <div className="bg-muted rounded-lg p-4 border border-border">
        <h4 className="font-medium text-sm text-foreground mb-2">
          What happens next?
        </h4>
        <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
          <li>Our team will review your LinkedIn profile and documents</li>
          <li>
            You&apos;ll receive an email notification once the review is
            complete
          </li>
          <li>
            Once verified, your profile will be visible in the consultant
            directory
          </li>
        </ol>
        <p className="text-xs text-muted-foreground mt-2">
          Verification typically takes 1-2 business days.
        </p>
      </div>

      {/* Navigation Buttons */}
      <div className="flex justify-between pt-4 border-t border-border">
        <Button type="button" variant="outline" onClick={onBack}>
          <ChevronLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <Button type="submit" disabled={isUploading || hasInProgressUploads}>
          {isUploading || hasInProgressUploads ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Uploading...
            </>
          ) : (
            <>
              Continue
              <ChevronRight className="ml-2 h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </form>
  );
}
