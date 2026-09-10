# Onboarding System — Complete Reference

> **Audience:** Coding agents (Claude, Codex, Copilot), future interns, and any developer touching the onboarding flow.
>
> **Last updated:** 2026-08-23

---

## 0. Profile model roster (Arch-4)

The platform wires a user to one or more profile models. Each row has
a matching FK on `User` (all nullable, all `@unique`). Onboarding
touches `ConsultantProfile` / `ConsulteeProfile` / `StaffProfile` /
`AdminProfile`; `OrgWorkspaceProfile` is provisioned by the enterprise
layer.

| Profile | Purpose | FK on `User` | Created by |
|---------|---------|--------------|------------|
| `ConsultantProfile` | Platform expert — domains, availability, earnings. | `consultantProfileId` | `/form/onboarding` (CONSULTANT), or auto-provisioned (placeholder) on EXPERT invite accept. |
| `ConsulteeProfile` | Platform learner — goals, career stage, aboutMe. | `consulteeProfileId` | `/form/onboarding` (CONSULTEE), or **lazily** via `ensureConsulteeProfile(db, userId)` from checkout, slot request-for-approval, and LEARNER invite accept. |
| `StaffProfile` | Platform operator (support / moderation / ops). | `staffProfileId` | `/form/onboarding` (invite-only; server rejects public submission). |
| `AdminProfile` | Platform admin. | `adminProfileId` | `/form/onboarding` (invite-only). |
| `OrgWorkspaceProfile` | One row per user who operates an org. Mirrors `StaffProfile` / `AdminProfile` structure. Backs `/dashboard/org-workspace/:id/home`. | `orgWorkspaceProfileId` | `POST /api/organizations` (inside the create transaction) and by the `prisma/scripts/backfill-org-workspace-profiles.ts` one-shot for existing OWNERs. |

### Lazy ConsulteeProfile (Arch-4)

The BetterAuth signup hook in `lib/auth.ts`
(`databaseHooks.user.create.after`) **no longer force-creates a
`ConsulteeProfile`**. Instead, the helper
`lib/profiles/ensure-consultee-profile.ts::ensureConsulteeProfile(db,
userId)` upserts one on first consumer action. It is invoked from:

- `lib/payments/operations/checkout.ts` (checkout path +
  `revalidateInsideLock`)
- `app/api/slots/request-for-approval/route.ts`
- `app/api/organizations/invitations/accept/route.ts` (LEARNER branch)
- The existing `/form/onboarding` path continues to work because
  `utils/onboarding-server.ts::upsertConsulteeProfile` is
  idempotent — it upserts regardless of whether one already exists.

This means a fresh signup who never takes a consumer action will have
`consulteeProfileId = null` until one of the above triggers fires. UI
code should treat the FK as optional and use
`resolvePersonalDashboardHref` (`lib/labels/personal-dashboard.ts`) to
decide the "Personal Dashboard" target.

### OrgWorkspaceProfile on org creation

`POST /api/organizations` upserts an `OrgWorkspaceProfile` for the caller
inside the same transaction that creates the `Organization`,
`BillingAccount`, and OWNER `Membership`, and returns the
`orgWorkspaceProfileId` on the response body so the client can
immediately navigate to `/dashboard/org-workspace/:id/home`. See
`docs/enterprise/12-dashboard-pages.md` for the operator home route.

### Placeholder ConsultantProfile on EXPERT invite accept

When a user accepts an EXPERT invitation without a pre-existing
`ConsultantProfile`, `app/api/organizations/invitations/accept/route.ts`
upserts a placeholder with:

- `domain` → upserted `Domain "General"`
- `scheduleType = WEEKLY`
- `verificationStatus = PENDING_VERIFICATION`

