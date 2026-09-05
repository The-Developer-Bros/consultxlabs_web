import "server-only";
import {
  mergeAdjacentCustomRows,
  mergeAdjacentWeeklyRows,
} from "@/utils/slotAllocation/mergeAdjacentWeeklyRows";
import { Prisma } from "@prisma/client";
import { UserRole, ScheduleType } from "@prisma/client";
import prisma, { type Tx } from "@/lib/prisma";
import { isValidTimeRange } from "@/utils/timeSlotValidation";
import {
  validateWeeklySlotTimeOrder,
  slotsOverlap,
} from "@/utils/slotAllocation/slotTimeUtils";
import {
  resolveWeeklyTimezone,
  resolveWeeklyUtcOffsetMinutes,
  weeklyRowLocalColumns,
} from "@/lib/scheduling/weeklyUtcOffset";
import { notifyNewConsultantApplication } from "@/lib/novu";
import type { OnboardingData, ConsultantProfileCreateData } from "./onboarding";
import {
  buildUserUpdateData,
  buildConsultantScalarData,
  buildConsulteeScalarData,
  buildStaffScalarData,
  buildAdminScalarData,
  validateProfessionalBackground,
  shouldSubmitVerification,
  isPersistableVerificationDoc,
} from "./onboarding-shared";

// ============================================================================
// TYPES
// ============================================================================

/** Shape of a verification document as received from the onboarding form */
interface VerificationDocumentInput {
  id?: string;
  isOnboardingUpload?: boolean;
  fileName?: string;
  originalName?: string;
  fileSize?: number;
  mimeType?: string;
  fileUrl?: string;
  storagePath?: string;
  description?: string;
}

/** Verification-related fields extracted from the onboarding body */
interface VerificationBody {
  verificationLinkedinUrl?: string;
  verificationNotes?: string;
  verificationDocuments?: VerificationDocumentInput[];
}

// ============================================================================
// HELPERS
// ============================================================================

async function assertUserExists(id: string) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new Error("User not found");
}

// ============================================================================
// PROFILE UPSERT FUNCTIONS
// ============================================================================

async function upsertConsultantProfile(
  userId: string,
  profileData: ConsultantProfileCreateData,
  tx: Tx,
  timezone?: string,
) {
  const scalarData = buildConsultantScalarData(profileData);
  const domainId = profileData.domain.connect.id;

  // Validate domain/subdomain/tag consistency
  const tagIds = profileData.tags?.connect?.map((t) => t.id) ?? [];
  const subDomainIds =
    profileData.subDomains?.connect?.map((sd) => sd.id) ?? [];

  if (tagIds.length > 0) {
    const validTags = await tx.tag.count({
      where: { id: { in: tagIds }, domainId },
    });
    if (validTags !== tagIds.length) {
      throw new Error(
        "One or more selected skills do not belong to the chosen domain",
      );
    }
  }

  if (subDomainIds.length > 0) {
    const validSubDomains = await tx.subDomain.count({
      where: { id: { in: subDomainIds }, domainId },
    });
    if (validSubDomains !== subDomainIds.length) {
      throw new Error(
        "One or more selected sub-domains do not belong to the chosen domain",
      );
    }
  }

  const consultantProfile = await tx.consultantProfile.upsert({
    where: { userId },
    create: {
      userId,
      rating: 0,
      domainId,
      subDomains: profileData.subDomains?.connect
        ? { connect: profileData.subDomains.connect }
        : undefined,
      tags: profileData.tags?.connect
        ? { connect: profileData.tags.connect }
        : undefined,
      ...scalarData,
    },
    update: {
      domain: { connect: { id: domainId } },
      subDomains: profileData.subDomains?.connect
        ? { set: profileData.subDomains.connect }
        : { set: [] },
      tags: profileData.tags?.connect
        ? { set: profileData.tags.connect }
        : { set: [] },
      ...scalarData,
    },
  });

  await syncAvailabilitySlots(
    consultantProfile.id,
    scalarData.scheduleType,
    profileData,
    tx,
    timezone,
  );

  return { consultantProfileId: consultantProfile.id };
}

