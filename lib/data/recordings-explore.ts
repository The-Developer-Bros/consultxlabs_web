/**
 * Public recordings-library queries (#366).
 *
 * One source of truth for the marketplace listing filter — the API route and
 * the ISR page both call these, so a relaxed filter can never ship on one
 * surface only. Select allowlists expose ONLY listing metadata: playback URLs
 * (recordingUrl, storagePath) must never reach an anonymous response.
 *
 * Consultant identity travels Recording → MeetingSession → SlotOfAppointment
 * → Appointment → (Webinar|Class)Plan → ConsultantProfile — there is no
 * direct FK, so both list and detail queries flatten that path server-side.
 */

import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { eventPlanDiscoverableWhere } from "@/lib/api/plans/visibility";
import { durablyOursWhere } from "@/lib/stream/recording-storage";

/** Listing metadata only — no storage paths, no playback URLs. */
const recordingListingSelect = {
  id: true,
  slug: true,
  listingTitle: true,
  listingDescription: true,
  listPricePaise: true,
  tags: true,
  thumbnailUrl: true,
  previewClipUrl: true,
  previewTranscript: true,
  previewClipDuration: true,
  durationInMinutes: true,
  recordedAt: true,
  publishedAt: true,
  meetingSession: {
    select: {
      slotOfAppointment: {
        select: {
          appointment: {
            select: {
              webinar: {
                select: {
                  webinarPlan: {
                    select: {
                      id: true,
                      title: true,
                      consultantProfile: {
                        select: {
                          id: true,
                          headline: true,
                          user: { select: { name: true, image: true } },
                        },
                      },
                    },
                  },
                },
              },
              class: {
                select: {
                  classPlan: {
                    select: {
                      id: true,
                      title: true,
                      consultantProfile: {
                        select: {
                          id: true,
                          headline: true,
                          user: { select: { name: true, image: true } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.RecordingSelect;

// listPricePaise arrives as number through the #780 money extension map —
// accept either to stay honest about what the client returns.
type ListingRow = Omit<
  Prisma.RecordingGetPayload<{ select: typeof recordingListingSelect }>,
  "listPricePaise"
> & { listPricePaise: number | bigint | null };

export interface RecordingListing {
  id: string;
  slug: string | null;
  listingTitle: string;
  listingDescription: string | null;
  listPricePaise: number;
  tags: string[];
  thumbnailUrl: string | null;
  previewClipUrl: string | null;
  previewTranscript: string | null;
  previewClipDuration: number | null;
  durationInMinutes: number;
  recordedAt: Date;
  publishedAt: Date | null;
  planType: "WEBINAR" | "CLASS";
  planId: string;
  planTitle: string;
  consultant: {
    profileId: string;
    name: string | null;
    image: string | null;
    headline: string | null;
  };
}

function flattenListing(row: ListingRow): RecordingListing | null {
  const apt = row.meetingSession.slotOfAppointment.appointment;
  const webinarArm = apt.webinar?.webinarPlan;
  const classArm = apt.class?.classPlan;
  const plan = webinarArm ?? classArm;
  if (!row.listingTitle || row.listPricePaise === null) return null;
  const consultantProfile = plan?.consultantProfile;
  if (!consultantProfile) return null;

  return {
    id: row.id,
    slug: row.slug,
    listingTitle: row.listingTitle,
    listingDescription: row.listingDescription,
    // Serialized as number for JSON; paise fits safely in a double.
    listPricePaise: Number(row.listPricePaise),
    tags: row.tags,
    thumbnailUrl: row.thumbnailUrl,
    previewClipUrl: row.previewClipUrl,
    previewTranscript: row.previewTranscript,
    previewClipDuration: row.previewClipDuration,
    durationInMinutes: row.durationInMinutes,
    recordedAt: row.recordedAt,
    publishedAt: row.publishedAt,
    planType: webinarArm ? "WEBINAR" : "CLASS",
    planId: plan.id,
    planTitle: plan.title,
    consultant: {
      profileId: consultantProfile.id,
      name: consultantProfile.user.name,
      image: consultantProfile.user.image,
      headline: consultantProfile.headline,
    },
  };
}

/**
 * The single marketplace gate. A row is listed iff it is PUBLISHED, durably
 * ours (a sold replay must outlive Stream's ≤14-day retention — see
 * `durablyOursWhere`), and its parent webinar/class plan is publicly
 * discoverable and live.
 */
export function publicRecordingWhere(): Prisma.RecordingWhereInput {
  return {
    listingStatus: "PUBLISHED",
    ...durablyOursWhere(),
    meetingSession: {
      slotOfAppointment: {
        appointment: {
          OR: [
            { webinar: { webinarPlan: eventPlanDiscoverableWhere() } },
            { class: { classPlan: eventPlanDiscoverableWhere() } },
          ],
        },
      },
    },
  };
}

interface ListRecordingsParams {
  page?: number;
  perPage?: number;
  search?: string;
  tag?: string;
}

export async function listPublicRecordings(
  params: ListRecordingsParams = {},
): Promise<{
  items: RecordingListing[];
  total: number;
  page: number;
  perPage: number;
}> {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(48, Math.max(1, params.perPage ?? 12));

  const where: Prisma.RecordingWhereInput = {
    ...publicRecordingWhere(),
    ...(params.search && {
      OR: [
        {
          listingTitle: {
            contains: params.search,
            mode: "insensitive" as const,
          },
        },
        {
          listingDescription: {
            contains: params.search,
            mode: "insensitive" as const,
          },
        },
      ],
    }),
    ...(params.tag && { tags: { has: params.tag } }),
  };

  // Build-time transient shield: 262 pages generate concurrently against a
  // one-connection pool. Retry bounded times, REPORT every attempt to Sentry
  // (guard test #1125 requires bound catches), and rethrow if it never
  // settles — the listing stays LOUD per isr-routes-never-fail-open.
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const total = await prisma.recording.count({ where });
      const rows = await prisma.recording.findMany({
        where,
        select: recordingListingSelect,
        // `id` as final key: offset pagination over non-unique timestamps can
      // repeat/skip rows between requests otherwise.
      orderBy: [{ publishedAt: "desc" }, { recordedAt: "desc" }, { id: "asc" }],
        take: perPage,
        skip: (page - 1) * perPage,
      });
      return {
        items: rows
          .map(flattenListing)
          .filter((x): x is RecordingListing => x !== null),
        total,
        page,
        perPage,
      };
    } catch (error) {
      lastError = error;
      Sentry.captureException(error, {
        tags: { subsystem: "explore-recordings", attempt: String(attempt) },
      });
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function getPublicRecordingBySlug(
  slug: string,
): Promise<RecordingListing | null> {
  const row = await prisma.recording.findFirst({
    where: { ...publicRecordingWhere(), slug },
    select: recordingListingSelect,
  });
  return row ? flattenListing(row) : null;
}
