import * as Sentry from "@sentry/nextjs";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import prisma from "@/lib/prisma";
import { faqCreateNested, faqReplaceNested } from "@/lib/api/plans/content";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { WebinarPlanSchema } from "@/schemas/plans";
import { Prisma, WebinarStatus } from "@prisma/client";
import {
  EVENT_PUBLISHABLE_FROM,
  transitionWebinarEvent,
} from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { findOrCreateTopics, transformNestedPlanTopics } from "@/lib/topics";
import { checkConsultantVerification } from "@/lib/verification";
import { countWebinarParticipants } from "@/lib/payments/utils/participants";
import {
  CapacityBelowEnrollmentError,
  capacityBelowRegisteredMessage,
} from "@/lib/events/capacity";
import {
  assertCollaboratorsAvailable,
  CollaboratorUnavailableError,
} from "@/lib/collaborators/availability";
import { isExclusionViolation } from "@/lib/db/pg-errors";
import {
  ScheduleLockedError,
  WEBINAR_TIME_LOCKED_MESSAGE,
} from "@/lib/events/schedule-lock";
import {
  buildContiguousSlotAtoms,
  replaceContiguousSlotRun,
} from "@/lib/appointments/contiguous-slot-run";
import { isDeadSlot } from "@/lib/appointments/slots";

/**
 * Nested include for "what is the current live run?".
 *
 * Ordering by `startsAt` alone is not enough: the consultee reschedule route
 * leaves replaced atoms in place as `RESCHEDULED`, so `[0]` becomes the *old*
 * earlier dead row. Duration-only planner edits then rewrote the live run back
 * onto the cancelled time. Filter at the query (and again with `isDeadSlot`
 * when reading already-loaded arrays) so runStart/runEnd are always live.
 *
 * `completionStatus` is `SlotCompletionStatus @default(SCHEDULED)` — never
 * NULL — so a plain `notIn` is enough (SQL's NULL/`NOT IN` caveat does not
 * apply). `satisfies` keeps the hoisted literal contextually typed as
 * Prisma's nested-args shape; without it `notIn: string[]` widens and poisons
 * the whole webinar include inference.
 */
const LIVE_SLOTS_INCLUDE = {
  orderBy: { startsAt: "asc" as const },
  where: {
    deletedAt: null,
    completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] },
  },
} satisfies Prisma.Appointment$slotsOfAppointmentArgs;

import { getSession } from "@/lib/auth-server";
// Schema for POST request body based on WebinarPlanSchema
// Topics are now accepted as names (strings) - API handles finding/creating
const PostWebinarWithPlanBodySchema = WebinarPlanSchema.omit({
  consultantProfile: true,
  topics: true,
  scheduledAt: true,
}).extend({
  consultantProfileId: z.string().min(1, "Consultant profile ID is required"),
  // Topics as names - API will find or create them
  topics: z
    .array(z.string().min(1, "Topic name cannot be empty"))
    .min(1, "At least one topic is required"),
  scheduledAt: z
    .string()
    .optional()
    .nullable()
    .refine((val) => !val || !isNaN(Date.parse(val)), {
      message: "Invalid date format for scheduledAt",
    }),
  status: z
    .nativeEnum(WebinarStatus)
    .optional()
    .default(WebinarStatus.SCHEDULED),
});

// Schema for PATCH request body
const PatchWebinarWithPlanBodySchema = PostWebinarWithPlanBodySchema.omit({
  topics: true,
})
  .partial()
  .extend({
    id: z.string().min(1, "Webinar Plan ID is required for update"),
    webinarId: z.string().optional().nullable(),
    topics: z.array(z.string()).optional(),
  });