async function syncAvailabilitySlots(
  consultantProfileId: string,
  scheduleType: ScheduleType,
  profileData: ConsultantProfileCreateData,
  tx: Tx,
  timezone?: string,
) {
  // #1326 — this path stored 0 for a consultant with no onboarding timezone,
  // so their whole published week projected as if they lived in UTC. One
  // resolver now answers for every write path, and a conflicting caller value
  // throws into the failed transaction rather than being written.
  const utcOffsetMinutes = resolveWeeklyUtcOffsetMinutes({
    profileTimezone: timezone,
    consultantProfileId,
  });
  const rowTimezone = resolveWeeklyTimezone(timezone);
  if (scheduleType === ScheduleType.WEEKLY) {
    await tx.slotOfAvailabilityCustom.deleteMany({
      where: { consultantProfileId },
    });
    await tx.slotOfAvailabilityWeekly.deleteMany({
      where: { consultantProfileId },
    });

    const weeklySlotsToCreate = profileData.slotsOfAvailabilityWeekly?.create;
    if (weeklySlotsToCreate && weeklySlotsToCreate.length > 0) {
      // Reject invalid slots instead of silently filtering them
      for (let i = 0; i < weeklySlotsToCreate.length; i++) {
        const slot = weeklySlotsToCreate[i];
        const startHH = Math.floor(slot.startTimeUtc / 60)
          .toString()
          .padStart(2, "0");
        const startMM = (slot.startTimeUtc % 60).toString().padStart(2, "0");
        const endHH = Math.floor(slot.endTimeUtc / 60)
          .toString()
          .padStart(2, "0");
        const endMM = (slot.endTimeUtc % 60).toString().padStart(2, "0");
        if (!isValidTimeRange(`${startHH}:${startMM}`, `${endHH}:${endMM}`)) {
          throw new Error(`Weekly slot ${i + 1} has an invalid time range`);
        }
      }

      for (const slot of weeklySlotsToCreate) {
        const timeError = validateWeeklySlotTimeOrder(
          slot.startDay,
          slot.endDay,
          slot.startTimeUtc,
          slot.endTimeUtc,
        );
        if (timeError) throw new Error(timeError);
      }

      for (let i = 0; i < weeklySlotsToCreate.length; i++) {
        for (let j = i + 1; j < weeklySlotsToCreate.length; j++) {
          if (slotsOverlap(weeklySlotsToCreate[i], weeklySlotsToCreate[j])) {
            throw new Error(
              "Weekly availability slots contain overlapping time ranges",
            );
          }
        }
      }

      // #1320 — adjacent entries ("3:30–4:30" + "4:30–5:30") become one row so
      // storage matches the window the customer is shown and can book.
      //
      // #1326 — the offset is stamped BEFORE the merge: mergeAdjacentWeeklyRows
      // refuses to fold rows whose offsets differ, and every row here carried
      // an absent offset until after the fold, so that guard was comparing
      // undefined with undefined and could never fire.
      // #872 — the five DST columns are derived from the MERGED row, which is
      // the one actually stored. No reader consults them until the reader flip.
      const rowsWithOffset = weeklySlotsToCreate.map((slot) => ({
        ...slot,
        utcOffsetMinutes,
      }));
      await tx.slotOfAvailabilityWeekly.createMany({
        data: mergeAdjacentWeeklyRows(rowsWithOffset).map((slot) => ({
          startDay: slot.startDay,
          startTimeUtc: slot.startTimeUtc,
          endDay: slot.endDay,
          endTimeUtc: slot.endTimeUtc,
          consultantProfileId,
          utcOffsetMinutes,
          ...weeklyRowLocalColumns(slot, rowTimezone, utcOffsetMinutes),
        })),
      });
    }
  } else if (scheduleType === ScheduleType.CUSTOM) {
    await tx.slotOfAvailabilityWeekly.deleteMany({
      where: { consultantProfileId },
    });
    await tx.slotOfAvailabilityCustom.deleteMany({
      where: { consultantProfileId },
    });

    const customSlotsToCreate = profileData.slotsOfAvailabilityCustom?.create;
    if (customSlotsToCreate && customSlotsToCreate.length > 0) {
      // Validate using UTC timestamps directly (no server-locale dependency)
      for (let i = 0; i < customSlotsToCreate.length; i++) {
        const slot = customSlotsToCreate[i];
        const startMs = new Date(slot.startsAt).getTime();
        const endMs = new Date(slot.endsAt).getTime();
        if (startMs >= endMs) {
          throw new Error(
            `Custom slot ${i + 1}: start time must be before end time`,
          );
        }
        const durationMin = (endMs - startMs) / 60_000;
        if (durationMin < 30 || durationMin > 720) {
          throw new Error(
            `Custom slot ${i + 1}: duration must be between 30 minutes and 12 hours`,
          );
        }
      }

      for (let i = 0; i < customSlotsToCreate.length; i++) {
        for (let j = i + 1; j < customSlotsToCreate.length; j++) {
          const a = customSlotsToCreate[i];
          const b = customSlotsToCreate[j];
          if (
            new Date(a.startsAt).getTime() < new Date(b.endsAt).getTime() &&
            new Date(b.startsAt).getTime() < new Date(a.endsAt).getTime()
          ) {
            throw new Error(
              "Custom availability slots contain overlapping time ranges",
            );
          }
        }
      }

      // #1320 — merge AFTER the per-slot 12-hour cap above, so a chain of
      // adjacent entries still has each entry checked on its own.
      await tx.slotOfAvailabilityCustom.createMany({
        data: mergeAdjacentCustomRows(
          customSlotsToCreate.map((slot) => ({
            startsAt: new Date(slot.startsAt),
            endsAt: new Date(slot.endsAt),
            consultantProfileId,
          })),
        ),
      });
    }
  }
}

