import prisma from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import {
  mergeAdjacentCustomRows,
  mergeAdjacentWeeklyRows,
} from "@/utils/slotAllocation/mergeAdjacentWeeklyRows";
import {
  consultantPublicScalars,
  consultantPublicApiSchema,
} from "@/lib/data/consultant-public";
import {
  DayOfWeek,
  type OrgPlanVisibility,
  Prisma,
  ScheduleType,
  SessionType,
} from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { experienceValidation } from "@/schemas/shared";
import { checkActiveAppointments } from "../utils/consultant-appointments";
import { getSession } from "@/lib/auth-server";
import { purgeExpertSurfaces } from "@/lib/data/public-cache";
import { apiError } from "@/lib/errors";
import * as Sentry from "@sentry/nextjs";
import {
  dateToMinuteUtc,
  validateWeeklySlotTimeOrder,
  slotsOverlap,
} from "@/utils/slotAllocation/slotTimeUtils";
import {
  resolveWeeklyTimezone,
  resolveWeeklyUtcOffsetMinutes,
  WeeklyOffsetConflictError,
  weeklyRowLocalColumns,
} from "@/lib/scheduling/weeklyUtcOffset";
// Zod schema for UUID validation
const uuidSchema = z.string().uuid();

// Zod schema for date-time string validation
const dateTimeSchema = z.string().datetime({ offset: true });

// Zod schema for weekly slot
const weeklySlotSchema = z.object({
  dayOfWeekforStartTimeInUTC: z.enum([
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY",
  ]),
  dayOfWeekforEndTimeInUTC: z.enum([
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY",
  ]),
  startsAt: dateTimeSchema,
  endsAt: dateTimeSchema,
});

// Zod schema for custom slot
const customSlotSchema = z.object({
  startsAt: dateTimeSchema,
  endsAt: dateTimeSchema,
});