The user fills in their real domain, schedule, and verification
materials afterwards through the consultant profile editor.
Marketplace visibility in `/explore/experts` still gates on platform
verification, not on membership existence.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Step-by-Step Flow per Role](#2-step-by-step-flow-per-role)
3. [Component Reference](#3-component-reference)
4. [Zod Schema Hierarchy](#4-zod-schema-hierarchy)
5. [Type System & Data Shapes](#5-type-system--data-shapes)
6. [Transform Pipeline](#6-transform-pipeline)
7. [Server Processing](#7-server-processing)
8. [Database Models](#8-database-models)
9. [Enums Reference](#9-enums-reference)
10. [Validation Rules](#10-validation-rules)
11. [Known Design Decisions](#11-known-design-decisions)
12. [File Map](#12-file-map)

---

## 1. Architecture Overview

The onboarding system is a **multi-step wizard** that collects role-specific data from new users, validates it with Zod schemas, transforms it into Prisma-shaped payloads, and persists it atomically in a single database transaction.

```
┌─────────────────────────────────────────────────────────────────────┐
│                     ARCHITECTURE LAYERS                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  LAYER 1 — UI Components (React, react-hook-form)                  │
│    page.tsx orchestrates steps; each step is a component            │
│    Progressive state: formData accumulates across steps             │
│                                                                     │
│  LAYER 2 — Form Schemas (Zod, per-step validation)                 │
│    PersonalInfoAndRoleFormSchema, ConsultantProfileFormSchema, etc. │
│    OnboardingFormDataSchema = discriminatedUnion("role", [...])     │
│                                                                     │
│  LAYER 3 — Transform (form shape → Prisma shape)                   │
│    transformOnboardingFormToServerData()                            │
│    Converts { domain: { id, name } } → { domain: { connect: {} }} │
│                                                                     │
│  LAYER 4 — Server Validation (Zod, strict)                         │
│    OnboardingDataSchema validates the Prisma-shaped payload        │
│                                                                     │
│  LAYER 5 — Server Processing (Prisma transaction)                  │
│    processOnboardingData() → upsertProfileByRole()                 │
│    + persistProfessionalBackground() + verification                │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Patterns

- **Progressive state accumulation**: Each step merges its data into a single `formData` object in the parent (`page.tsx`). Steps receive `initialData` for back-navigation.
- **Discriminated union on `role`**: Both the form schema (`OnboardingFormDataSchema`) and the server payload schema (`OnboardingDataSchema`) use `z.discriminatedUnion("role", [...])` to ensure role-specific fields aren't stripped.
- **Flat form ↔ nested server**: Forms use flat objects (`domain: { id, name }`). Server expects Prisma connect syntax (`domain: { connect: { id } }`). The transform layer converts between them.
- **Upsert-based idempotency**: All profile operations use `prisma.*.upsert()` — calling onboarding twice with the same data is safe.
- **Replace semantics for arrays**: Availability slots, work experiences, education, certifications, and achievements are deleted-then-recreated on each submission (not merged).

---

## 2. Step-by-Step Flow per Role

> **2026-08 (#onboarding-ux):** the wizard is resumable — every step
> transition autosaves a server-side draft row (`OnboardingDraft`, see §1b)
> that is hydrated on the next visit and cleared on completion. The consultee
> flow was reduced from 5 screens to 2; consultant verification inputs became
> optional at submission.

### Consultant (5 steps)

| Step | Component | What It Collects |
|------|-----------|-----------------|
| 0 | `PersonalInfoAndRoleForm` | Name, email, phone, role=CONSULTANT, gender, city, country, bio, linkedinUrl |
| 1 | `ConsultantProfessionalStep` | **Tab 1:** Domain, subDomains, tags, description, headline, experience, scheduleType. **Tab 2:** Work experiences, education, certifications, achievements |
| 2 | `ConsultantPreferredScheduleForm` | Weekly slots (day + UTC minutes) or custom slots (datetime range). Timezone-aware display |
| 3 | `ConsultantAgreementAndVerificationStep` | LinkedIn URL (optional at submit), verification documents (optional at submit), notes, terms + privacy checkboxes. Both are required to get LISTED; skipping defers verification to the dashboard (see decision #12) |
| 4 | `ConsultantReviewForm` | Read-only review of all data → Submit |

### Consultee (2 steps)

| Step | Component | What It Collects |
|------|-----------|-----------------|
| 0 | `PersonalInfoAndRoleForm` | Name, email, phone, role=CONSULTEE, gender, city, country, bio, linkedinUrl |
| 1 | `ConsulteeAgreementForm` | Terms + privacy checkboxes → Submit |

Profile enrichment (career stage, occupation/company, aboutMe, goals) is
**deferred**: every consultee profile field is optional in
`OnboardingDataSchema`, so the minimal submission upserts an empty profile.
Enrichment happens post-signup via the consultee dashboard Settings tab and
the lazy `ensureConsulteeProfile()` path (§0). The former
`ConsulteeProfileForm` / `ConsulteePreferencesForm` / `ConsulteeReviewForm`
steps were removed in #onboarding-ux.

### Staff (4 steps, invite-only)

| Step | Component | What It Collects |
|------|-----------|-----------------|
| 0 | `PersonalInfoAndRoleForm` | Name, email, phone, role=STAFF (greyed out in public UI), etc. |
| 1 | `StaffProfileForm` | Department, position |
| 2 | `StaffAgreementForm` | Terms + privacy checkboxes |
| 3 | `StaffReviewForm` | Read-only review → Submit |

### Admin (invite-only)

ADMIN is not self-selectable: the role picker does not offer it and
`setOnboardingRoleAction`'s allowlist rejects it. There are no admin step
forms registered (`ADMIN: [personalInfoStep]`).

---

## 3. Component Reference

All components live under `app/form/onboarding/`.

### 3.1 Orchestrator: `page.tsx`

```
State:
  step: number (0-4)
  formData: Partial<OnboardingFormData>  — cumulative across steps

Draft layer (resumable wizard, #onboarding-ux):
  On mount   → loadOnboardingDraftAction() hydrates step + formData once
               (draftReadyRef gates autosave until hydration resolves)
  Per step   → debounced (800ms) autosave through a serialized save queue,
               so later state always lands after earlier in-flight upserts
  Lifecycle  → every delete of the draft row (successful submission, Start
               over, org-wizard launch) first DRAINS the queue via
               quiesceDraftSaves(), then clears — an in-flight upsert can
               never recreate a deleted row

Handlers:
  handleNext(stepData)  → merge data, advance step
  handleBack()          → decrement step
  handleSubmit(data)    → validate, transform, submit to server action
  startOver()           → quiesce saves, clear draft row, restart at step 0;
                          autosave stays armed afterwards

Layout:
  Header with step counter + sign-out
  Resume banner when a saved draft was restored (with Start over)
  Progress stepper (circles + connector lines)
  Form card (renders current step)
  Help text footer
```

### 3.2 Step 0: `PersonalInfoAndRoleForm`

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `name` | text | Yes | min 1 char |
| `email` | email | Yes | Pre-filled from session, disabled |
| `phone` | tel | No | — |
| `gender` | select | No | Gender enum |
| `city` | text | No | — |
| `country` | text | No | — |
| `address` | text | No | — |
| `bio` | textarea | No | max 160 chars |
| `linkedinUrl` | url | No | URL format or empty |
| `role` | radio buttons | Yes | CONSULTANT, CONSULTEE, STAFF (greyed out) |

### 3.3 Step 1 Consultant: `ConsultantProfessionalStep`

Two-tab layout:

**Tab 1 — Expertise & Domain** (via `ConsultantProfileForm`):

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `description` | textarea | Yes | min 1 char |
| `headline` | text | No | max 120 chars |
| `experience` | number | No | 0–100 years, step 0.5 |
| `domain` | select | Yes | Fetched from `/api/user/consultants/meta` |
| `subDomains` | multi-checkbox | No | Filtered by selected domain |
| `tags` | multi-checkbox | No | Filtered by selected domain |
| `scheduleType` | radio | Yes | WEEKLY or CUSTOM |

**Tab 2 — Experience & Credentials** (4 card sections):

Each section uses a list + modal pattern (Add/Edit/Delete):

- **WorkExperienceSection**: company, companyDomain, title, location, startDate, endDate, isCurrent, description
- **EducationSection**: institution, degree, fieldOfStudy, startYear, endYear, grade, activities, description
- **CertificationsSection**: name, issuingOrganization, issueDate, expiryDate, credentialId, credentialUrl
- **AchievementsSection**: title, achievementType (AchievementType enum), description, url

### 3.4 Step 2 Consultant: `ConsultantPreferredScheduleForm`

**WEEKLY mode:**
- Day-by-day grid (7 days)
- Time inputs per day (start/end, 15-minute steps)
- Timezone display and conversion
- Overlap validation between slots

**CUSTOM mode:**
- Calendar month view (click to select dates)
- Time inputs per selected date
- Date range validation

**Slot schemas:**
```
WeeklySlot: { startDay, endDay, startTimeUtc (0-1439 min), endTimeUtc (0-1439 min) }
CustomSlot: { startsAt (ISO string), endsAt (ISO string) }
```

### 3.5 Step 3 Consultant: `ConsultantAgreementAndVerificationStep`

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `verificationLinkedinUrl` | url | Optional at submit | Regex: `/^https?:\/\/(www\.)?linkedin\.com\/in\/[\w-]+\/?$/i` |
| `verificationDocuments` | file upload | Optional at submit | Max 5 files, 10MB each. Types: PDF, PNG, JPG, JPEG, WEBP |
| `verificationNotes` | textarea | No | max 500 chars |
| `termsAccepted` | checkbox | Yes | — |
| `privacyAccepted` | checkbox | Yes | — |

Both verification inputs are labeled "(needed to get listed)": providing
LinkedIn + ≥1 uploaded document submits the verification immediately;
skipping defers to the dashboard (decision #12). Only documents that actually
persisted (uploaded records or uploads with a storage URL) count toward the
package — see `isPersistableVerificationDoc()` in onboarding-shared.ts.

Uses `VerificationDocumentUpload` component (drag & drop, progress, status badges).
- Upload endpoint: `POST /api/verification/documents`
- Remove endpoint: `DELETE /api/verification/documents?id={docId}`

### 3.6 Consultee Profile/Preferences Steps — REMOVED

`ConsulteeProfileForm` and `ConsulteePreferencesForm` were removed in
#onboarding-ux: the consultee flow is now 2 screens (§2), and enrichment
(occupation, career stage, industry, aboutMe, goals) moved to the consultee
dashboard's Settings tab plus the lazy `ensureConsulteeProfile()` path (§0).

### 3.8 Agreement Forms

Both `ConsulteeAgreementForm` and `StaffAgreementForm` collect:
- `termsAccepted` (checkbox, required)
- `privacyAccepted` (checkbox, required)

### 3.9 Review Forms

All review forms (`ConsultantReviewForm`, `StaffReviewForm`) are read-only displays of accumulated `formData`. The consultant review includes sections for professional background, schedule, and verification. The review step calls `onSubmit(formData)` which triggers the full submission pipeline. (The consultee flow has no review step since #onboarding-ux — its final screen submits directly.)

---

## 4. Zod Schema Hierarchy

The system uses **4 schema layers**, all defined primarily in `utils/onboarding.ts`:

```
Layer 1: Base Schemas (schemas/user.ts)
  Single source of truth for profile model shapes
  ├── ConsultantProfileSchema
  ├── ConsulteeProfileSchema
  ├── StaffProfileSchema
  ├── AdminProfileSchema
  ├── WeeklySlotSchema
  ├── CustomSlotSchema
  ├── WorkExperienceSchema
  ├── EducationSchema
  └── CertificationSchema

Layer 2: Server Schemas (utils/onboarding.ts)
  Prisma-shaped, with connect/set syntax
  ├── BaseConsultantProfileCreateInputSchema  (scalars + prismaRelations)
  ├── BaseConsulteeProfileCreateInputSchema   (ConsulteeProfile.omit({ educationHistory }))
  ├── BaseStaffProfileCreateInputSchema       (StaffProfileSchema)
  ├── BaseAdminProfileCreateInputSchema       (AdminProfile + accessScope: z.any())
  ├── *ProfileCreateObjectSchema              ({ create: Base...Schema })
  └── OnboardingDataSchema                    (discriminatedUnion on role)

Layer 3: Frontend Schemas (utils/onboarding.ts)
  Flat structure with plain object references
  ├── FrontendConsultantProfileSchema  (domain: { id, name })
  ├── FrontendConsulteeProfileSchema
  ├── FrontendStaffProfileSchema
  ├── FrontendAdminProfileSchema
  └── FrontendOnboardingBaseSchema

Layer 4: Form Schemas (utils/onboarding.ts)
  React-hook-form compatible, progressive fill
  ├── PersonalInfoAndRoleFormSchema
  ├── ConsultantProfileFormSchema       (stricter: description required)
  ├── ConsulteeProfileFormSchema        (stricter: occupation, aboutMe required)
  ├── StaffProfileFormSchema            (stricter: department, position required)
  ├── PreferredScheduleFormSchema
  ├── consultantFormFields              (role-specific, domain optional in step-state)
  ├── consulteeFormFields
  ├── staffFormFields
  ├── adminFormFields
  └── OnboardingFormDataSchema          (discriminatedUnion on role)
```

### AchievementCreateInputSchema

Defined in `utils/onboarding.ts`, used by both the form modal and server persistence:

```typescript
{
  id?: string
  title: string          // required, min 1
  description?: string
  url?: string           // URL or ""
  imageUrl?: string      // URL or "" (no UI input — DB field only)
  achievementType: AchievementType  // default: OTHER
}
```

### OnboardingDataSchema (Server Payload)

Discriminated union on `role`. Each branch extends `OnboardingBaseSchema`:

```
OnboardingBaseSchema:
  name: string (required)
  email: string (email)
  phone?: string
  address?: string
  timezone?: string
  onlineStatus?: boolean (default: false)
  onboardingCompleted?: boolean (default: false)
  dateOfBirth?: Date | null
  gender?: Gender | null
  city?, country?: string
  linkedinUrl?: string (URL or "")
  bio?: string (max 160)
  verificationLinkedinUrl?, verificationNotes?: string
  verificationDocuments?: any[]

CONSULTANT branch:
  role: literal("CONSULTANT")
  consultantProfile: { create: BaseConsultantProfileCreateInputSchema }

CONSULTEE branch:
  role: literal("CONSULTEE")
  consulteeProfile: { create: BaseConsulteeProfileCreateInputSchema }

STAFF branch:
  role: literal("STAFF")
  staffProfile: { create: BaseStaffProfileCreateInputSchema }

ADMIN branch:
  role: literal("ADMIN")
  adminProfile?: { create: BaseAdminProfileCreateInputSchema }
```

### OnboardingFormDataSchema (Client Form)

Also a discriminated union, but with relaxed field requirements for progressive fill:

```
consultantFormFields:
  ...sharedFormFields (name, email, role, timezone, terms, etc.)
  ...consultantScalarFields (description, experience, headline, etc.)
  domain?: { id, name }           // optional during fill, required at submission
  subDomains?, tags?              // optional
  weeklySlots?, customSlots?      // optional
  verificationLinkedinUrl?, verificationNotes?, verificationDocuments?
  workExperiences?, educationHistory?, certificationsList?, achievements?

consulteeFormFields:
  ...sharedFormFields
  ...ConsulteeProfileSchema.omit({ educationHistory }).shape

staffFormFields:
  ...sharedFormFields
  ...StaffProfileSchema.shape
  permissions?: Record<string, boolean>
  responsibilities?: Record<string, boolean>

adminFormFields:
  ...sharedFormFields
  adminLevel?, accessScope?, assignedRegions?, adminNotes?
```

### OnboardingFormData Type

The flat intersection type used by `page.tsx` for cumulative form state:

```typescript
type OnboardingFormData =
  Omit<consultantFormFields, "role">        // all consultant fields
  & Partial<Omit<consulteeFormFields, "role">>  // optional consultee fields
  & Partial<Omit<staffFormFields, "role">>      // optional staff fields
  & Partial<Omit<adminFormFields, "role">>      // optional admin fields
  & { role: UserRole }
```

This is an intersection, not a union — it has ALL possible fields. The discriminated union is only used for validation.

---

## 5. Type System & Data Shapes

### Frontend Shape (form state)

```typescript
{
  // User-level
  name: "Jane Doe",
  email: "jane@example.com",
  role: "CONSULTANT",
  timezone: "Asia/Kolkata",

  // Consultant profile (flat)
  description: "Full-stack engineer with 10 years...",
  headline: "Senior Developer & Mentor",
  experience: 10,
  scheduleType: "WEEKLY",
  domain: { id: "abc123", name: "Technology" },
  subDomains: [{ id: "sub1", name: "Web Development", domainId: "abc123" }],
  tags: [{ id: "tag1", name: "React", domainId: "abc123" }],
  weeklySlots: [{ startDay: "MONDAY", endDay: "MONDAY", startTimeUtc: 540, endTimeUtc: 1020 }],

  // Professional background
  workExperiences: [{ company: "Google", title: "SWE", startDate: "2020-01-01", isCurrent: true }],
  achievements: [{ title: "Speaker at React Summit", achievementType: "TALK" }],

  // Verification
  verificationLinkedinUrl: "https://linkedin.com/in/janedoe",
  verificationDocuments: [{ fileName: "cert.pdf", status: "uploaded", ... }],
  termsAccepted: true,
  privacyAccepted: true,
}
```

### Server Shape (Prisma-ready)

```typescript
{
  // User-level
  name: "Jane Doe",
  email: "jane@example.com",
  role: "CONSULTANT",
  timezone: "Asia/Kolkata",
  onboardingCompleted: true,

  // Consultant profile (nested create)
  consultantProfile: {
    create: {
      description: "Full-stack engineer...",
      headline: "Senior Developer & Mentor",
      experience: 10,
      scheduleType: "WEEKLY",
      domain: { connect: { id: "abc123" } },
      subDomains: { connect: [{ id: "sub1" }] },
      tags: { connect: [{ id: "tag1" }] },
      slotsOfAvailabilityWeekly: {
        create: [{ startDay: "MONDAY", endDay: "MONDAY", startTimeUtc: 540, endTimeUtc: 1020 }]
      },
      languages: [],
      toolsAndTechnologies: [],
      sessionTypes: [],
    }
  },
  consulteeProfile: undefined,
  staffProfile: undefined,
}
```

---

## 6. Transform Pipeline

### Form → Server: `transformOnboardingFormToServerData(formData)`

```
1. pickUserFields(formData)
   → extracts: name, email, phone, address, timezone, role, gender, etc.
   → forces: onboardingCompleted = true
   → defaults: timezone = browser timezone if not set

2. Switch on formData.role:

   CONSULTANT:
     buildConsultantServerProfile(formData)
       → domain: { id, name } → { connect: { id } }
       → subDomains: [{ id }] → { connect: [{ id }] }
       → tags: [{ id }] → { connect: [{ id }] }
       → weeklySlots: [...] → slotsOfAvailabilityWeekly: { create: [...] }
       → customSlots: [...] → slotsOfAvailabilityCustom: { create: [...] }
       → Throws if domain.id missing

   CONSULTEE:
     Direct field mapping (occupation, aboutMe, goals, etc.)

   STAFF:
     Direct field mapping (department, position, permissions, etc.)

   ADMIN:
     Only creates adminProfile if adminLevel is set
```

### Server builders: `utils/onboarding-shared.ts`

| Function | Input | Output |
|----------|-------|--------|
| `buildUserUpdateData(data)` | OnboardingData | Prisma User update fields |
| `buildConsultantScalarData(data)` | ConsultantProfileCreateData | Non-relational consultant fields |
| `buildConsulteeScalarData(data)` | ConsulteeProfileCreateData | Consultee scalar fields |
| `buildStaffScalarData(data)` | StaffProfileCreateData | Staff scalar fields |
| `buildAdminScalarData(data)` | AdminProfileCreateData | Admin scalar fields |
| `validateProfessionalBackground(body)` | Raw body | `{ workExperiences, educationHistory, certificationsList, achievements }` (each is validated array or null) |

---

## 7. Server Processing

### Entry Points

1. **Server Action** (`actions/forms/onboarding.action.ts`):
   `updateOnboardingInformationAction(userId, body)` → called from `page.tsx`
2. **API Route** (`app/api/form/onboarding/[id]/route.ts`):
   `PATCH /api/form/onboarding/[id]` → called from external clients

Both authenticate via `getSession()`, check authorization (self or ADMIN/STAFF), then delegate to `processOnboardingData()`.

### `processOnboardingData(userId, body)` — Main Pipeline

```
Step 1: VALIDATE
  └─ validateOnboardingData(body) via OnboardingDataSchema
     └─ Returns formatted error messages with field paths

Step 2: ROLE GATE
  └─ Reject STAFF/ADMIN roles ("invite-only")

Step 3: ASSERT USER EXISTS
  └─ Throws "User not found" if missing

Step 4: TRANSACTION (maxWait: 10s, timeout: 30s)
  ├─ Build User update data
  ├─ Reset all profile IDs to null (re-linked by upsert)
  ├─ upsertProfileByRole() → creates/updates role-specific profile
  │   ├─ CONSULTANT: upsertConsultantProfile(userId, data, tx, timezone)
  │   │   ├─ consultantProfile.upsert (with domain connect, subDomains, tags)
  │   │   └─ syncAvailabilitySlots (delete old + validate + create new)
  │   ├─ CONSULTEE: upsertConsulteeProfile(userId, data, tx)
  │   ├─ STAFF: upsertStaffProfile(userId, data, tx)
  │   └─ ADMIN: upsertAdminProfile(userId, data, tx)
  ├─ persistProfessionalBackground(userId, consultantProfileId, body, tx)
  │   ├─ workExperiences: null=skip, []=delete all, [items]=replace
  │   ├─ educationHistory: same semantics
  │   ├─ certificationsList: same semantics
  │   └─ achievements: same semantics (consultant-only, keyed by consultantProfileId)
  └─ User.update with profile IDs + full include

Step 5: POST-TRANSACTION (consultant only)
  └─ shouldSubmitVerification(body) — LinkedIn + ≥1 persistable document?
      ├─ YES → submitVerificationRequest(userId, consultantProfileId, body, name, email)
      │     ├─ Update User.linkedinUrl
      │     ├─ Create ConsultantProfileVerification (status: PENDING)
      │     ├─ Create/link ProfileVerificationDocument records
      │     ├─ Update ConsultantProfile.verificationStatus → UNDER_REVIEW
      │     └─ Notify admins via Novu (fire-and-forget)
      │         └─ On failure: returns verificationWarning (profile still saved)
      └─ NO → deferred path (#onboarding-ux, decision #12)
            ├─ Save whatever LinkedIn was entered onto User.linkedinUrl
            ├─ Profile keeps model default PENDING_VERIFICATION
            │  (unlisted until verified; no verification rows, no document
            │   links, never UNDER_REVIEW)
            └─ Response carries verificationDeferred: true — the consultant
               finishes from Settings → Verification (/api/verification/submit)

Step 6: RETURN
  └─ { success: true, user, verificationWarning?, verificationDeferred? }
```

> "Persistable document" = an existing record uploaded earlier via
> `/api/verification/documents`, or an onboarding upload carrying its storage
> URL (`isPersistableVerificationDoc`). The same predicate gates both the
> deferral decision and what `submitVerificationRequest` persists.

### Availability Slot Sync

`syncAvailabilitySlots(consultantProfileId, scheduleType, profileData, tx, timezone?)`

**WEEKLY mode:**
1. Delete all custom AND weekly slots for this consultant
2. Filter slots through `isValidTimeRange()` (30min–12h duration)
3. Validate time order: `validateWeeklySlotTimeOrder(startDay, endDay, startTimeUtc, endTimeUtc)`
   - Same-day: `startTimeUtc < endTimeUtc`
   - Overnight: allowed only if `startDay !== endDay` and `startTimeUtc > endTimeUtc`
4. O(n^2) pairwise overlap detection via `slotsOverlap()`
5. Create slots with `utcOffsetMinutes` computed from consultant's timezone

**CUSTOM mode:**
1. Delete all weekly AND custom slots
2. Filter through `isValidTimeRange()`
3. Validate: `startsAt < endsAt` for each slot
4. Pairwise overlap check
5. Create with absolute DateTime

**Time storage:** Weekly slots use `Int SmallInt` (0–1439 = minutes since midnight UTC). Custom slots use `DateTime` (Timestamptz).

### Professional Background Persistence

`persistProfessionalBackground(userId, consultantProfileId, body, tx)`

Uses `validateProfessionalBackground(body)` from `onboarding-shared.ts`:

```
For each section (workExperiences, educationHistory, certificationsList, achievements):
  1. If body.field is not an array → return null (field absent from payload)
  2. Parse with z.array(Schema).safeParse()
  3. If parse fails → return null (invalid data, skip silently)
  4. If parse succeeds → return validated array (may be empty)

Then in persistence:
  null   → skip (don't touch DB)
  []     → delete all existing records
  [...]  → delete all, then create new
```

### Verification Flow

Runs **after** the main transaction commits. If verification fails, the user profile is still saved.

```
1. Update User.linkedinUrl (if provided)
2. Create ConsultantProfileVerification (status: "PENDING")
3. Handle documents:
   - Existing docs (have id, not onboarding upload): update verificationId
   - New docs (isOnboardingUpload or no id): create ProfileVerificationDocument
4. Update ConsultantProfile:
   - verificationStatus → "UNDER_REVIEW"
   - isVerified → false
5. Fire-and-forget: notify all ADMIN users via Novu
```

---

## 8. Database Models

### Models Modified During Onboarding

| Model | Scope | Operation |
|-------|-------|-----------|
| `User` | All roles | Update (name, email, role, timezone, profile IDs, etc.) |
| `ConsultantProfile` | Consultant | Upsert (domain, scalars, rating=0) |
| `ConsulteeProfile` | Consultee | Upsert (occupation, aboutMe, goals, etc.) |
| `StaffProfile` | Staff | Upsert (department, position, permissions, etc.) |
| `AdminProfile` | Admin | Upsert (adminLevel, accessScope, etc.) |
| `SlotOfAvailabilityWeekly` | Consultant | Delete all + create new |
| `SlotOfAvailabilityCustom` | Consultant | Delete all + create new |
| `WorkExperience` | All roles | Delete all + create new (keyed by userId) |
| `Education` | All roles | Delete all + create new (keyed by userId) |
| `Certification` | All roles | Delete all + create new (keyed by userId) |
| `Achievement` | Consultant | Delete all + create new (keyed by consultantProfileId) |
| `ConsultantProfileVerification` | Consultant (post-tx) | Create |
| `ProfileVerificationDocument` | Consultant (post-tx) | Create/update |

### Key Model Fields

#### User
```
id             String    @id @default(cuid())
name           String
email          String    @unique
role           UserRole? @default(CONSULTEE)
onboardingCompleted  Boolean?  @default(false)
timezone       String?
dateOfBirth    DateTime?
gender         Gender?
city, country  String?
linkedinUrl    String?
bio            String?   @db.VarChar(160)
consultantProfileId  String?  @unique
consulteeProfileId   String?  @unique
staffProfileId       String?  @unique
adminProfileId       String?  @unique
orgWorkspaceProfileId    String?  @unique    // one row per user who operates an org
```

#### ConsultantProfile
```
id                  String    @id @default(uuid())
description         String?   @db.Text
experience          Float?
rating              Float     @default(0)
headline            String?   @db.VarChar(120)
websiteUrl          String?
twitterUrl          String?
githubUrl           String?
videoIntroUrl       String?
languages           String[]  @default([])
toolsAndTechnologies String[] @default([])
mentoringStyle      String?   @db.Text
sessionTypes        SessionType[]  @default([])
scheduleType        ScheduleType
domainId            String    (FK → Domain)
userId              String    @unique (FK → User)
isVerified          Boolean   @default(false)
verificationStatus  ConsultantVerificationStatus  @default(PENDING_VERIFICATION)
profileCompletionPercentage  Int  @default(0)
totalMenteesHelped  Int  @default(0)
```

#### ConsulteeProfile
```
id                String    @id @default(uuid())
occupation        String?
aboutMe           String?   @db.Text
preferredLanguage String?
goals             String?   @db.Text
careerStage       CareerStage?
currentCompany    String?
industry          String?
skillsToDevelop   String[]  @default([])
budgetPreference  BudgetPreference?
userId            String    @unique
```

#### StaffProfile
```
id               String    @id @default(uuid())
department       String?
position         String?
permissions      Json?
responsibilities Json?
employeeId       String?
hireDate         DateTime?
reportsTo        String?
skills           String[]  @default([])
workSchedule     String?
userId           String    @unique
```

#### AdminProfile
```
id              String     @id @default(uuid())
adminLevel      AdminLevel
accessScope     Json?
assignedRegions String[]   @default([])
notes           String?    @db.Text
userId          String     @unique
```

#### SlotOfAvailabilityWeekly
```
id                    String     @id @default(uuid())
startDay              DayOfWeek
startTimeUtc          Int        @db.SmallInt    // 0-1439 (minutes since midnight UTC)
endDay                DayOfWeek
endTimeUtc            Int        @db.SmallInt    // 0-1439
utcOffsetMinutes      Int        @default(0) @db.SmallInt  // e.g. 330 for IST, -300 for EST
consultantProfileId   String     (FK)
```

#### SlotOfAvailabilityCustom
```
id                    String     @id @default(uuid())
startsAt              DateTime   @db.Timestamptz
endsAt                DateTime   @db.Timestamptz
consultantProfileId   String     (FK)
```

#### WorkExperience
```
id            String    @id @default(uuid())
company       String
companyDomain String?                       // for Logo.dev auto-detection
title         String
location      String?
startDate     DateTime
endDate       DateTime?
isCurrent     Boolean   @default(false)
description   String?   @db.Text
userId        String    (FK)
```

#### Education
```
id            String    @id @default(uuid())
institution   String
degree        String
fieldOfStudy  String?
startYear     Int?
endYear       Int?
grade         String?
activities    String?
description   String?   @db.Text
userId        String    (FK)
```

#### Certification
```
id                   String    @id @default(uuid())
name                 String
issuingOrganization  String
issueDate            DateTime
expiryDate           DateTime?
credentialId         String?
credentialUrl        String?
userId               String    (FK)
```

#### Achievement
```
id                    String          @id @default(uuid())
title                 String
description           String?         @db.Text
url                   String?
imageUrl              String?
achievementType       AchievementType @default(OTHER)
consultantProfileId   String          (FK)
```

#### Domain / SubDomain / Tag
```
Domain:    { id, name (unique) }    → has many SubDomains, Tags, ConsultantProfiles
SubDomain: { id, name, domainId }   → unique(name, domainId), M2M with ConsultantProfile
Tag:       { id, name, domainId }   → unique(name, domainId), M2M with ConsultantProfile
```

#### ConsultantProfileVerification
```
id                    String    @id @default(uuid())
status                ProfileVerificationStatus  @default(PENDING)
consultantProfileId   String    (FK)
submittedAt           DateTime  @default(now())
notes                 String?   @db.Text     // applicant notes
reviewedAt            DateTime?
reviewedById          String?                // staff reviewer
reviewNotes           String?   @db.Text     // internal (not shown to consultant)
rejectionReason       String?   @db.Text
feedbackDetails       String?   @db.Text
documents             ProfileVerificationDocument[]
```

#### ProfileVerificationDocument
```
id               String    @id @default(uuid())
fileName         String
originalName     String
fileSize         Int
mimeType         String
fileUrl          String
storagePath      String
description      String?
isValid          Boolean?                // null=not reviewed, true/false
staffFeedback    String?
verificationId   String    (FK)
uploadedAt       DateTime  @default(now())
```

---

## 9. Enums Reference

| Enum | Values |
|------|--------|
| `UserRole` | `CONSULTANT`, `CONSULTEE`, `ADMIN`, `STAFF` |
| `ScheduleType` | `WEEKLY`, `CUSTOM` |
| `DayOfWeek` | `MONDAY`, `TUESDAY`, `WEDNESDAY`, `THURSDAY`, `FRIDAY`, `SATURDAY`, `SUNDAY` |
| `Gender` | `MALE`, `FEMALE`, `NON_BINARY`, `PREFER_NOT_TO_SAY` |
| `CareerStage` | `STUDENT`, `EARLY_CAREER`, `MID_CAREER`, `SENIOR`, `EXECUTIVE` |
| `BudgetPreference` | `BUDGET`, `MODERATE`, `PREMIUM`, `FLEXIBLE` |
| `SessionType` | `ONE_ON_ONE`, `GROUP`, `ASYNC_REVIEW` |
| `AdminLevel` | `SUPER_ADMIN`, `ADMIN`, `MODERATOR` |
| `AchievementType` | `AWARD`, `PUBLICATION`, `PROJECT`, `TALK`, `OPEN_SOURCE`, `OTHER` |
| `ConsultantVerificationStatus` | `PENDING_VERIFICATION`, `UNDER_REVIEW`, `VERIFIED`, `REJECTED` |
| `ProfileVerificationStatus` | `PENDING`, `APPROVED`, `REJECTED`, `NEEDS_INFO` |

---

## 10. Validation Rules

### User-Level
| Field | Rule |
|-------|------|
| `name` | Required, min 1 char |
| `email` | Required, valid email format |
| `bio` | Max 160 chars |
| `linkedinUrl` | Valid URL or empty string |
| `dateOfBirth` | Coerced to Date, optional |

### Consultant-Level
| Field | Rule |
|-------|------|
| `domain.id` | **Required** at submission (optional during progressive fill) |
| `description` | Required at submission (optional in form step) |
| `experience` | 0–100 years |
| `headline` | Max 120 chars |
| `verificationLinkedinUrl` | Must match LinkedIn URL regex |
| `verificationDocuments` | Min 1 uploaded file |
| `verificationNotes` | Max 500 chars |

### Slot Validation (server-side)
| Rule | Description |
|------|-------------|
| Duration | 30 minutes minimum, 12 hours maximum |
| Time order | Same-day: start < end. Overnight: start > end with next-day end |
| No overlaps | O(n^2) pairwise check. Back-to-back allowed (end1 === start2) |
| Time range | 0–1439 minutes (weekly), valid DateTime (custom) |

### Professional Background
| Field | Rule |
|-------|------|
| `company`, `title` | Required, min 1 char |
| `institution`, `degree` | Required, min 1 char |
| `name`, `issuingOrganization` | Required, min 1 char |
| `startDate`, `issueDate` | Required, coerced to Date |
| `startYear`, `endYear` | 1900–2100 (optional) |
| `credentialUrl` | Valid URL (optional) |
| `achievementType` | AchievementType enum, defaults to OTHER |

---

## 11. Known Design Decisions

1. **Domain is conditionally required.** In `consultantFormFields`, `domain` is optional (progressive form fill). But `buildConsultantServerProfile()` throws if `domain.id` is missing. This is by design — the form fills progressively, and validation at submission catches the missing field.

2. **STAFF/ADMIN are invite-only.** The server rejects these roles from public onboarding (`processOnboardingData` returns an error). The UI greys out the STAFF option. Admin onboarding exists for admin-initiated flows.

3. **Verification is post-transaction and conditional.** `submitVerificationRequest()` runs after the main transaction commits, but only when the package is complete (LinkedIn + ≥1 persistable document — see decision #12). If submission itself fails, the user profile is still created. The client receives `verificationWarning` to display a warning toast.

4. **Replace (not merge) semantics.** Professional background sections (work experience, education, certifications, achievements) and availability slots are completely replaced on each submission. This prevents orphaned records but means partial updates aren't supported.

5. **Null vs empty array distinction.** In `persistProfessionalBackground`:
   - `null` = field absent from payload → skip (don't touch existing DB records)
   - `[]` = user explicitly cleared all entries → delete all existing records
   - `[...items]` = user has entries → delete all then create new

6. **Goals normalization.** `buildConsulteeScalarData` handles older clients that send `goals: string[]` by joining with `", "`. Current clients always send `goals: string`.

7. **Logo.dev token is public.** `NEXT_PUBLIC_LOGO_DEV_TOKEN` is intentionally exposed in client code. Logo.dev free-tier tokens are domain-restricted and meant to be public.

8. **utcOffsetMinutes captured at slot creation.** The timezone offset is snapshot when the slot is created (via `getTimezoneOffsetMinutes(timezone)`). This allows the system to reconstruct the consultant's intended local time even if they change timezones later.

9. **SubDomains/Tags use `set` on update, `connect` on create.** On upsert update path, subDomains and tags use `{ set: [...] }` which replaces the entire M2M relation. On create, they use `{ connect: [...] }`.

10. **`onboardingCompleted` is forced to `true`.** The transform (`pickUserFields`) always sets `onboardingCompleted: true` regardless of what the form sends. Once you complete onboarding, it's done.

11. **Drafts are a convenience cache, never an authorization surface.** The `OnboardingDraft` row (one per user, autosaved per step) only restores wizard state. Guards read `User.onboardingCompleted`; the draft row is deleted on completion, cascade-deleted with the user under DPDP erasure, and its `role` column is narrowed to the three public roles so it can never masquerade as an authz signal. Multi-device drafts are last-write-wins; the terminal transition remains protected by the #724/#840 CAS.

12. **Consultant verification is deferrable.** A submission without LinkedIn + ≥1 persistable document still completes onboarding: the profile is saved with the model default `PENDING_VERIFICATION` and the response carries `verificationDeferred: true`. Marketplace visibility continues to gate on verification, so a deferred consultant is simply unlisted until they finish from Settings → Verification (`/api/verification/submit`, `VerificationSection.tsx`). Policy lives in `shouldSubmitVerification()` (onboarding-shared.ts); "persistable" means the entry would actually create/link a row (`isPersistableVerificationDoc()`), so junk like `[{}]` defers instead of flipping the profile to `UNDER_REVIEW` with zero documents.

13. **The consultee flow is intentionally two screens.** Demand-side users must reach marketplace value with one form + consent; every profile field is optional server-side, and enrichment is owned by the dashboard Settings tab + lazy `ensureConsulteeProfile()`.

### Alternatives considered (#onboarding-ux, 2026-08)

Recorded so nobody re-litigates these without new evidence. Benchmarks from
the Aug-2026 competitor review: Calendly (setup-as-activation, required steps
minimal, rest becomes a checklist), ADPList (demand side ≈ zero friction,
supply side is a checklist not a gate), Clarity.fm (members self-serve
instantly; experts file a separate application reviewed async),
MentorCruise (application-based supply, near-zero demand friction).

| Decision | Rejected alternative | Why rejected |
|----------|---------------------|--------------|
| Targeted refactor of the existing wizard | Full rewrite (new state machine, new components) | The hard parts were already correct and battle-tested: 5-layer validation pipeline, atomic tx, #724/#840 CAS flip, idempotent upserts, DPDP consent stamping. A rewrite (~8.6k LOC) would re-risk all of them while fighting the #705 additive-only schema freeze. The real problems were UX-layer, not data-layer. |
| Server draft row (`OnboardingDraft`) | `localStorage` only | Lost on device switch/clear-storage and invisible to ops; also cannot be cascade-deleted with the user under DPDP erasure. |
| Server draft row | Per-step incremental commits to real tables | Touches many live code paths, complicates "incomplete" states, and couples wizard navigation to production upserts. The draft keeps the big-bang transaction as the single writer of truth. |
| Consultee cut to 2 screens | 1-screen consent-only gate | Would maximize conversion but lose all personalization/matching signal at signup; 2 screens keep name/DOB/contact while everything else defers. Keeping all 4 original screens was measured against ADPList/Calendly demand-side flows and judged the primary abandonment risk. |
| Deferrable consultant verification | Keep docs strictly blocking | Verification review is asynchronous by nature (docs say 1-2 business days); blocking onboarding on it adds drop-off without speeding the review. Dashboard VerificationSection already owned post-onboarding submission, making deferral nearly free. Marketplace visibility still gates on verification, so supply quality is unchanged. |

If funnel data (Sentry breadcrumbs, category `onboarding`) contradicts any of
these assumptions — e.g. deferred consultants never finish verification, or
step-0 role picking leaks — revisit that row specifically rather than the
whole design.

---

## 12. File Map

### Core Files
| File | Purpose |
|------|---------|
| `app/form/onboarding/page.tsx` | Orchestrator — step state, form data accumulation, draft hydrate/autosave/clear, submission |
| `utils/onboarding.ts` | All Zod schemas, types, transform functions, validation utilities |
| `utils/onboarding-draft.ts` | Draft contract — wire schema, JSON sanitizer, date reviver, size gate |
| `utils/onboarding-shared.ts` | Data builders (buildUserUpdateData, scalar builders, validateProfessionalBackground) + `shouldSubmitVerification` policy |
| `utils/onboarding-server.ts` | Server processing (processOnboardingData, upserts, slot sync, verification deferral) |
| `actions/forms/onboarding.action.ts` | Server action entry point |
| `actions/onboarding-draft.action.ts` | Session-scoped draft save/load/clear actions |
| `utils/onboarding-telemetry.ts` | Funnel breadcrumbs (Sentry category "onboarding") |
| `app/api/form/onboarding/[id]/route.ts` | API route entry point |
| `schemas/user.ts` | Base Zod schemas (profiles, slots, work experience, education, certs) |
| `schemas/shared.ts` | Shared validation helpers (experienceValidation) |

### Component Files
| File | Component |
|------|-----------|
| `app/form/onboarding/components/PersonalInfoAndRoleForm.tsx` | Step 0 — all roles |
| `app/form/onboarding/components/ConsultantProfileForm.tsx` | Step 1 Tab 1 — expertise & domain |
| `app/form/onboarding/components/ConsultantProfessionalStep.tsx` | Step 1 — two-tab wrapper |
| `app/form/onboarding/components/ConsultantPreferredScheduleForm.tsx` | Step 2 — schedule |
| `app/form/onboarding/components/ConsultantAgreementAndVerificationStep.tsx` | Step 3 — verification (deferrable) + terms |
| `app/form/onboarding/components/ConsultantReviewForm.tsx` | Step 4 — review |
| `app/form/onboarding/components/ConsulteeAgreementForm.tsx` | Step 1 — terms + submit (final consultee screen) |
| `app/form/onboarding/components/StaffProfileForm.tsx` | Step 1 — staff profile |
| `app/form/onboarding/components/StaffAgreementForm.tsx` | Step 2 — terms |
| `app/form/onboarding/components/StaffReviewForm.tsx` | Step 3 — review |
| `app/form/onboarding/components/TermsAndPrivacyAgreement.tsx` | Shared terms/privacy checkboxes |

> Removed in #onboarding-ux: `ConsulteeProfileForm`,
> `ConsulteePreferencesForm`, `ConsulteeReviewForm`,
> `StaffResponsibilitiesForm`. Consultee enrichment moved to the dashboard
> Settings tab; the staff responsibilities step no longer existed in the
> registry even before this change (doc drift, now corrected).

### Experience Sub-Components
| File | Component |
|------|-----------|
| `app/form/onboarding/components/experience/WorkExperienceSection.tsx` | Work experience list |
| `app/form/onboarding/components/experience/AddWorkExperienceModal.tsx` | Add/edit work experience |
| `app/form/onboarding/components/experience/EducationSection.tsx` | Education list |
| `app/form/onboarding/components/experience/AddEducationModal.tsx` | Add/edit education |
| `app/form/onboarding/components/experience/CertificationsSection.tsx` | Certifications list |
| `app/form/onboarding/components/experience/AddCertificationModal.tsx` | Add/edit certification |
| `app/form/onboarding/components/experience/AchievementsSection.tsx` | Achievements list |
| `app/form/onboarding/components/experience/AddAchievementModal.tsx` | Add/edit achievement |

### Supporting Files
| File | Purpose |
|------|---------|
| `components/verification/VerificationDocumentUpload.tsx` | Drag & drop file upload with progress |
| `components/ui/company-logo.tsx` | Auto-detect company logos from name (Logo.dev) |
| `utils/slotAllocation/slotTimeUtils.ts` | Slot overlap detection, time validation, `getTimezoneOffsetMinutes()` |
| `utils/timeSlotValidation.ts` | `isValidTimeRange()` — duration bounds (30min–12h) |
| `lib/novu.ts` | `notifyNewConsultantApplication()` — admin notifications |
| `prisma/schema.prisma` | All model definitions |