async function upsertConsulteeProfile(
  userId: string,
  profileData: Parameters<typeof buildConsulteeScalarData>[0],
  tx: Tx,
) {
  const scalarData = buildConsulteeScalarData(profileData);
  const profile = await tx.consulteeProfile.upsert({
    where: { userId },
    create: { userId, ...scalarData },
    update: scalarData,
  });
  return { consulteeProfileId: profile.id };
}

async function upsertStaffProfile(
  userId: string,
  profileData: Parameters<typeof buildStaffScalarData>[0],
  tx: Tx,
) {
  const scalarData = buildStaffScalarData(profileData);
  const profile = await tx.staffProfile.upsert({
    where: { userId },
    create: { userId, ...scalarData },
    update: scalarData,
  });
  return { staffProfileId: profile.id };
}

async function upsertAdminProfile(
  userId: string,
  profileData: Parameters<typeof buildAdminScalarData>[0],
  tx: Tx,
) {
  const scalarData = buildAdminScalarData(profileData);
  const profile = await tx.adminProfile.upsert({
    where: { userId },
    create: { userId, ...scalarData },
    update: scalarData,
  });
  return { adminProfileId: profile.id };
}

async function upsertProfileByRole(
  userId: string,
  validatedBody: OnboardingData,
  tx: Tx,
): Promise<{
  consultantProfileId?: string;
  consulteeProfileId?: string;
  staffProfileId?: string;
  adminProfileId?: string;
}> {
  switch (validatedBody.role) {
    case UserRole.CONSULTANT:
      return upsertConsultantProfile(
        userId,
        validatedBody.consultantProfile.create,
        tx,
        validatedBody.timezone,
      );
    case UserRole.CONSULTEE:
      return upsertConsulteeProfile(
        userId,
        validatedBody.consulteeProfile.create,
        tx,
      );
    case UserRole.STAFF:
      return upsertStaffProfile(userId, validatedBody.staffProfile.create, tx);
    case UserRole.ADMIN:
      if (validatedBody.adminProfile?.create) {
        return upsertAdminProfile(
          userId,
          validatedBody.adminProfile.create,
          tx,
        );
      }
      return {};
    case UserRole.ORG_WORKSPACE:
      // No personal profile — org creation happens post-transaction.
      return {};
    default: {
      const _exhaustiveCheck: never = validatedBody;
      throw new Error(
        `Invalid role: ${String((_exhaustiveCheck as { role: string }).role)}`,
      );
    }
  }
}

// ============================================================================
// PROFESSIONAL BACKGROUND PERSISTENCE (validated via Zod)
// ============================================================================

