/**
 * Payload builders shared by the four offering-plan services.
 *
 * The four types are parallel by design; these builders keep them from being
 * parallel COPIES — every shared rule lives here once:
 *   - the rupee→paise conversion at the API edge (#780 money model),
 *   - the ADR-24 positioning fields,
 *   - the #1134 P1-6 recording opt-in.
 */

/** The form edits rupees; the DB stores paise (#780 money model). */
export const priceToPaise = (rupees: number | null | undefined): number =>
  Math.round((rupees ?? 0) * 100);

interface PositioningPlan {
  subtitle?: string | null;
  targetAudience?: string[];
  whatsIncluded?: string[];
  faqs?: { question: string; answer: string; order?: number }[];
}

/**
 * ADR 24 positioning content. The endpoints validate and persist these (see
 * the nested faqs create in crud-with-plan); the services historically never
 * sent them, so authoring through the planner produced a plan with no
 * subtitle, audience, inclusions or FAQ no matter what was typed.
 */
export const positioningPayload = (plan: PositioningPlan = {}) => ({
  subtitle: plan.subtitle ?? null,
  targetAudience: plan.targetAudience ?? [],
  whatsIncluded: plan.whatsIncluded ?? [],
  faqs: plan.faqs ?? [],
});

interface RecordingPlan {
  recordingEnabled?: boolean;
  recordingStoragePolicy?: string;
}

/**
 * #1134 P1-6 — recording is an explicit per-plan opt-in on all four types;
 * both columns persist on every create/update path.
 */
export const recordingPayload = (plan: RecordingPlan = {}) => ({
  recordingEnabled: plan.recordingEnabled ?? false,
  recordingStoragePolicy: plan.recordingStoragePolicy ?? "STREAM_ONLY",
});
