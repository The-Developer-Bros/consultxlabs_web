/**
 * Shared list-recordings query for the #674 / B1-hybrid scope split.
 * `Recording.organizationId` is denormalized from the parent appointment
 * (kept in sync by checkout + the backfill script). Listing by org is
 * a single-hop lookup instead of joining through MeetingSession →
 * SlotOfAppointment → Appointment.
 */

import prisma from "@/lib/prisma";
import type { Prisma, RecordingStatus } from "@prisma/client";
import type { Scope } from "./parse";
import { assertNeverScope } from "./parse";

export interface ListRecordingsParams {
  scope: Scope;
  userId: string;
  status?: RecordingStatus;
  page?: number;
  perPage?: number;
}

/**
 * #946 select-allowlist, applied to the scope split.
 *
 * The `org` arm below carries NO participant filter — it returns every
 * recording made under the organization, for every member. So what it selects
 * is what an operator can read about a session they were not in. `include`
 * shipped the whole row, which meant `recordingUrl` (plus the Supabase mirror,
 * the thumbnail, the preview clip and the Stream ids that resolve to the same
 * media) reached anyone holding `operations.read` — OWNER, MAINTAINER, MANAGER
 * and SUPPORT. The org table renders none of it; the JSON carried it anyway.
 *
 * ADR 20 draws the line: the organization may see THAT a session happened, not
 * what happened in it. These two objects are that line in code — the metadata
 * select is the org's view, and only the two people on the appointment get the
 * media itself.
 */
const recordingMetadataSelect = {
  id: true,
  title: true,
  status: true,
  durationInMinutes: true,
  recordedAt: true,
  createdAt: true,
  organizationId: true,
  meetingSession: {
    select: {
      id: true,
      slotOfAppointment: {
        select: {
          appointment: {
            select: { id: true, appointmentType: true, organizationId: true },
          },
        },
      },
    },
  },
  organization: { select: { id: true, name: true, slug: true } },
} satisfies Prisma.RecordingSelect;

/** Participant arms only. Everything here reaches, or resolves to, the media. */
const recordingParticipantSelect = {
  ...recordingMetadataSelect,
  recordingUrl: true,
  storageUrl: true,
  storagePath: true,
  thumbnailUrl: true,
  previewClipUrl: true,
  previewClipDuration: true,
  streamRecordingId: true,
  streamCallId: true,
  streamUrlExpiresAt: true,
  storageType: true,
  fileSize: true,
  codec: true,
  resolution: true,
  transferredAt: true,
} satisfies Prisma.RecordingSelect;

type RecordingMetadata = Prisma.RecordingGetPayload<{
  select: typeof recordingMetadataSelect;
}>;
type RecordingWithMedia = Prisma.RecordingGetPayload<{
  select: typeof recordingParticipantSelect;
}>;

/**
 * Media fields are optional on purpose: a caller that wants `recordingUrl` has
 * to handle its absence, which is how the type system carries the scope rule
 * to consumers instead of leaving it to whoever reads this file next.
 */
export type ScopedRecording = RecordingMetadata &
  Partial<Omit<RecordingWithMedia, keyof RecordingMetadata>>;

export interface ListRecordingsResult {
  items: ScopedRecording[];
  total: number;
  page: number;
  perPage: number;
}

function buildWhere(
  params: ListRecordingsParams,
): Prisma.RecordingWhereInput {
  const base: Prisma.RecordingWhereInput = {
    ...(params.status && { status: params.status }),
  };
  if (params.scope.kind === "personal") {
    return {
      ...base,
      organizationId: null,
      meetingSession: {
        slotOfAppointment: {
          appointment: {
            OR: [
              { consultation: { requestedBy: { userId: params.userId } } },
              { subscription: { requestedBy: { userId: params.userId } } },
              { trialSession: { consulteeProfile: { userId: params.userId } } },
            ],
          },
        },
      },
    };
  }
  if (params.scope.kind === "org") {
    return { ...base, organizationId: params.scope.orgId };
  }
  // `orgMember` = ONE member's own rows within an org. It must never fall
  // through to the unfiltered `base` below: that arm is the `all` scope
  // (admin/staff), and reaching it with an orgMember scope would return the
  // whole platform. `resolveOrgScope` now downgrades a non-operator's
  // ?orgScope=<orgId> to this kind, so the fall-through is live, not latent.
  if (params.scope.kind === "orgMember") {
    return {
      ...base,
      organizationId: params.scope.orgId,
      meetingSession: {
        slotOfAppointment: {
          appointment: {
            OR: [
              { consultation: { requestedBy: { userId: params.scope.userId } } },
              { subscription: { requestedBy: { userId: params.scope.userId } } },
              {
                trialSession: {
                  consulteeProfile: { userId: params.scope.userId },
                },
              },
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
                  webinarPlan: {
                    consultantProfile: { userId: params.scope.userId },
                  },
                },
              },
              {
                class: {
                  classPlan: {
                    consultantProfile: { userId: params.scope.userId },
                  },
                },
              },
            ],
          },
        },
      },
    };
  }

  // Explicit rather than a fall-through: `base` alone is the admin/staff arm,
  // so an unhandled kind reaching it would return every tenant's rows.
  if (params.scope.kind === "all") return base;

  return assertNeverScope(params.scope);
}

export async function listRecordingsScoped(
  params: ListRecordingsParams,
): Promise<ListRecordingsResult> {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(100, Math.max(1, params.perPage ?? 20));
  const where = buildWhere(params);

  // `personal` and `orgMember` are the arms whose `where` pins the caller as a
  // participant on the appointment. Only those get the media. `org` sees the
  // whole organization's recordings and `all` is the admin/staff union — both
  // are reading other people's sessions, so both stop at metadata.
  const isParticipantScope =
    params.scope.kind === "personal" || params.scope.kind === "orgMember";

  const [total, items] = await prisma.$transaction([
    prisma.recording.count({ where }),
    prisma.recording.findMany({
      where,
      select: isParticipantScope
        ? recordingParticipantSelect
        : recordingMetadataSelect,
      orderBy: { recordedAt: "desc" },
      take: perPage,
      skip: (page - 1) * perPage,
    }),
  ]);

  return { items, total, page, perPage };
}