export async function persistProfessionalBackground(
  userId: string,
  consultantProfileId: string | undefined,
  body: Record<string, unknown>,
  tx: Tx,
) {
  const {
    workExperiences,
    educationHistory,
    certificationsList,
    achievements,
  } = validateProfessionalBackground(body);

  // For each section: null means "field absent from payload" (skip),
  // empty array means "user cleared all entries" (delete old rows).
  if (workExperiences !== null) {
    await tx.workExperience.deleteMany({ where: { userId } });
    if (workExperiences.length > 0) {
      await tx.workExperience.createMany({
        data: workExperiences.map((we) => ({
          userId,
          company: we.company,
          companyDomain: we.companyDomain || null,
          title: we.title,
          location: we.location || null,
          startDate: new Date(we.startDate),
          endDate: we.endDate ? new Date(we.endDate) : null,
          isCurrent: we.isCurrent ?? false,
          description: we.description || null,
        })),
      });
    }
  }

  if (educationHistory !== null) {
    await tx.education.deleteMany({ where: { userId } });
    if (educationHistory.length > 0) {
      await tx.education.createMany({
        data: educationHistory.map((edu) => ({
          userId,
          institution: edu.institution,
          institutionDomain: edu.institutionDomain || null,
          degree: edu.degree,
          fieldOfStudy: edu.fieldOfStudy || null,
          startYear: edu.startYear || null,
          endYear: edu.endYear || null,
          grade: edu.grade || null,
          activities: edu.activities || null,
          description: edu.description || null,
        })),
      });
    }
  }

  if (certificationsList !== null) {
    await tx.certification.deleteMany({ where: { userId } });
    if (certificationsList.length > 0) {
      await tx.certification.createMany({
        data: certificationsList.map((cert) => ({
          userId,
          name: cert.name,
          issuingOrganization: cert.issuingOrganization,
          issueDate: new Date(cert.issueDate),
          expiryDate: cert.expiryDate ? new Date(cert.expiryDate) : null,
          credentialId: cert.credentialId || null,
          credentialUrl: cert.credentialUrl || null,
        })),
      });
    }
  }

  if (consultantProfileId && achievements !== null) {
    await tx.achievement.deleteMany({
      where: { consultantProfileId },
    });
    if (achievements.length > 0) {
      await tx.achievement.createMany({
        data: achievements.map((ach) => ({
          consultantProfileId,
          title: ach.title,
          description: ach.description || null,
          url: ach.url || null,
          imageUrl: ach.imageUrl || null,
          achievementType: ach.achievementType || "OTHER",
        })),
      });
    }
  }
}

// ============================================================================
// VERIFICATION HANDLING
// ============================================================================

