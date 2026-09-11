/**
 * Shared operator profile-verification queue.
 *
 * Used by both `app/api/admin/verification/route.ts` and
 * `app/api/staff/moderation/profiles/route.ts` — same resource (consultant
 * profile verifications) exposed under two URLs for the admin and staff
 * dashboards. The previously-duplicated query+formatting now lives here.
 *
 * The result shape matches the `ProfileVerification` type the frontend's
 * shared `VerificationQueue` component already consumes (it accepts an
 * `apiBasePath` prop and is mounted on both dashboards).
 */

import prisma from "@/lib/prisma";
import { ProfileVerificationStatus, Prisma } from "@prisma/client";
import type { ProfileVerification } from "@/types/moderation";

export type OperatorVerificationFilters = {
  status?: ProfileVerificationStatus | null;
  page?: number;
  limit?: number;
};

type OperatorVerificationCounts = {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  needsInfo: number;
};

export type OperatorVerificationResult = {
  verifications: ProfileVerification[];
  counts: OperatorVerificationCounts;
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasMore: boolean;
  };
};

/**
 * Fetch the profile verification queue for admin/staff dashboards.
 *
 * Single source of truth — call from any privileged-role route after running
 * `requirePrivilegedAuth()`.
 */
export async function getVerificationQueue(
  filters: OperatorVerificationFilters = {},
): Promise<OperatorVerificationResult> {
  const status = filters.status ?? null;
  const page = filters.page && filters.page > 0 ? filters.page : 1;
  const limit = filters.limit && filters.limit > 0 ? filters.limit : 20;
  const offset = (page - 1) * limit;

  const where: Prisma.ConsultantProfileVerificationWhereInput = {};
  if (status) where.status = status;

  const [verifications, total, statusCounts] = await Promise.all([
    prisma.consultantProfileVerification.findMany({
      where,
      include: {
        consultantProfile: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
                linkedinUrl: true,
                bio: true,
                // Extended consultant professional background — rendered by
                // the admin/staff VerificationReviewModal. Keep aligned with
                // the `ProfileVerification` type in `types/moderation.ts`.
                workExperiences: {
                  select: {
                    id: true,
                    company: true,
                    title: true,
                    startDate: true,
                    endDate: true,
                    isCurrent: true,
                  },
                  orderBy: { startDate: "desc" },
                },
                certifications: {
                  select: {
                    id: true,
                    name: true,
                    issuingOrganization: true,
                    issueDate: true,
                  },
                  orderBy: { issueDate: "desc" },
                },
                education: {
                  select: {
                    id: true,
                    institution: true,
                    degree: true,
                    fieldOfStudy: true,
                    startYear: true,
                    endYear: true,
                  },
                  orderBy: { startYear: "desc" },
                },
              },
            },
            domain: { select: { id: true, name: true } },
            subDomains: { select: { id: true, name: true } },
          },
        },
        documents: true,
      },
      orderBy: [
        { status: "asc" }, // Pending first
        { submittedAt: "asc" }, // Oldest first
      ],
      take: limit,
      skip: offset,
    }),
    prisma.consultantProfileVerification.count({ where }),
    prisma.consultantProfileVerification.groupBy({
      by: ["status"],
      _count: { id: true },
    }),
  ]);

  // Filter out verifications with missing profile data (defensive)
  const validVerifications = verifications.filter(
    (v) => v.consultantProfile && v.consultantProfile.user,
  );

  const formattedVerifications: ProfileVerification[] = validVerifications.map(
    (v) => ({
      id: v.id,
      status: v.status,
      submittedAt: v.submittedAt.toISOString(),
      notes: v.notes,
      rejectionReason: v.rejectionReason,
      feedbackDetails: v.feedbackDetails,
      // Flatten consultantProfile + user into the "consultant" shape the
      // frontend expects.
      consultant: {
        profileId: v.consultantProfile.id,
        userId: v.consultantProfile.user.id,
        name: v.consultantProfile.user.name,
        email: v.consultantProfile.user.email,
        image: v.consultantProfile.user.image,
        linkedinUrl: v.consultantProfile.user.linkedinUrl,
        bio: v.consultantProfile.user.bio ?? null,
        domain: v.consultantProfile.domain?.name ?? "",
        subDomains: v.consultantProfile.subDomains.map((s) => ({
          id: s.id,
          name: s.name,
        })),
        experience: v.consultantProfile.experience,
        headline: v.consultantProfile.headline,
        description: v.consultantProfile.description ?? null,
        isVerified: v.status === "APPROVED",
        verificationStatus: v.status,
        // Map Prisma field names onto the shape the
        // `VerificationReviewModal` already consumes.
        workExperiences: v.consultantProfile.user.workExperiences.map(
          (w) => ({
            id: w.id,
            company: w.company,
            title: w.title,
            startDate: w.startDate.toISOString(),
            endDate: w.endDate ? w.endDate.toISOString() : null,
            current: w.isCurrent,
          }),
        ),
        education: v.consultantProfile.user.education.map((e) => ({
          id: e.id,
          institution: e.institution,
          degree: e.degree,
          field: e.fieldOfStudy ?? "",
          startYear: e.startYear ?? 0,
          endYear: e.endYear ?? null,
        })),
        certifications: v.consultantProfile.user.certifications.map((c) => ({
          id: c.id,
          name: c.name,
          issuer: c.issuingOrganization,
          issueDate: c.issueDate.toISOString(),
        })),
      },
      documents: v.documents.map((d) => ({
        id: d.id,
        fileName: d.fileName,
        originalName: d.originalName,
        fileSize: d.fileSize,
        mimeType: d.mimeType,
        fileUrl: d.fileUrl,
        description: d.description,
      })),
      reviewedAt: v.reviewedAt?.toISOString() ?? null,
      reviewedById: v.reviewedById,
      reviewNotes: v.reviewNotes,
    }),
  );

  const counts: OperatorVerificationCounts = {
    total,
    pending: statusCounts.find((s) => s.status === "PENDING")?._count.id || 0,
    approved: statusCounts.find((s) => s.status === "APPROVED")?._count.id || 0,
    rejected: statusCounts.find((s) => s.status === "REJECTED")?._count.id || 0,
    needsInfo:
      statusCounts.find((s) => s.status === "NEEDS_INFO")?._count.id || 0,
  };

  return {
    verifications: formattedVerifications,
    counts,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasMore: offset + limit < total,
    },
  };
}