// Main request body schema
const updateConsultantSchema = z
  .object({
    description: z.string().optional(),
    experience: experienceValidation,
    scheduleType: z.enum(["WEEKLY", "CUSTOM"]),
    domainId: uuidSchema,
    subDomainIds: z.array(uuidSchema),
    tagIds: z.array(uuidSchema),
    slotsOfAvailabilityWeekly: z.array(weeklySlotSchema).optional(),
    slotsOfAvailabilityCustom: z.array(customSlotSchema).optional(),
    // #1326 — accepted only so a caller who sends an offset is checked against
    // the profile timezone instead of silently ignored; it never wins.
    utcOffsetMinutes: z.number().int().min(-840).max(840).optional(),
    // New fields - accept null values from frontend for optional fields
    headline: z.string().max(120).nullable().optional(),
    websiteUrl: z.string().url().nullable().optional().or(z.literal("")),
    twitterUrl: z.string().url().nullable().optional().or(z.literal("")),
    githubUrl: z.string().url().nullable().optional().or(z.literal("")),
    videoIntroUrl: z.string().url().nullable().optional().or(z.literal("")),
    languages: z.array(z.string()).nullable().optional(),
    toolsAndTechnologies: z.array(z.string()).nullable().optional(),
    mentoringStyle: z.string().nullable().optional(),
    sessionTypes: z.array(z.nativeEnum(SessionType)).nullable().optional(),
    // User-level field (stored on User model, not ConsultantProfile)
    linkedinUrl: z.string().url().nullable().optional().or(z.literal("")),
  })
  .refine(
    (data) => {
      if (data.scheduleType === "WEEKLY") {
        return (
          data.slotsOfAvailabilityWeekly &&
          data.slotsOfAvailabilityWeekly.length > 0
        );
      }
      if (data.scheduleType === "CUSTOM") {
        return (
          data.slotsOfAvailabilityCustom &&
          data.slotsOfAvailabilityCustom.length > 0
        );
      }
      return false;
    },
    {
      message: "Must provide corresponding slots array based on scheduleType",
      path: ["scheduleType"],
    },
  );

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { error: "Consultant ID is required" },
        { status: 400 },
      );
    }

    // Check if user is authenticated (for own profile access)
    const session = await getSession();

    // First, get basic consultant info to check access
    const basicConsultant = await prisma.consultantProfile.findUnique({
      where: { id },
      select: {
        userId: true,
        verificationStatus: true,
      },
    });

    if (!basicConsultant) {
      return NextResponse.json(
        { error: "Consultant not found" },
        { status: 404 },
      );
    }

    // Determine access level
    const isOwnProfile = session?.user?.id === basicConsultant.userId;
    const isAdmin = session?.user?.role === "ADMIN";
    const isVerified = basicConsultant.verificationStatus === "VERIFIED";

    // Block public access to unverified profiles
    if (!isVerified && !isOwnProfile && !isAdmin) {
      return NextResponse.json(
        { error: "Consultant not found" },
        { status: 404 },
      );
    }

    // Determine which user fields to include based on access level
    const isPrivilegedAccess = isOwnProfile || isAdmin;

    // #726 — public viewers must not see ORG_ONLY plans surfaced via the
    // consultant detail page. Privileged viewers (the consultant
    // themselves + ADMIN) see everything; the public include narrows
    // to PUBLIC + ORG_AND_PUBLIC.
    const planVisibilityFilter:
      | { visibility: { in: OrgPlanVisibility[] } }
      | undefined = isPrivilegedAccess
      ? undefined
      : { visibility: { in: ["PUBLIC", "ORG_AND_PUBLIC"] } };

    // Fetch consultant with appropriate user data
    const consultant = await prisma.consultantProfile.findUnique({
      where: { id },
      select: {
        ...consultantPublicScalars,
        user: isPrivilegedAccess
          ? {
              // Full user data for own profile or admin
              include: {
                workExperiences: {
                  orderBy: [{ isCurrent: "desc" }, { startDate: "desc" }],
                },
                education: {
                  orderBy: { endYear: "desc" },
                },
                certifications: {
                  orderBy: { issueDate: "desc" },
                },
              },
            }
          : {
              // Public fields only
              select: {
                id: true,
                name: true,
                image: true,
                profileDisplayImage: true,
                bio: true,
                city: true,
                country: true,
                linkedinUrl: true,
                timezone: true,
                workExperiences: {
                  orderBy: [{ isCurrent: "desc" }, { startDate: "desc" }],
                },
                education: {
                  orderBy: { endYear: "desc" },
                },
                certifications: {
                  orderBy: { issueDate: "desc" },
                },
              },
            },
        domain: true,
        subDomains: true,
        tags: true,
        slotsOfAvailabilityWeekly: true,
        slotsOfAvailabilityCustom: true,
        consultationPlans: {
          ...(planVisibilityFilter && { where: planVisibilityFilter }),
          include: { faqs: { orderBy: { order: "asc" } } },
        },
        subscriptionPlans: {
          ...(planVisibilityFilter && { where: planVisibilityFilter }),
          include: {
            subscriptionContents: {
              orderBy: { order: "asc" },
            },
            faqs: { orderBy: { order: "asc" } },
          },
        },
        webinarPlans: planVisibilityFilter
          ? { where: planVisibilityFilter }
          : true,
        classPlans: planVisibilityFilter
          ? { where: planVisibilityFilter }
          : true,
        reviews: {
          where: { deletedAt: null },
          select: { id: true, rating: true },
          take: 5,
        },
      },
    });

    return NextResponse.json(
      // Zod output contract: fails closed if any statutory-PII key ever appears —
      // defense-in-depth over the select allowlist. (#946)
      { data: consultant ? consultantPublicApiSchema.parse(consultant) : null },
      {
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        },
      },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "auth" } },
    );
    return apiError({ tag: "[Consultant.GET]", error });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    // Verify the caller owns this consultant profile
    const ownerCheck = await prisma.consultantProfile.findUnique({
      where: { id },
      select: { userId: true },
    });
    if (!ownerCheck || ownerCheck.userId !== session.user.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    const requestData = await request.json();

    // Validate request body using zod schema
    const validationResult = updateConsultantSchema.safeParse(requestData);
    if (!validationResult.success) {
      return NextResponse.json(
        {
          error: "Validation failed",
          details: validationResult.error.format(),
        },
        { status: 400 },
      );
    }

    const data = validationResult.data;
    const {
      description,
      experience,
      scheduleType,
      domainId,
      subDomainIds,
      tagIds,
      slotsOfAvailabilityWeekly,
      slotsOfAvailabilityCustom,
      // New fields
      headline,
      websiteUrl,
      twitterUrl,
      githubUrl,
      videoIntroUrl,
      languages,
      toolsAndTechnologies,
      mentoringStyle,
      sessionTypes,
      // User-level field
      linkedinUrl,
    } = data;

    // Check if schedule type is being changed
    const existingConsultant = await prisma.consultantProfile.findUnique({
      where: { id },
      select: { scheduleType: true },
    });

    if (
      existingConsultant &&
      existingConsultant.scheduleType !== scheduleType
    ) {
      // Validate that there are no active appointments before allowing switch
      const activeAppointments = await checkActiveAppointments(id);

      if (activeAppointments.hasActive) {
        return NextResponse.json(
          {
            error: `Cannot switch schedule type while you have ${activeAppointments.total} active appointment(s). Please complete or cancel them first.`,
            code: "SCHEDULE_SWITCH_BLOCKED",
            breakdown: activeAppointments.breakdown,
          },
          { status: 400 },
        );
      }
    }

    // Update consultant profile
    await prisma.consultantProfile.update({
      where: { id },
      data: {
        description,
        experience,
        scheduleType,
        domain: {
          connect: { id: domainId },
        },
        subDomains: {
          set: subDomainIds.map((id: string) => ({ id })),
        },
        tags: {
          set: tagIds.map((id: string) => ({ id })),
        },
        // New fields
        headline: headline ?? null,
        websiteUrl: websiteUrl || null,
        twitterUrl: twitterUrl || null,
        githubUrl: githubUrl || null,
        videoIntroUrl: videoIntroUrl || null,
        languages: languages ?? [],
        toolsAndTechnologies: toolsAndTechnologies ?? [],
        mentoringStyle: mentoringStyle ?? null,
        sessionTypes: sessionTypes ?? [],
      },
    });

    // Update user's linkedinUrl if provided (linkedinUrl is stored on User model)
    if (linkedinUrl !== undefined) {
      const consultant = await prisma.consultantProfile.findUnique({
        where: { id },
        select: { userId: true },
      });

      if (consultant?.userId) {
        await prisma.user.update({
          where: { id: consultant.userId },
          data: { linkedinUrl: linkedinUrl || null },
        });
      }
    }

    // Update weekly slots if schedule type is WEEKLY
    if (scheduleType === ScheduleType.WEEKLY) {
      if (slotsOfAvailabilityWeekly?.length) {
        // Resolve timezone offset once for all slots (same user → same
        // timezone), through the one resolver every write path shares (#1326).
        const userTimezone = await prisma.user
          .findUnique({
            where: { id: session.user.id },
            select: { timezone: true },
          })
          .then((u) => u?.timezone ?? null);
        let utcOffsetMinutes: number;
        try {
          utcOffsetMinutes = resolveWeeklyUtcOffsetMinutes({
            profileTimezone: userTimezone,
            callerSupplied: data.utcOffsetMinutes ?? null,
            consultantProfileId: id,
          });
        } catch (error) {
          if (error instanceof WeeklyOffsetConflictError) {
            return NextResponse.json(
              { error: error.message, code: error.code },
              { status: 400 },
            );
          }
          throw error;
        }
        const rowTimezone = resolveWeeklyTimezone(userTimezone);

        const weeklySlotData: Prisma.SlotOfAvailabilityWeeklyCreateManyInput[] =
          slotsOfAvailabilityWeekly.map((slot) => {
            const startTimeUtc = dateToMinuteUtc(new Date(slot.startsAt));
            const endTimeUtc = dateToMinuteUtc(new Date(slot.endsAt));
            // #1343 — dayOfWeekforStartTimeInUTC is the wire name the settings
            // form still sends; what it carries is the consultant's LOCAL day.
            return {
              consultantProfileId: id,
              startDay: slot.dayOfWeekforStartTimeInUTC,
              endDay: slot.dayOfWeekforEndTimeInUTC,
              startTimeUtc,
              endTimeUtc,
              utcOffsetMinutes,
            };
          });

        // Validate each weekly slot before saving
        for (const slot of weeklySlotData) {
          const timeError = validateWeeklySlotTimeOrder(
            slot.startDay as DayOfWeek,
            slot.endDay as DayOfWeek,
            slot.startTimeUtc,
            slot.endTimeUtc,
          );
          if (timeError) {
            return NextResponse.json({ error: timeError }, { status: 400 });
          }
        }

        // Check for overlaps within the submitted set
        for (let i = 0; i < weeklySlotData.length; i++) {
          for (let j = i + 1; j < weeklySlotData.length; j++) {
            if (
              slotsOverlap(
                weeklySlotData[i] as {
                  startDay: DayOfWeek;
                  endDay: DayOfWeek;
                  startTimeUtc: number;
                  endTimeUtc: number;
                },
                weeklySlotData[j] as {
                  startDay: DayOfWeek;
                  endDay: DayOfWeek;
                  startTimeUtc: number;
                  endTimeUtc: number;
                },
              )
            ) {
              return NextResponse.json(
                {
                  error:
                    "Submitted weekly slots contain overlapping time ranges",
                },
                { status: 400 },
              );
            }
          }
        }

        // Delete existing then create new, atomically — a failure between the
        // two halves would leave the consultant with no availability at all.
        // #1320 — see utils/slotAllocation/mergeAdjacentWeeklyRows.ts.
        //
        // Serializable, like the per-row slot routes: at Read Committed a
        // second replacement running concurrently takes its snapshot before
        // the first commits, so its delete misses the rows the first inserted
        // and both sets survive — overlapping availability, which every
        // downstream reader assumes cannot exist.
        // #872 — the five DST columns are dual-written from the same resolver,
        // and computed AFTER the merge so they describe the row that is
        // actually stored. No reader consults them until the reader flip.
        const mergedWeekly = mergeAdjacentWeeklyRows(weeklySlotData).map(
          (row) => ({
            ...row,
            ...weeklyRowLocalColumns(row, rowTimezone, utcOffsetMinutes),
          }),
        );
        await withSerializableRetry(() =>
          prisma.$transaction(
            async (tx) => {
              await tx.slotOfAvailabilityWeekly.deleteMany({
                where: { consultantProfileId: id },
              });
              await tx.slotOfAvailabilityWeekly.createMany({
                data: mergedWeekly,
              });
            },
            {
              isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
              maxWait: 10_000,
              timeout: 15_000,
            },
          ),
        );
      } else {
        // No weekly slots submitted — clear existing
        await prisma.slotOfAvailabilityWeekly.deleteMany({
          where: { consultantProfileId: id },
        });
      }
    }

    // Update custom slots if schedule type is CUSTOM
    if (scheduleType === ScheduleType.CUSTOM) {
      if (slotsOfAvailabilityCustom?.length) {
        // Dates, not the wider `string | Date` the Prisma input allows, so the
        // merge below can compare instants (#1320).
        const customSlotData: (Prisma.SlotOfAvailabilityCustomCreateManyInput & {
          startsAt: Date;
          endsAt: Date;
        })[] = slotsOfAvailabilityCustom.map((slot) => ({
          consultantProfileId: id,
          startsAt: new Date(slot.startsAt),
          endsAt: new Date(slot.endsAt),
        }));

        // Validate custom slot ordering and check for pairwise overlaps
        for (const slot of customSlotData) {
          if (
            new Date(slot.startsAt).getTime() >= new Date(slot.endsAt).getTime()
          ) {
            return NextResponse.json(
              { error: "Custom slot start time must be before end time" },
              { status: 400 },
            );
          }
        }
        for (let i = 0; i < customSlotData.length; i++) {
          for (let j = i + 1; j < customSlotData.length; j++) {
            const a = customSlotData[i];
            const b = customSlotData[j];
            if (
              new Date(a.startsAt).getTime() < new Date(b.endsAt).getTime() &&
              new Date(b.startsAt).getTime() < new Date(a.endsAt).getTime()
            ) {
              return NextResponse.json(
                {
                  error:
                    "Submitted custom slots contain overlapping time ranges",
                },
                { status: 400 },
              );
            }
          }
        }

        // Delete existing then create new, atomically and Serializably — see
        // the weekly arm for both reasons.
        // #1320 — see utils/slotAllocation/mergeAdjacentWeeklyRows.ts.
        const mergedCustom = mergeAdjacentCustomRows(customSlotData);
        await withSerializableRetry(() =>
          prisma.$transaction(
            async (tx) => {
              await tx.slotOfAvailabilityCustom.deleteMany({
                where: { consultantProfileId: id },
              });
              await tx.slotOfAvailabilityCustom.createMany({
                data: mergedCustom,
              });
            },
            {
              isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
              maxWait: 10_000,
              timeout: 15_000,
            },
          ),
        );
      } else {
        // No custom slots submitted — clear existing
        await prisma.slotOfAvailabilityCustom.deleteMany({
          where: { consultantProfileId: id },
        });
      }
    }

    // Fetch and return the updated consultant with all relations
    const updatedConsultant = await prisma.consultantProfile.findUnique({
      where: { id },
      include: {
        user: {
          include: {
            workExperiences: {
              orderBy: [{ isCurrent: "desc" }, { startDate: "desc" }],
            },
            education: {
              orderBy: { endYear: "desc" },
            },
            certifications: {
              orderBy: { issueDate: "desc" },
            },
          },
        },
        domain: true,
        subDomains: true,
        tags: true,
        slotsOfAvailabilityWeekly: true,
        slotsOfAvailabilityCustom: true,
        consultationPlans: true,
        subscriptionPlans: {
          include: {
            subscriptionContents: {
              orderBy: { order: "asc" },
            },
          },
        },
        webinarPlans: true,
        classPlans: true,
        reviews: { where: { deletedAt: null } },
      },
    });

    // Headline, description, experience, domain and tags are all rendered on the
    // public profile and the directory cards, so an expert editing their profile
    // should see it live rather than wait out the ISR window.
    purgeExpertSurfaces(id);

    return NextResponse.json({ data: updatedConsultant });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "auth" } },
    );
    return apiError({ tag: "[Consultant.PUT]", error });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    // Verify the caller owns this consultant profile
    const ownerCheck = await prisma.consultantProfile.findUnique({
      where: { id },
      select: {
        userId: true,
        deletedAt: true,
        // #781 §B — earnings/payouts/TDS Restrict this profile; a profile
        // that ever moved money can only soft-delete.
        _count: {
          select: { earnings: true, payouts: true, tdsRecords: true },
        },
      },
    });
    if (!ownerCheck || ownerCheck.userId !== session.user.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }
    if (ownerCheck.deletedAt) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const hasMoneyHistory =
      ownerCheck._count.earnings +
        ownerCheck._count.payouts +
        ownerCheck._count.tdsRecords >
      0;

    if (hasMoneyHistory) {
      // Soft delete: financial rows (and the PAN they were withheld
      // against) survive for statutory retention. Slots go so nothing is
      // bookable; plans stay (historical bookings reference them) but the
      // browse/checkout surfaces filter deletedAt profiles out.
      await prisma.$transaction([
        prisma.slotOfAvailabilityWeekly.deleteMany({
          where: { consultantProfileId: id },
        }),
        prisma.slotOfAvailabilityCustom.deleteMany({
          where: { consultantProfileId: id },
        }),
        prisma.consultantProfile.update({
          where: { id },
          data: { deletedAt: new Date() },
        }),
      ]);
      // deletedAt is one of the two public gates — the profile has just left
      // both public surfaces.
      purgeExpertSurfaces(id);
      return NextResponse.json({
        message: "Consultant deactivated (financial history retained)",
        softDeleted: true,
      });
    }

    // No money ever moved — full hard delete is safe.
    await prisma.$transaction([
      // Delete slots
      prisma.slotOfAvailabilityWeekly.deleteMany({
        where: { consultantProfileId: id },
      }),
      prisma.slotOfAvailabilityCustom.deleteMany({
        where: { consultantProfileId: id },
      }),

      // Delete plans
      prisma.consultationPlan.deleteMany({
        where: { consultantProfileId: id },
      }),
      prisma.subscriptionPlan.deleteMany({
        where: { consultantProfileId: id },
      }),
      prisma.webinarPlan.deleteMany({
        where: { consultantProfileId: id },
      }),
      prisma.classPlan.deleteMany({
        where: { consultantProfileId: id },
      }),

      // Delete reviews
      prisma.consultantReview.deleteMany({
        where: { consultantProfileId: id },
      }),

      // Delete the consultant profile
      prisma.consultantProfile.delete({
        where: { id },
      }),
    ]);

    purgeExpertSurfaces(id);
    return NextResponse.json({ message: "Consultant deleted successfully" });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "auth" } },
    );
    return apiError({ tag: "[Consultant.DELETE]", error });
  }
}