async function submitVerificationRequest(
  userId: string,
  consultantProfileId: string,
  body: VerificationBody,
  userName: string,
  userEmail: string,
) {
  const { verificationLinkedinUrl, verificationNotes, verificationDocuments } =
    body;

  // Enforce verification requirements server-side
  if (!verificationLinkedinUrl?.trim()) {
    throw new Error("LinkedIn URL is required for consultant verification");
  }
  if (!verificationDocuments || verificationDocuments.length === 0) {
    throw new Error("At least one verification document is required");
  }

  if (verificationLinkedinUrl) {
    await prisma.user.update({
      where: { id: userId },
      data: { linkedinUrl: verificationLinkedinUrl },
    });
  }

  // Auto-supersede any existing PENDING/NEEDS_INFO requests
  await prisma.consultantProfileVerification.updateMany({
    where: {
      consultantProfileId,
      status: { in: ["PENDING", "NEEDS_INFO"] },
    },
    data: { status: "SUPERSEDED" },
  });

  const verification = await prisma.consultantProfileVerification.create({
    data: {
      consultantProfileId,
      notes: verificationNotes || null,
      status: "PENDING",
    },
  });

  if (verificationDocuments && verificationDocuments.length > 0) {
    // Same predicate that gated the deferral decision in
    // maybeSubmitConsultantVerification — a doc that would not persist here
    // must never have started a review (review round 1).
    const persistableDocs = verificationDocuments.filter(
      isPersistableVerificationDoc,
    ) as VerificationDocumentInput[];

    const existingDocuments = persistableDocs.filter(
      (doc) => doc.id && !doc.isOnboardingUpload,
    );
    if (existingDocuments.length > 0) {
      await prisma.profileVerificationDocument.updateMany({
        where: {
          id: {
            in: existingDocuments.map((d) => d.id).filter(Boolean) as string[],
          },
        },
        data: { verificationId: verification.id },
      });
    }

    const onboardingDocuments = persistableDocs.filter(
      (doc) => doc.isOnboardingUpload || (!doc.id && doc.fileUrl),
    );
    if (onboardingDocuments.length > 0) {
      await prisma.profileVerificationDocument.createMany({
        data: onboardingDocuments.map((doc) => ({
          verificationId: verification.id,
          fileName: doc.fileName ?? "",
          originalName: doc.originalName ?? "",
          fileSize: doc.fileSize ?? 0,
          mimeType: doc.mimeType ?? "",
          fileUrl: doc.fileUrl ?? "",
          storagePath: doc.storagePath ?? "",
          description: doc.description || null,
        })),
      });
    }
  }

  await prisma.consultantProfile.update({
    where: { id: consultantProfileId },
    data: { verificationStatus: "UNDER_REVIEW", isVerified: false },
  });

  // Fire-and-forget: notify admins
  void (async () => {
    try {
      const admins = await prisma.user.findMany({
        where: { role: UserRole.ADMIN },
        select: { id: true },
      });
      if (admins.length > 0) {
        await notifyNewConsultantApplication(
          admins.map((a) => a.id),
          {
            applicantName: userName || "Unknown",
            applicantEmail: userEmail || "Unknown",
            dashboardUrl: "/dashboard/admin/users",
          },
        );
      }
    } catch (notifyError) {
      console.error(
        "[Novu] Failed to notify admins of new consultant application:",
        notifyError,
      );
    }
  })();
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

const onboardingUserInclude = {
  consultantProfile: {
    include: {
      slotsOfAvailabilityWeekly: true,
      slotsOfAvailabilityCustom: true,
      domain: true,
      subDomains: true,
      tags: true,
    },
  },
  consulteeProfile: true,
  workExperiences: true,
  education: true,
  certifications: true,
  staffProfile: true,
  adminProfile: true,
} satisfies Prisma.UserInclude;

type OnboardingUser = Prisma.UserGetPayload<{
  include: typeof onboardingUserInclude;
}>;

type OnboardingResult = {
  success: boolean;
  // `user` is a Prisma User with deeply-included relations (consultantProfile,
  // consulteeProfile, slots, domain, etc.). Typing it precisely would require a
  // shared Prisma payload type across server/action/client layers — not worth
  // the coupling. Callers only read a few string IDs from it.
  user?: Record<string, unknown>;
  error?: string;
  verificationWarning?: string;
  /// True when the consultant finished onboarding without completing the
  /// verification package (LinkedIn + ≥1 document). The profile exists with
  /// verificationStatus PENDING_VERIFICATION; the client uses this to show a
  /// "finish from Settings" message instead of "under review".
  verificationDeferred?: boolean;
};

async function runOnboardingTransaction(
  userId: string,
  validatedBody: OnboardingData,
  body: unknown,
): Promise<OnboardingUser> {
  return prisma.$transaction(
    async (tx) => {
      const baseUserData: Prisma.UserUpdateInput = {
        ...buildUserUpdateData(validatedBody),
        // Reset profile IDs (will be set by profileFkData)
        consultantProfileId: null,
        consulteeProfileId: null,
        staffProfileId: null,
        adminProfileId: null,
      };

      const profileFkData = await upsertProfileByRole(
        userId,
        validatedBody,
        tx,
      );

      await persistProfessionalBackground(
        userId,
        profileFkData.consultantProfileId,
        body as Record<string, unknown>,
        tx,
      );

      const user = await tx.user.update({
        // #724, #840: CAS guard — only apply the role/profile transition
        // while the user is still un-onboarded, so two devices onboarding
        // the same email can't last-write-wins each other. A no-match
        // throws P2025 and rolls back the whole tx (incl. profile upserts).
        where: { id: userId, onboardingCompleted: { not: true } },
        data: { ...baseUserData, ...profileFkData },
        include: onboardingUserInclude,
      });

      return user;
    },
    { maxWait: 15000, timeout: 45000 },
  );
}

// #724, #840: another device already completed onboarding for this user; treat
// as idempotent success rather than clobbering their transition. Returns the
// success result on a P2025-after-completion, or null to signal a rethrow.
async function recoverIdempotentOnboarding(
  userId: string,
  error: unknown,
): Promise<OnboardingResult | null> {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2025"
  ) {
    const existing = await prisma.user.findUnique({
      where: { id: userId },
      include: onboardingUserInclude,
    });
    if (existing?.onboardingCompleted) {
      return { success: true, user: existing };
    }
  }
  return null;
}

