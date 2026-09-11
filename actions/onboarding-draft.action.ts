"use server";

import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import {
  prepareDraftForPersist,
  readStoredDraftPayload,
  type DraftActionResult,
  type LoadDraftActionResult,
  type OnboardingDraftSnapshot,
} from "@/utils/onboarding-draft";

/**
 * Resumable-onboarding drafts.
 *
 * Every action is keyed off the SESSION user id only — there is deliberately
 * no userId parameter to forge. The draft is a convenience cache, never an
 * authorization surface: guards read `User.onboardingCompleted`, and this row
 * is deleted on completion (and cascade-deleted with the user under DPDP
 * erasure).
 *
 * Multi-device semantics are last-write-wins per user, matching how the rest
 * of onboarding treats concurrent drafts; the terminal transition remains
 * protected by the #724/#840 CAS in `processOnboardingData`.
 */

function unauthorized(): { success: false; error: string } {
  return { success: false, error: "Unauthorized" };
}

export async function saveOnboardingDraftAction(
  input: unknown,
): Promise<DraftActionResult> {
  const session = await getSession(true);
  if (!session?.user?.id) return unauthorized();

  // Server-action arguments arrive as untyped JSON regardless of the static
  // signature. prepareDraftForPersist validates, sanitizes non-JSON values,
  // and byte-gates the result in one step — the persisted object is exactly
  // its return value, never the raw caller payload.
  const prepared = prepareDraftForPersist(input);
  if (prepared === null) {
    return { success: false, error: "Invalid or oversized draft payload" };
  }

  const data = {
    userId: session.user.id,
    role: prepared.role,
    currentStep: prepared.currentStep,
    payload: prepared.payload as Prisma.InputJsonValue,
  };

  await prisma.onboardingDraft.upsert({
    where: { userId: session.user.id },
    create: data,
    update: {
      role: data.role,
      currentStep: data.currentStep,
      payload: data.payload,
    },
  });

  return { success: true };
}

export async function loadOnboardingDraftAction(): Promise<LoadDraftActionResult> {
  // A REJECTION here is not equivalent to "no draft": the wizard arms its
  // autosave only once this call settles, so an escaping error (a pooler
  // blip on the very first read, a session lookup failure) left the flag
  // unset for the whole mount and silently disabled saving for the entire
  // run — the user finished onboarding with nothing persisted and no signal.
  // Resolve a failure into the ordinary "no draft" answer instead.
  try {
    const session = await getSession(true);
    if (!session?.user?.id) return unauthorized();

    const draft = await prisma.onboardingDraft.findUnique({
      where: { userId: session.user.id },
      select: { role: true, currentStep: true, payload: true },
    });

    if (!draft) return { success: true, draft: null };

    // A quarantined payload also invalidates the step: resuming at step 4 of a
    // form whose answers were just discarded drops the user into a blank
    // later step with no way to see what they are missing.
    const { payload, reason } = readStoredDraftPayload(draft.payload);
    const snapshot: OnboardingDraftSnapshot = {
      role: draft.role,
      currentStep: reason === null ? draft.currentStep : 0,
      payload,
      quarantined: reason !== null,
    };
    return { success: true, draft: snapshot };
  } catch (error) {
    // Losing a draft is recoverable (the user re-enters this step); losing
    // autosave for the session is not, so this degrades rather than throws.
    console.error("onboarding: draft load failed", error);
    return { success: false, error: "Draft unavailable" };
  }
}

/** Idempotent by design — called after successful completion and whenever the
 *  wizard restarts from step 0 with no meaningful state to keep. */
export async function clearOnboardingDraftAction(): Promise<DraftActionResult> {
  const session = await getSession(true);
  if (!session?.user?.id) return unauthorized();

  await prisma.onboardingDraft.deleteMany({
    where: { userId: session.user.id },
  });

  return { success: true };
}
