"use client";

import { useQuery } from "@tanstack/react-query";
import type {
  ConsultantVerificationStatus,
  ProfileVerificationStatus,
} from "@prisma/client";

export interface VerificationDocumentFeedback {
  documentId: string;
  fileName: string;
  originalName?: string;
  isValid: boolean | null;
  staffFeedback?: string | null;
}

export interface VerificationStatusData {
  profileId: string;
  isVerified: boolean;
  verificationStatus: ConsultantVerificationStatus;
  linkedinUrl: string | null;
  latestRequest: {
    id: string;
    status: ProfileVerificationStatus;
    submittedAt: string | null;
    reviewedAt: string | null;
    reviewNotes: string | null;
    rejectionReason: string | null;
    feedbackDetails: string | null;
    notes: string | null;
    /** Mapped to the VerificationPendingOverlay's documentFeedback shape. */
    documentFeedback: VerificationDocumentFeedback[];
  } | null;
}

async function fetchVerificationStatus(): Promise<VerificationStatusData | null> {
  const res = await fetch("/api/verification/status");
  if (!res.ok) throw new Error("Failed to fetch verification status");
  const json = await res.json();
  if (!json.success) {
    throw new Error(json.error ?? "Failed to fetch verification status");
  }
  const data = json.data;
  // A consultant who has never submitted (or a payload without data) must
  // resolve to null, not crash on data.latestRequest.
  if (!data) return null;
  return {
    ...data,
    latestRequest: data.latestRequest
      ? {
          ...data.latestRequest,
          documentFeedback: (data.latestRequest.documents ?? []).map(
            (d: {
              id: string;
              fileName: string;
              originalName?: string;
              isValid: boolean | null;
              staffFeedback?: string | null;
            }) => ({
              documentId: d.id,
              fileName: d.fileName,
              originalName: d.originalName,
              isValid: d.isValid,
              staffFeedback: d.staffFeedback,
            }),
          ),
        }
      : null,
  };
}

/**
 * Latest verification submission for the signed-in consultant, including
 * the reviewer feedback (`rejectionReason` / `feedbackDetails` / per-document
 * `staffFeedback`) from `GET /api/verification/status`.
 *
 * The layout threads this into the REJECTED gate so consultants finally see
 * WHY they were rejected (the overlay always supported the props; nothing
 * fetched them). The Settings verification section consumes the same query,
 * so the two surfaces can never disagree again.
 */
export function useVerificationStatus(
  userId: string | null | undefined,
  enabled = true,
) {
  return useQuery({
    // userId in the key: the endpoint reads the SIGNED-IN user, so a static
    // key would serve one user's cached verification to the next account
    // signing in on the same device.
    queryKey: ["verification-status", userId],
    queryFn: fetchVerificationStatus,
    enabled: enabled && !!userId,
    staleTime: 60_000,
    retry: 2,
  });
}