/**
 * Post-transaction consultant verification. Returns a warning string when the
 * profile saved but the verification submission failed; `deferred: true` when
 * the consultant finished without a complete verification package. The policy
 * itself lives in `shouldSubmitVerification` (onboarding-shared) so it stays
 * unit-testable outside this server-only module.
 */
async function maybeSubmitConsultantVerification(
  userId: string,
  updatedUser: OnboardingUser,
  body: unknown,
  role: OnboardingData["role"],
): Promise<{ warning?: string; deferred?: boolean } | undefined> {
  if (role !== UserRole.CONSULTANT || !updatedUser.consultantProfileId) {
    return undefined;
  }

  const verificationBody = body as VerificationBody;
  const { hasDocuments, hasLinkedin } =
    shouldSubmitVerification(verificationBody);

  // Deferred path (#onboarding-ux): the profile is real and saved with the
  // model default PENDING_VERIFICATION ("onboarding complete, awaiting
  // review"); marketplace visibility continues to gate on verification, so a
  // deferred consultant is simply unlisted until they finish from Settings.
  // Whatever LinkedIn they did enter still lands on the User row.
  if (!hasDocuments || !hasLinkedin) {
    if (hasLinkedin) {
      await prisma.user.update({
        where: { id: userId },
        data: {
          linkedinUrl: verificationBody.verificationLinkedinUrl!.trim(),
        },
      });
    }
    return { deferred: true };
  }

  try {
    await submitVerificationRequest(
      userId,
      updatedUser.consultantProfileId,
      verificationBody,
      updatedUser.name || "",
      updatedUser.email || "",
    );
    return undefined;
  } catch (verificationError) {
    console.error("Failed to create verification request:", verificationError);
    return {
      warning:
        "Your profile was saved but verification submission failed. Please contact support.",
    };
  }
}

export async function processOnboardingData(
  userId: string,
  body: unknown,
): Promise<OnboardingResult> {
  const { validateOnboardingData } = await import("./onboarding");

  try {
    const validationResult = validateOnboardingData(body);
    if (!validationResult.success) {
      console.error("Validation Error:", validationResult.error);
      return { success: false, error: validationResult.error };
    }

    const validatedBody = validationResult.data;

    // STAFF and ADMIN roles are invite-only — reject from public onboarding
    if (
      validatedBody.role === UserRole.STAFF ||
      validatedBody.role === UserRole.ADMIN
    ) {
      return {
        success: false,
        error:
          "Staff and Admin accounts are invite-only. Please contact an administrator.",
      };
    }

    await assertUserExists(userId);

    // ORG_WORKSPACE onboarding no longer flows through this transaction. The
    // role + personal info are committed by `setOnboardingRoleAction` at
    // step 0, the org is created via `POST /api/organizations` during the
    // shared wizard, and `completeOrgWorkspaceOnboardingAction` flips the
    // onboardingCompleted flag at launch. This path now only handles
    // CONSULTANT / CONSULTEE / STAFF / ADMIN profiles.

    let updatedUser: OnboardingUser;
    try {
      updatedUser = await runOnboardingTransaction(userId, validatedBody, body);
    } catch (error: unknown) {
      const recovered = await recoverIdempotentOnboarding(userId, error);
      if (recovered) return recovered;
      throw error;
    }

    const verification = await maybeSubmitConsultantVerification(
      userId,
      updatedUser,
      body,
      validatedBody.role,
    );

    return {
      success: true,
      user: updatedUser,
      verificationWarning: verification?.warning,
      verificationDeferred: verification?.deferred,
    };
  } catch (error: unknown) {
    console.error("Error in processOnboardingData:", error);
    const errorMessage =
      error instanceof Error
        ? error.message
        : "An unknown error occurred while updating onboarding information.";
    if (error instanceof Error) {
      console.error("Error details:", {
        message: error.message,
        stack: error.stack,
      });
    }
    return { success: false, error: errorMessage };
  }
}
