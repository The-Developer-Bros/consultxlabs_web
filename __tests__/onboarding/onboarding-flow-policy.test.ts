/**
 * @jest-environment node
 */

/**
 * Pins for the reduced consultee flow and the consultant verification
 * deferral policy (#onboarding-ux).
 *
 * The 2-screen consultee wizard submits with NO profile-enrichment fields —
 * these tests guarantee that minimal payload still passes the client form
 * schema, the server payload schema, and produces an empty-but-valid
 * ConsulteeProfile create (the dashboard Settings tab + lazy
 * ensureConsulteeProfile own enrichment afterwards).
 *
 * Pure modules only — no Prisma or server-only imports here.
 */

import {
  OnboardingFormDataSchema,
  transformOnboardingFormToServerData,
  validateOnboardingData,
} from "../../utils/onboarding";
import {
  isPersistableVerificationDoc,
  shouldSubmitVerification,
} from "../../utils/onboarding-shared";

const MINIMAL_CONSULTEE_FORM = {
  role: "CONSULTEE" as const,
  name: "Ada Lovelace",
  email: "ada@example.com",
  dateOfBirth: "1990-06-15", // DateOfBirthSchema accepts YYYY-MM-DD strings
  onlineStatus: false,
  onboardingCompleted: false,
};

describe("reduced 2-screen consultee flow", () => {
  it("accepts a form with only step-0 fields plus consent", () => {
    const parsed = OnboardingFormDataSchema.safeParse({
      ...MINIMAL_CONSULTEE_FORM,
      termsAccepted: true,
      privacyAccepted: true,
    });
    expect(parsed.success).toBe(true);
  });

  it("transforms the minimal form into a server-valid payload with an empty profile create", () => {
    const formData = OnboardingFormDataSchema.parse({
      ...MINIMAL_CONSULTEE_FORM,
      termsAccepted: true,
      privacyAccepted: true,
    });

    const payload = transformOnboardingFormToServerData(formData);
    const validated = validateOnboardingData(payload);

    expect(validated.success).toBe(true);
    if (!validated.success) throw new Error(validated.error);

    expect(validated.data.role).toBe("CONSULTEE");
    if (validated.data.role !== "CONSULTEE") throw new Error("unreachable");
    // All enrichment fields optional → empty create object is legal.
    expect(validated.data.consulteeProfile.create).toEqual({
      aboutMe: undefined,
      preferredLanguage: undefined,
      goals: undefined,
      careerStage: undefined,
      skillsToDevelop: [],
      budgetPreference: undefined,
    });
    // Consent timestamps are stamped from the booleans.
    expect(validated.data.termsAcceptedAt).toBeInstanceOf(Date);
    expect(validated.data.privacyAcceptedAt).toBeInstanceOf(Date);
  });

  it("still rejects a consultee form missing the age gate", () => {
    const parsed = OnboardingFormDataSchema.safeParse({
      ...MINIMAL_CONSULTEE_FORM,
      dateOfBirth: undefined,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("shouldSubmitVerification policy (#onboarding-ux)", () => {
  // Shapes submitVerificationRequest actually persists: an existing record
  // uploaded earlier via /api/verification/documents, or an onboarding upload
  // carrying its storage URL.
  const EXISTING_RECORD = { id: "doc_1", fileName: "degree.pdf" };
  const ONBOARDING_UPLOAD = {
    isOnboardingUpload: true,
    fileUrl: "https://storage.example.com/vd/doc_2.pdf",
  };

  it.each([
    ["an existing record", [EXISTING_RECORD]],
    ["an onboarding upload", [ONBOARDING_UPLOAD]],
    [
      "a persistable doc among junk entries",
      [{}, null, undefined, ONBOARDING_UPLOAD],
    ],
  ])("submits when BOTH signals are present: %s", (_label, documents) => {
    const full = shouldSubmitVerification({
      verificationLinkedinUrl: "https://linkedin.com/in/ada",
      verificationDocuments: documents,
    });
    expect(full).toEqual({ hasDocuments: true, hasLinkedin: true });
  });

  it.each([
    [{}, "nothing provided"],
    [
      { verificationLinkedinUrl: "https://linkedin.com/in/ada" },
      "linkedin without documents",
    ],
    [
      { verificationDocuments: [] },
      "empty document array",
    ],
    [
      {
        verificationLinkedinUrl: "https://linkedin.com/in/ada",
        verificationDocuments: [{}],
      },
      "empty object document (review-round-1 regression)",
    ],
    [
      {
        verificationLinkedinUrl: "https://linkedin.com/in/ada",
        verificationDocuments: [null, undefined, { fileName: "ghost.pdf" }],
      },
      "non-object / metadata-only entries",
    ],
    [
      {
        verificationLinkedinUrl: "   ",
        verificationDocuments: [{ id: "doc_1" }],
      },
      "whitespace-only linkedin",
    ],
  ])("defers when %s (%s)", (body, _case) => {
    const result = shouldSubmitVerification(body);
    expect(result.hasDocuments && result.hasLinkedin).toBe(false);
  });

  it("isPersistableVerificationDoc mirrors the server persistence branches", () => {
    expect(isPersistableVerificationDoc({})).toBe(false);
    expect(isPersistableVerificationDoc(null)).toBe(false);
    expect(isPersistableVerificationDoc("junk")).toBe(false);
    expect(isPersistableVerificationDoc({ id: "" })).toBe(false); // falsy id
    expect(isPersistableVerificationDoc(EXISTING_RECORD)).toBe(true);
    expect(isPersistableVerificationDoc(ONBOARDING_UPLOAD)).toBe(true);
    expect(
      isPersistableVerificationDoc({ id: "doc_3", fileUrl: "u" }),
    ).toBe(true); // id wins even with fileUrl present
  });
});