export async function POST(request: NextRequest) {
  try {
    // Authentication check
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const body = await request.json();
    console.log(
      "Received webinar creation request body:",
      JSON.stringify(body, null, 2),
    );

    // Verification check - consultant must be verified to create webinars
    if (body.consultantProfileId) {
      const verification = await checkConsultantVerification(
        body.consultantProfileId,
      );
      if (!verification.isVerified) {
        return NextResponse.json(
          {
            error: "Verification required",
            message: verification.message,
            verificationStatus: verification.status,
          },
          { status: 403 },
        );
      }
    }

    // --- Zod Validation ---
    const validationResult = PostWebinarWithPlanBodySchema.safeParse(body);
    if (!validationResult.success) {
      console.error("Validation Error (POST):", validationResult.error.issues);
      return NextResponse.json(
        { error: "Invalid input", details: validationResult.error.issues },
        { status: 400 },
      );
    }

    const validatedData = validationResult.data;
    const {
      title,
      description,
      durationInHours,
      price,
      maxParticipants,
      language,
      level,
      prerequisites,
      materialProvided,
      learningOutcomes,
      subtitle,
      targetAudience,
      whatsIncluded,
      faqs,
      priceCurrency,
      consultantProfileId,
      topics: topicNames,
      scheduledAt,
      status,
      certificateProvided,
      recordingEnabled,
      recordingStoragePolicy,
    } = validatedData;

    // Verify ownership - user must own this consultant profile
    const consultantProfile = await prisma.consultantProfile.findFirst({
      where: {
        id: consultantProfileId,
        userId: session.user.id,
      },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        {
          error:
            "You do not have permission to create webinars for this consultant profile",
        },
        { status: 403 },
      );
    }

    // Find or create topics by name
    const topicIds = await findOrCreateTopics(topicNames);

    console.log("Validated fields:", {
      title,
      durationInHours,
      price,
      maxParticipants,
      consultantProfileId,
      scheduledAt,
      topicNames,
      status,
    });

    // Calculate end time using validated data if scheduledAt is provided
    let startTime: Date | undefined = undefined;
    let endTime: Date | undefined = undefined;

    if (scheduledAt) {
      // Zod refine ensures parseable date if scheduledAt is a string
      const parsedStartTime = new Date(scheduledAt);
      if (!isNaN(parsedStartTime.getTime())) {
        startTime = parsedStartTime;
        endTime = new Date(startTime);
        // Zod ensures durationInHours is a valid number
        endTime.setHours(startTime.getHours() + durationInHours);
        console.log("Calculated times:", {
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          durationInHours,
        });
      } else {
        // Was a silent skip: startTime stayed undefined, the nested appointment
        // create was replaced with `undefined`, and the result was a published
        // webinar with no session and nothing to join. A time that does not
        // parse is bad input, not a reason to ship a broken offering.
        return NextResponse.json(
          {
            error:
              "The scheduled time could not be read. Please pick the date and time again.",
            code: "INVALID_SCHEDULED_AT",
          },
          { status: 400 },
        );
      }
    } else {
      console.log(
        "No scheduledAt provided. Webinar will be created as a DRAFT with no session yet.",
      );
      // startTime and endTime remain undefined — the webinar is created in
      // DRAFT and cannot be published until a session exists.
    }

    // A webinar with no session is authored, not live. DRAFT keeps it off the
    // marketplace and out of the detail pages for everyone but its owner.
    const initialStatus = startTime ? "SCHEDULED" : "DRAFT";

    // Create webinar plan, instance, and appointment in a transaction
    const result = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          // Topics are already created/found by findOrCreateTopics, no verification needed

          // 1. Create the webinar plan using validated data
          console.log("Creating webinar plan with validated data:", {
            title,
            description,
            durationInHours,
            price,
            maxParticipants,
            consultantProfileId,
            topicIds,
          });

          const webinarPlan = await tx.webinarPlan.create({
            data: {
              // Spread validated plan fields
              title,
              description,
              durationInHours,
              price,
              priceCurrency,
              maxParticipants,
              language,
              level,
              prerequisites,
              materialProvided,
              learningOutcomes,
              subtitle,
              targetAudience,
              whatsIncluded,
              faqs: faqCreateNested(faqs),
              certificateProvided,
              recordingEnabled,
              recordingStoragePolicy,
              consultantProfile: { connect: { id: consultantProfileId } },
              topics:
                topicIds.length > 0
                  ? { connect: topicIds.map((id: string) => ({ id })) }
                  : undefined,
            },
            include: {
              consultantProfile: true,
              topics: true,
              faqs: { orderBy: { order: "asc" } },
            },
          });

          console.log("Created webinar plan:", {
            id: webinarPlan.id,
            title: webinarPlan.title,
            topicsCount: webinarPlan.topics.length,
          });

          // 2. Create the webinar instance using validated data
          console.log(
            "Creating webinar instance with plan ID:",
            webinarPlan.id,
          );

          const webinar = await tx.webinar.create({
            data: {
              // A session-less webinar is authored, not live — see initialStatus.
              // The client cannot promote it past DRAFT by sending a status.
              status: initialStatus === "DRAFT" ? "DRAFT" : status,
              webinarPlan: { connect: { id: webinarPlan.id } },
              // Create the appointment at the same time
              // Ensure startTime and endTime are valid before creating appointment
              appointment:
                startTime && endTime
                  ? {
                      // #1071 — N×30min atoms (same shape as SlotAllocationService),
                      // never one long row spanning the full duration.
                      create: {
                        appointmentType: "WEBINAR",
                        slotsOfAppointment: {
                          create: buildContiguousSlotAtoms({
                            startsAt: startTime,
                            durationInHours,
                            consultantProfileId,
                            isTentative: false,
                          }),
                        },
                      },
                    }
                  : undefined, // Don't create appointment if no valid scheduledAt
            },
            include: {
              webinarPlan: {
                include: {
                  consultantProfile: true,
                  topics: true,
                },
              },
              appointment: {
                include: {
                  slotsOfAppointment: {
                    include: {
                      user: true,
                    },
                  },
                },
              },
            },
          });

          console.log("Created webinar instance:", {
            id: webinar.id,
            planId: webinar.webinarPlanId,
            appointmentId: webinar.appointment?.id,
            hasSlots:
              (webinar.appointment?.slotsOfAppointment?.length ?? 0) > 0,
          });

          return { webinarPlan, webinar };
        },
        {
          timeout: 10000, // 10 second timeout
          maxWait: 5000, // 5 second max wait
          isolationLevel: "Serializable", // Highest isolation level
        },
      ),
    );

    console.log("Transaction completed successfully. Returning webinar data.");
    // Transform topics to strings in response
    const transformedWebinar = transformNestedPlanTopics(
      result.webinar,
      "webinarPlan",
    );
    return NextResponse.json({ data: transformedWebinar }, { status: 201 });
  } catch (error) {
    // --- Zod Error Handling ---
    if (error instanceof z.ZodError) {
      console.error("Validation Error (POST Catch):", error.issues);
      return NextResponse.json(
        { error: "Invalid input", details: error.issues },
        { status: 400 },
      );
    }
    // --- End Zod Error Handling ---

    // #784 — owner now denormalized onto group-event slots, so a scheduling
    // overlap trips slot_no_confirmed_overlap (23P01): that's a conflict, not 500.
    if (isExclusionViolation(error)) {
      return NextResponse.json(
        {
          error:
            "That time conflicts with another confirmed session on your calendar.",
        },
        { status: 409 },
      );
    }

    console.error("Error creating webinar with plan:", error);

    // If error indicates topics don't exist, handle specifically
    if (
      error instanceof Error &&
      error.message.includes("The following topic IDs do not exist:") // More specific check
    ) {
      return NextResponse.json(
        { error: `Invalid topics provided: ${error.message}` },
        { status: 400 },
      );
    }

    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    return NextResponse.json(
      { error: "An error occurred while creating the webinar" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    // Authentication check
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const body = await request.json();
    console.log(
      "Received webinar update request body:",
      JSON.stringify(body, null, 2),
    );

    // --- Zod Validation ---
    const validationResult = PatchWebinarWithPlanBodySchema.safeParse(body);
    if (!validationResult.success) {
      console.error("Validation Error (PATCH):", validationResult.error.issues);
      return NextResponse.json(
        { error: "Invalid input", details: validationResult.error.issues },
        { status: 400 },
      );
    }

    const validatedData = validationResult.data;
    const {
      id, // Webinar plan ID (required)
      webinarId, // Webinar instance ID (optional)
      // Optional fields from validated data
      title,
      description,
      durationInHours,
      price,
      maxParticipants,
      language,
      level,
      prerequisites,
      materialProvided,
      learningOutcomes,
      subtitle,
      targetAudience,
      whatsIncluded,
      faqs,
      consultantProfileId,
      topics: topicNames,
      status,
      scheduledAt,
      priceCurrency,
      certificateProvided,
      recordingEnabled,
      recordingStoragePolicy,
    } = validatedData;

    // Find or create topics by name if provided
    let topicIds: string[] | undefined;
    if (topicNames !== undefined) {
      topicIds = await findOrCreateTopics(topicNames);
    }

    console.log("Validated fields for update:", {
      id,
      webinarId,
      title,
      durationInHours,
      topicIds: topicIds ? `[${topicIds.length} topics]` : "undefined",
      status,
      scheduledAt,
    });

    // Remove old manual validation
    // if (!id) { ... } // Handled by Zod
    // if (!title || !durationInHours || ...) { ... } // Handled by Zod (optionality)

    // First, check if the webinar plan exists (still necessary)
    const existingPlan = await prisma.webinarPlan.findUnique({
      where: { id },
      include: {
        consultantProfile: true,
        topics: true,
        webinars: {
          include: {
            appointment: {
              include: {
                // #1071 — live rows only; dead RESCHEDULED must not own [0].
                slotsOfAppointment: LIVE_SLOTS_INCLUDE,
              },
            },
          },
        },
      },
    });

    if (!existingPlan) {
      return NextResponse.json(
        { error: `Webinar plan with ID ${id} not found` },
        { status: 404 },
      );
    }

    // Verify ownership - user must own this webinar plan
    if (
      !existingPlan.consultantProfile ||
      existingPlan.consultantProfile.userId !== session.user.id
    ) {
      return NextResponse.json(
        { error: "You do not have permission to update this webinar" },
        { status: 403 },
      );
    }

    // Get the webinar instance - use the provided webinarId or the first one associated with the plan
    const webinarToUpdate = webinarId
      ? await prisma.webinar.findUnique({
          where: { id: webinarId },
          include: {
            appointment: {
              include: {
                slotsOfAppointment: LIVE_SLOTS_INCLUDE,
              },
            },
          },
        })
      : existingPlan.webinars.length > 0
        ? existingPlan.webinars[0]
        : null;

    if (
      !webinarToUpdate &&
      (status !== undefined || scheduledAt !== undefined)
    ) {
      return NextResponse.json(
        {
          error:
            "Cannot update status or scheduling: no webinar instance found",
        },
        { status: 400 },
      );
    }

    // Calculate startTime and endTime if scheduledAt is provided
    let startTime = undefined;
    let endTime = undefined;

    // Use the validated scheduledAt (optional) and durationInHours (required if scheduledAt provided for calc)
    if (scheduledAt) {
      // Zod refine should ensure valid date string if present
      const scheduledDate = new Date(scheduledAt);
      if (isNaN(scheduledDate.getTime())) {
        throw new Error(
          "Invalid scheduledAt date format after validation (PATCH).",
        );
      }

      startTime = scheduledDate;

      // Duration needed to calculate end time. Use plan's existing if not provided in patch.
      // Ensure durationInHours from validatedData (optional) or existingPlan is valid
      const effectiveDuration = durationInHours ?? existingPlan.durationInHours;
      if (typeof effectiveDuration !== "number" || effectiveDuration <= 0) {
        throw new Error("Invalid duration for calculating end time.");
      }

      endTime = new Date(
        scheduledDate.getTime() + effectiveDuration * 60 * 60 * 1000,
      );

      console.log("Calculated slot times (PATCH):", {
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        effectiveDuration,
      });
    } else if (
      durationInHours !== undefined &&
      webinarToUpdate?.appointment?.slotsOfAppointment?.length
    ) {
      // Duration-only change: keep the live run's earliest start.
      const existingSlot = webinarToUpdate.appointment.slotsOfAppointment.find(
        (s) => !isDeadSlot(s),
      );
      if (existingSlot) {
        startTime = existingSlot.startsAt;
        endTime = new Date(
          startTime.getTime() + durationInHours * 60 * 60 * 1000,
        );
        console.log(
          "Recalculated slot end time due to duration change (PATCH):",
          {
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            newDuration: durationInHours,
          },
        );
      }
    }

    const effectiveDurationForSlots =
      durationInHours ?? existingPlan.durationInHours;

    // Update webinar plan and related data in a transaction
    const result = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          // -> Use topics from existingPlan fetched *before* the transaction
          const currentTopicIdsFromOuterScope = existingPlan.topics.map(
            (t) => t.id,
          );
          console.log(
            `[Before Transaction Update] Topics from initial fetch for plan ${id}:`,
            currentTopicIdsFromOuterScope,
          );

          // Prepare base update data using validated fields (excluding topics for now)
          const updateData: Prisma.WebinarPlanUpdateInput = {};
          if (title !== undefined) updateData.title = title;
          if (description !== undefined) updateData.description = description;
          if (durationInHours !== undefined)
            updateData.durationInHours = durationInHours;
          if (price !== undefined) updateData.price = price;
          if (priceCurrency !== undefined)
            updateData.priceCurrency = priceCurrency;
          // Capacity is per instance. Only move the plan's default when the
          // caller is editing the plan itself rather than one of its webinars.
          if (maxParticipants !== undefined && !webinarToUpdate)
            updateData.maxParticipants = maxParticipants;
          if (language !== undefined) updateData.language = language;
          if (level !== undefined) updateData.level = level;
          if (prerequisites !== undefined)
            updateData.prerequisites = prerequisites;
          if (materialProvided !== undefined)
            updateData.materialProvided = materialProvided;
          if (certificateProvided !== undefined)
            updateData.certificateProvided = certificateProvided;
          if (recordingEnabled !== undefined)
            updateData.recordingEnabled = recordingEnabled;
          if (recordingStoragePolicy !== undefined)
            updateData.recordingStoragePolicy = recordingStoragePolicy;
          if (learningOutcomes !== undefined)
            updateData.learningOutcomes = learningOutcomes;
          if (subtitle !== undefined) updateData.subtitle = subtitle;
          if (targetAudience !== undefined)
            updateData.targetAudience = targetAudience;
          if (whatsIncluded !== undefined)
            updateData.whatsIncluded = whatsIncluded;
          if (faqs !== undefined) updateData.faqs = faqReplaceNested(faqs);
          if (consultantProfileId !== undefined)
            updateData.consultantProfile = {
              connect: { id: consultantProfileId },
            };

          // Handle topics: topicIds are already validated/created by findOrCreateTopics
          if (topicIds !== undefined) {
            updateData.topics = {
              set: topicIds.map((topicId: string) => ({ id: topicId })),
            };
            console.log(
              `Syncing topics with provided IDs: [${topicIds.join(", ")}]`,
            );
          } else {
            console.log(
              "topics is undefined in PATCH request. Existing topics will not be modified.",
            );
          }

          // Execute the plan update only if there are changes
          let updatedWebinarPlan = existingPlan;
          if (Object.keys(updateData).length > 0 || topicIds !== undefined) {
            // Check topics for changes
            updatedWebinarPlan = await tx.webinarPlan.update({
              where: { id },
              data: updateData,
              include: {
                consultantProfile: true,
                topics: true,
                webinars: {
                  // Ensure webinars relation is included
                  include: {
                    // And nest includes to match existingPlan type
                    appointment: {
                      // Include the appointment
                      include: {
                        // And the slots within the appointment
                        slotsOfAppointment: true,
                      },
                    },
                  },
                },
              },
            });
          }

          // Update the webinar instance status if provided in the validated data
          let updatedWebinar = webinarToUpdate;
          if (updatedWebinar) {
            const webinarUpdateData: Prisma.WebinarUpdateInput = {};

            // #1319 — status rides the CAS helper, never a bare update: a stale
            // tab could flip a CANCELLED (already refunded) event back to
            // SCHEDULED. Publishing is the one edge that leaves DRAFT, and it
            // is not in EVENT_ALLOWED_FROM.SCHEDULED by design (#1060).
            let statusChanged = false;
            if (status !== undefined && status !== updatedWebinar.status) {
              const publishing =
                status === "SCHEDULED" && updatedWebinar.status === "DRAFT";
              await transitionWebinarEvent(tx, {
                where: { id: updatedWebinar.id },
                to: status,
                fromIn: publishing ? EVENT_PUBLISHABLE_FROM : undefined,
              });
              statusChanged = true;
            }

            // #628 — shrinking below the people already in the room would
            // silently strand paying registrants. Checked inside the tx (the
            // old guard ran before it and left a TOCTOU window).
            if (maxParticipants !== undefined) {
              const appointmentWithSlots = updatedWebinar.appointment
                ? await tx.appointment.findUnique({
                    where: { id: updatedWebinar.appointment.id },
                    include: {
                      slotsOfAppointment: {
                        include: { user: { select: { id: true } } },
                      },
                    },
                  })
                : null;
              const consultantUserId = existingPlan.consultantProfile?.userId;
              const enrolledCount = countWebinarParticipants(
                appointmentWithSlots,
                consultantUserId ? [consultantUserId] : [],
              );
              if (maxParticipants < enrolledCount) {
                throw new CapacityBelowEnrollmentError(
                  capacityBelowRegisteredMessage(
                    maxParticipants,
                    enrolledCount,
                  ),
                );
              }
              webinarUpdateData.maxParticipants = maxParticipants;
            }

            if (Object.keys(webinarUpdateData).length > 0) {
              updatedWebinar = await tx.webinar.update({
                where: { id: updatedWebinar.id },
                data: webinarUpdateData,
                include: {
                  webinarPlan: {
                    include: {
                      consultantProfile: true,
                      topics: true,
                    },
                  },
                  appointment: {
                    include: {
                      slotsOfAppointment: {
                        include: {
                          user: true,
                        },
                      },
                    },
                  },
                },
              });
            } else if (statusChanged) {
              // Only the status moved; re-read so the response reflects it.
              updatedWebinar = await tx.webinar.findUniqueOrThrow({
                where: { id: updatedWebinar.id },
                include: {
                  webinarPlan: {
                    include: {
                      consultantProfile: true,
                      topics: true,
                    },
                  },
                  appointment: {
                    include: {
                      slotsOfAppointment: {
                        include: {
                          user: true,
                        },
                      },
                    },
                  },
                },
              });
            }

            // 8. Replace the appointment's live slot run (#1071) when times change.
            if (startTime && endTime) {
              const appointment = updatedWebinar.appointment;

              // #626 — a webinar with paying registrants may not be re-timed
              // here; the reschedule workflow is the front door. Read INSIDE the
              // txn: the pre-txn version counted payments and then committed the
              // move, so a checkout landing in between moved the time under a
              // registrant who had just paid for the old one.
              if (appointment) {
                const activePayments = await tx.payment.count({
                  where: {
                    appointmentId: appointment.id,
                    paymentStatus: { notIn: ["FAILED", "EXPIRED"] },
                  },
                });
                if (activePayments > 0) {
                  const liveSlots = (
                    await tx.slotOfAppointment.findMany({
                      where: { appointmentId: appointment.id },
                      orderBy: { startsAt: "asc" },
                    })
                  ).filter((slot) => !isDeadSlot(slot));
                  const runStart = liveSlots[0]?.startsAt;
                  const runEnd = liveSlots[liveSlots.length - 1]?.endsAt;
                  // Only a REAL move is blocked — the planner client re-sends
                  // scheduledAt even for a title-only edit.
                  if (
                    !runStart ||
                    !runEnd ||
                    runStart.getTime() !== startTime.getTime() ||
                    runEnd.getTime() !== endTime.getTime()
                  ) {
                    throw new ScheduleLockedError(WEBINAR_TIME_LOCKED_MESSAGE);
                  }
                }
              }

              // AE-2 (#784) — block (re)scheduling onto a time any ACCEPTED co-host
              // is already committed to; co-hosts aren't slot participants, so no
              // other guard catches their double-booking. Throws → 409 below.
              await assertCollaboratorsAvailable(tx, {
                planType: "WEBINAR",
                planId: id,
                startsAt: startTime,
                endsAt: endTime,
                excludeAppointmentId: appointment?.id ?? null,
              });

              // Validate here (→ 400 in catch) instead of letting
              // buildContiguousSlotAtoms throw a generic Error (→ 500). TypeError
              // also satisfies Sonar's "use TypeError for type checks" hint.
              if (
                typeof effectiveDurationForSlots !== "number" ||
                !Number.isFinite(effectiveDurationForSlots) ||
                effectiveDurationForSlots <= 0
              ) {
                throw new TypeError(
                  "Invalid duration for rewriting contiguous slot run.",
                );
              }
              // Prefer the PATCH-requested owner when transferring the plan so
              // rewritten atoms land on the new consultant's calendar (and
              // slot_no_confirmed_overlap protects the right profile).
              const ownerProfileId =
                consultantProfileId ?? existingPlan.consultantProfileId;
              if (!ownerProfileId) {
                throw new Error(
                  "Webinar plan is missing consultantProfileId; cannot rewrite slots.",
                );
              }

              if (appointment) {
                console.log("Replacing contiguous slot run (#1071):", {
                  appointmentId: appointment.id,
                  startTime: startTime.toISOString(),
                  endTime: endTime.toISOString(),
                  durationInHours: effectiveDurationForSlots,
                });

                await replaceContiguousSlotRun(tx, {
                  appointmentId: appointment.id,
                  startsAt: startTime,
                  durationInHours: effectiveDurationForSlots,
                  consultantProfileId: ownerProfileId,
                  isTentative: false,
                });
              } else {
                console.log("Creating new appointment + contiguous slot run");

                await tx.appointment.create({
                  data: {
                    webinar: { connect: { id: updatedWebinar.id } },
                    appointmentType: "WEBINAR",
                    slotsOfAppointment: {
                      create: buildContiguousSlotAtoms({
                        startsAt: startTime,
                        durationInHours: effectiveDurationForSlots,
                        consultantProfileId: ownerProfileId,
                        isTentative: false,
                      }),
                    },
                  },
                });
              }
            }

            // Retrieve the fully updated webinar after all changes
            updatedWebinar = await tx.webinar.findUnique({
              where: { id: updatedWebinar.id },
              include: {
                webinarPlan: {
                  include: {
                    consultantProfile: true,
                    topics: true,
                  },
                },
                appointment: {
                  include: {
                    slotsOfAppointment: {
                      include: {
                        user: true,
                      },
                    },
                  },
                },
              },
            });
          }

          // Return the results
          return {
            webinarPlan: updatedWebinarPlan,
            webinar: updatedWebinar,
          };
        },
        {
          timeout: 10000, // 10 second timeout
          maxWait: 5000, // 5 second max wait
          isolationLevel: "Serializable", // Highest isolation level
        },
      ),
    );

    console.log(
      "Update transaction completed successfully. Returning updated webinar data.",
    );

    // Transform topics to strings in response
    let responseData;
    if (result.webinar) {
      responseData = transformNestedPlanTopics(result.webinar, "webinarPlan");
    } else {
      responseData = {
        ...result.webinarPlan,
        topics: result.webinarPlan.topics.map((t) => t.name),
      };
    }

    return NextResponse.json({ data: responseData }, { status: 200 });
  } catch (error) {
    // --- Zod Error Handling ---
    if (error instanceof z.ZodError) {
      console.error("Validation Error (PATCH Catch):", error.issues);
      return NextResponse.json(
        { error: "Invalid input", details: error.issues },
        { status: 400 },
      );
    }
    // --- End Zod Error Handling ---

    // Shrinking below the current roster is a user error, not a 500.
    if (error instanceof CapacityBelowEnrollmentError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (
      error instanceof TypeError &&
      error.message.includes("Invalid duration")
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // #626 — frozen times on a booked webinar is a user error, not a 500.
    if (error instanceof ScheduleLockedError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // #1319 — an illegal status move (stale tab, cancelled event) is a 409.
    if (error instanceof IllegalTransitionError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    // AE-2 — co-host clash is a conflict, not a server error.
    if (error instanceof CollaboratorUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    // #784 — owner overlap on the shared exclusion constraint → 409, not 500.
    if (isExclusionViolation(error)) {
      return NextResponse.json(
        {
          error:
            "That time conflicts with another confirmed session on your calendar.",
        },
        { status: 409 },
      );
    }

    console.error("Error updating webinar with plan:", error);

    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    return NextResponse.json(
      { error: "An error occurred while updating the webinar" },
      { status: 500 },
    );
  }
}
