/**
 * Shared list-documents query for the #674 / B1-hybrid scope split.
 * `AppointmentDocument` doesn't carry its own `organizationId`; it
 * inherits via the parent `Appointment.organizationId`.
 */

import prisma from "@/lib/prisma";
import type { DocumentReviewStatus, Prisma } from "@prisma/client";
import type { Scope } from "./parse";
import { assertNeverScope } from "./parse";

export interface ListDocumentsParams {
  scope: Scope;
  userId: string;
  reviewStatus?: DocumentReviewStatus;
  page?: number;
  perPage?: number;
}

/**
 * #946 select-allowlist, applied to the scope split. Same rule as
 * `list-recordings.ts`, and here the stakes are plainer: the `org` arm has no
 * participant filter, so `include` handed every member's uploaded file to
 * anyone with `operations.read`. `fileUrl` and `storagePath` ARE the document,
 * and `description` is the uploader describing it in their own words — the
 * schema's example list for that column reads "resume, ITR, legal document",
 * and an ITR is an income-tax return.
 *
 * Note the `all` (admin/staff) arm also stops at metadata. Its only consumer is
 * the back-office documents page, which states on itself that reviewing is the
 * consultant's call and it exists so support can explain an outcome; it renders
 * no file link. Giving the back office the file is a decision someone should
 * make deliberately, not inherit from an `include`.
 */
const documentMetadataSelect = {
  id: true,
  fileName: true,
  reviewStatus: true,
  reviewNotes: true,
  reviewedAt: true,
  reviewedById: true,
  uploadedByRole: true,
  responseToDocumentId: true,
  rootDocumentId: true,
  versionNo: true,
  isStorageMissing: true,
  uploadedAt: true,
  updatedAt: true,
  appointmentId: true,
  appointment: {
    select: {
      id: true,
      appointmentType: true,
      organizationId: true,
      organization: { select: { id: true, name: true, slug: true } },
    },
  },
} satisfies Prisma.AppointmentDocumentSelect;

/** Participant arms only — the file itself and what it says about itself. */
const documentParticipantSelect = {
  ...documentMetadataSelect,
  fileUrl: true,
  storagePath: true,
  description: true,
  originalName: true,
  mimeType: true,
  fileSize: true,
} satisfies Prisma.AppointmentDocumentSelect;

type DocumentMetadata = Prisma.AppointmentDocumentGetPayload<{
  select: typeof documentMetadataSelect;
}>;
type DocumentWithFile = Prisma.AppointmentDocumentGetPayload<{
  select: typeof documentParticipantSelect;
}>;

/** File fields optional for the same reason as `ScopedRecording`. */
export type ScopedDocument = DocumentMetadata &
  Partial<Omit<DocumentWithFile, keyof DocumentMetadata>>;

export interface ListDocumentsResult {
  items: ScopedDocument[];
  total: number;
  page: number;
  perPage: number;
}

function buildWhere(
  params: ListDocumentsParams,
): Prisma.AppointmentDocumentWhereInput {
  const base: Prisma.AppointmentDocumentWhereInput = {
    // Soft-deleted rows are pending nightly purge; no list surface shows them.
    deletedAt: null,
    ...(params.reviewStatus && { reviewStatus: params.reviewStatus }),
  };
  if (params.scope.kind === "personal") {
    // Personal docs: docs whose parent Appointment is NOT org-tagged
    // AND the user is a participant on it. The OR clause mirrors
    // listAppointmentsScoped for participation.
    return {
      ...base,
      appointment: {
        organizationId: null,
        OR: [
          { consultation: { requestedBy: { userId: params.userId } } },
          { subscription: { requestedBy: { userId: params.userId } } },
          { trialSession: { consulteeProfile: { userId: params.userId } } },
        ],
      },
    };
  }
  if (params.scope.kind === "org") {
    return {
      ...base,
      appointment: { organizationId: params.scope.orgId },
    };
  }
  // `orgMember` = ONE member's own rows within an org. It must never fall
  // through to the unfiltered `base` below: that arm is the `all` scope
  // (admin/staff), and reaching it with an orgMember scope would return the
  // whole platform. `resolveOrgScope` now downgrades a non-operator's
  // ?orgScope=<orgId> to this kind, so the fall-through is live, not latent.
  if (params.scope.kind === "orgMember") {
    return {
      ...base,
      appointment: {
        organizationId: params.scope.orgId,
        OR: [
          { consultation: { requestedBy: { userId: params.scope.userId } } },
          { subscription: { requestedBy: { userId: params.scope.userId } } },
          { trialSession: { consulteeProfile: { userId: params.scope.userId } } },
          {
            consultation: {
              consultationPlan: {
                consultantProfile: { userId: params.scope.userId },
              },
            },
          },
          {
            subscription: {
              subscriptionPlan: {
                consultantProfile: { userId: params.scope.userId },
              },
            },
          },
          {
            webinar: {
              webinarPlan: { consultantProfile: { userId: params.scope.userId } },
            },
          },
          {
            class: {
              classPlan: { consultantProfile: { userId: params.scope.userId } },
            },
          },
        ],
      },
    };
  }

  // Explicit rather than a fall-through: `base` alone is the admin/staff arm,
  // so an unhandled kind reaching it would return every tenant's rows.
  if (params.scope.kind === "all") return base;

  return assertNeverScope(params.scope);
}

export async function listDocumentsScoped(
  params: ListDocumentsParams,
): Promise<ListDocumentsResult> {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(100, Math.max(1, params.perPage ?? 20));
  const where = buildWhere(params);

  // See `list-recordings.ts` — only the arms that pin the caller as a
  // participant on the parent appointment return the file.
  const isParticipantScope =
    params.scope.kind === "personal" || params.scope.kind === "orgMember";

  const [total, items] = await prisma.$transaction([
    prisma.appointmentDocument.count({ where }),
    prisma.appointmentDocument.findMany({
      where,
      select: isParticipantScope
        ? documentParticipantSelect
        : documentMetadataSelect,
      orderBy: { uploadedAt: "desc" },
      take: perPage,
      skip: (page - 1) * perPage,
    }),
  ]);

  return { items, total, page, perPage };
}
