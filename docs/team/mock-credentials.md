# Mock Credentials — Familiarise Platform

All permutations: platform roles × enterprise org roles × org types.  
**Pre-production / dev data only. Do not use in production.**

**Data snapshot:** 2026-05-01  
**Source:** Supabase DB + `prisma/seedFiles/1a-create-users.ts` + `docs/enterprise/*`

---

## Universal Seed Password

All users seeded via `prisma/seedFiles/1a-create-users.ts` share one password:

```
SeedPass123!
```

Three manually-created test accounts (`owner-test`, `learner-test`, `a@gmail.com`) and the five `tour-2026-04-26-*` accounts were created outside the seed script — their passwords are **unknown**. Reset them via `/auth/forgot-password` or the Supabase Auth dashboard if needed.

**Sign-in URL:** `/auth/signin`

---

## Platform Roles (UserRole)

| Role | Dashboard | Description |
|------|-----------|-------------|
| `ADMIN` | `/dashboard/admin/…` | Full platform control — analytics, maintenance mode, TDS, everything STAFF can do |
| `STAFF` | `/dashboard/staff/[id]/…` | Day-to-day ops — payments, refunds, disputes, moderation, support tickets, system jobs |
| `CONSULTANT` | `/dashboard/consultant/[id]/…` | Expert who creates services, manages availability, earns money |
| `CONSULTEE` | `/dashboard/consultee/[id]/…` | Client who books sessions, attends calls, leaves reviews |
| `ORG_WORKSPACE` | `/dashboard/org-workspace/[id]/…` | Enterprise org administrator — manages orgs, no booking/consulting |

---

### ADMIN accounts

| Name | Email | Password |
|------|-------|----------|
| Olivia Brown | olivia.brown@protonmail.com | `SeedPass123!` |
| Patrick Brown | patrick.brown@gmail.com | `SeedPass123!` |
| Priya Brown | priya.brown@outlook.com | `SeedPass123!` |

---

### STAFF accounts

| Name | Email | Password |
|------|-------|----------|
| Maria Brown | maria.brown@gmail.com | `SeedPass123!` |
| Michael Brown | michael.brown@outlook.com | `SeedPass123!` |
| Natalie Brown | natalie.brown@yahoo.com | `SeedPass123!` |
| Nathan Brown | nathan.brown@hotmail.com | `SeedPass123!` |

---

### CONSULTANT accounts (independent + org-linked)

All passwords: `SeedPass123!`

| Name | Email | Enterprise context |
|------|-------|--------------------|
| Aarav Anderson | aarav.anderson@gmail.com | EXPERT in LearnPro Academy (payout: SELF) |
| Aditi Anderson | aditi.anderson@outlook.com | EXPERT in LearnPro Academy + LearnPro Test |
| Alex Anderson | alex.anderson@yahoo.com | EXPERT in LearnPro Academy |
| Amit Anderson | amit.anderson@hotmail.com | EXPERT in LearnPro Academy |
| Ananya Anderson | ananya.anderson@protonmail.com | EXPERT in LearnPro Academy |
| Andrew Anderson | andrew.anderson@gmail.com | EXPERT in IIT Madras (payout: ORGANIZATION — salaried) |
| Angela Anderson | angela.anderson@outlook.com | EXPERT in IIT Madras (payout: ORGANIZATION — salaried) |
| Arjun Anderson | arjun.anderson@yahoo.com | OWNER of own coaching org; EXPERT in IIT Madras (payout: SELF) |
| Benjamin Anderson | benjamin.anderson@hotmail.com | EXPERT in IIT Madras (payout: SELF) |
| Catherine Anderson | catherine.anderson@protonmail.com | EXPERT in IIT Madras (payout: SELF) |
| Daniel Anderson | daniel.anderson@outlook.com | OWNER of LearnPro Academy (HOST org) |
| Grace Anderson | grace.anderson@outlook.com | Independent marketplace consultant |
| Hannah Anderson | hannah.anderson@yahoo.com | Independent marketplace consultant |
| James Anderson | james.anderson@protonmail.com | Independent marketplace consultant |
| Jessica Anderson | jessica.anderson@gmail.com | Independent marketplace consultant |
| John Anderson | john.anderson@outlook.com | Independent marketplace consultant |
| Karen Anderson | karen.anderson@yahoo.com | Independent marketplace consultant |
| Kevin Anderson | kevin.anderson@hotmail.com | Independent marketplace consultant |
| Lauren Anderson | lauren.anderson@protonmail.com | Independent marketplace consultant |
| Liam Anderson | liam.anderson@gmail.com | Independent marketplace consultant |
| Maria Anderson | maria.anderson@outlook.com | Independent marketplace consultant |
| Michael Anderson | michael.anderson@yahoo.com | Independent marketplace consultant |
| Natalie Anderson | natalie.anderson@hotmail.com | Independent marketplace consultant |
| Nathan Anderson | nathan.anderson@protonmail.com | Independent marketplace consultant |
| Olivia Anderson | olivia.anderson@gmail.com | LEARNER in Wipro (also a CONSULTEE platform role) |

---

### CONSULTEE accounts (marketplace + org-linked)

All passwords: `SeedPass123!`

| Name | Email | Enterprise context |
|------|-------|--------------------|
| Samantha Anderson | samantha.anderson@yahoo.com | OWNER of Wipro SPONSOR org (unusual — CONSULTEE as OWNER) |
| Olivia Anderson | olivia.anderson@gmail.com | LEARNER in Wipro (SPONSOR) |
| Patrick Anderson | patrick.anderson@outlook.com | LEARNER in Wipro (SPONSOR) |
| Priya Anderson | priya.anderson@yahoo.com | LEARNER in Wipro (SPONSOR) |
| Rachel Anderson | rachel.anderson@hotmail.com | LEARNER in IIT Madras (HYBRID) |
| Raj Anderson | raj.anderson@protonmail.com | LEARNER in IIT Madras (HYBRID) |
| Rebecca Anderson | rebecca.anderson@gmail.com | LEARNER in IIT Madras (HYBRID) |
| Robert Anderson | robert.anderson@outlook.com | LEARNER in IIT Madras (HYBRID) |
| Charlotte Brown | charlotte.brown@protonmail.com | Independent marketplace consultee |
| Daniel Brown | daniel.brown@gmail.com | Independent marketplace consultee |
| David Brown | david.brown@outlook.com | Independent marketplace consultee |
| Elena Brown | elena.brown@yahoo.com | Independent marketplace consultee |
| Emily Brown | emily.brown@hotmail.com | Independent marketplace consultee |
| Ethan Brown | ethan.brown@protonmail.com | Independent marketplace consultee |
| Grace Brown | grace.brown@gmail.com | Independent marketplace consultee |
| Hannah Brown | hannah.brown@outlook.com | Independent marketplace consultee |
| Isabella Brown | isabella.brown@yahoo.com | Independent marketplace consultee |
| James Brown | james.brown@hotmail.com | Independent marketplace consultee |
| Jessica Brown | jessica.brown@protonmail.com | Independent marketplace consultee |
| John Brown | john.brown@gmail.com | Independent marketplace consultee |
| Karen Brown | karen.brown@outlook.com | Independent marketplace consultee |
| Kevin Brown | kevin.brown@yahoo.com | Independent marketplace consultee |
| Lauren Brown | lauren.brown@hotmail.com | Independent marketplace consultee |
| Liam Brown | liam.brown@protonmail.com | Independent marketplace consultee |
| learner-test | learner-test@example.com | LEARNER in Wipro test — **password unknown** |

---

### ORG_WORKSPACE accounts

| Name | Email | Password | Orgs owned | PayoutRecipient on membership |
|------|-------|----------|------------|-------------------------------|
| charlotte | charlotte.anderson@gmail.com | `SeedPass123!` | IIT Madras (HYBRID) | ORGANIZATION |
| a | a@gmail.com | **Unknown** | LearnPro Test (HOST) | SELF |
| owner-test | owner-test@example.com | **Unknown** | Wipro test (SPONSOR), GitHub India Test (HYBRID) | SELF |

---

## Org Member Role Ladder (MemberRole)

`ADMIN` and `STAFF` platform users **bypass all membership checks** — they receive a synthetic OWNER-rank stub so audit logs still produce valid `actorMembershipId` values (`__admin_stub_<userId>`).

| MemberRole | Rank | Key permissions |
|------------|------|----------------|
| `OWNER` | 100 | Billing, contracts, rate cards, payouts, org delete, can assign any role |
| `MAINTAINER` | 80 | Members, invites, programs, settings — no billing writes |
| `MANAGER` | 60 | Read-only: analytics, billing, earnings, payouts, rate cards |
| `EXPERT` | 40 | Delivers services on behalf of org; linked to `ConsultantProfile` |
| `SUPPORT` | 30 | Views support tickets, assists members — no billing access |
| `LEARNER` | 20 | Consumes org programs; linked to `ConsulteeProfile` — cannot self-assign |

> **MAINTAINER, MANAGER, and SUPPORT have no seeded members in the current DB.**
> Create them via `PATCH /api/organizations/[orgId]/members/[memberId]` as an OWNER, or directly in the DB.
>
> **LEARNER ↔ EXPERT transitions are blocked.** Remove the member and re-invite with the new role.

---

## Organization Capability Types

| Kind | canSponsor | canHost | Has `BillingAccount` | Has `OrganizationPayoutAccount` |
|------|------------|---------|---------------------|---------------------------------|
| `SPONSOR` | `true` | `false` | Yes | No |
| `HOST` | `false` | `true` | No | Yes |
| `HYBRID` | `true` | `true` | Yes | Yes (both flows run in parallel) |
| `INERT` | `false` | `false` | — | — (rejected at create time) |

---

## Credentials by Organization

### Wipro Limited — SPONSOR (`wipro`)

**Funding:** INVOICE · **Program:** LICENSED_SEAT · **PO required:** yes · **Payment terms:** 60 days

| Member | Email | Password | MemberRole | UserRole | PayoutRecipient |
|--------|-------|----------|------------|----------|----------------|
| Samantha Anderson | samantha.anderson@yahoo.com | `SeedPass123!` | **OWNER** | CONSULTEE | SELF |
| Olivia Anderson | olivia.anderson@gmail.com | `SeedPass123!` | LEARNER | CONSULTEE | SELF |
| Patrick Anderson | patrick.anderson@outlook.com | `SeedPass123!` | LEARNER | CONSULTEE | SELF |
| Priya Anderson | priya.anderson@yahoo.com | `SeedPass123!` | LEARNER | CONSULTEE | SELF |

---

### LearnPro Academy — HOST (`learnpro-academy`)

**RateCard:** 10/10/80 default · **PayoutAccount:** present · No billing/sponsor side

| Member | Email | Password | MemberRole | UserRole | PayoutRecipient |
|--------|-------|----------|------------|----------|----------------|
| Daniel Anderson | daniel.anderson@outlook.com | `SeedPass123!` | **OWNER** | CONSULTANT | SELF |
| Aarav Anderson | aarav.anderson@gmail.com | `SeedPass123!` | EXPERT | CONSULTANT | SELF |
| Aditi Anderson | aditi.anderson@outlook.com | `SeedPass123!` | EXPERT | CONSULTANT | SELF |
| Alex Anderson | alex.anderson@yahoo.com | `SeedPass123!` | EXPERT | CONSULTANT | SELF |
| Amit Anderson | amit.anderson@hotmail.com | `SeedPass123!` | EXPERT | CONSULTANT | SELF |
| Ananya Anderson | ananya.anderson@protonmail.com | `SeedPass123!` | EXPERT | CONSULTANT | SELF |

---

### Indian Institute of Technology Madras — HYBRID (`iit-madras`)

**Funding:** WALLET · **Program:** CREDIT_POOL · **Both billing + payout flows active**

| Member | Email | Password | MemberRole | UserRole | PayoutRecipient |
|--------|-------|----------|------------|----------|----------------|
| charlotte | charlotte.anderson@gmail.com | `SeedPass123!` | **OWNER** | ORG_WORKSPACE | ORGANIZATION |
| Andrew Anderson | andrew.anderson@gmail.com | `SeedPass123!` | EXPERT | CONSULTANT | **ORGANIZATION** (salaried) |
| Angela Anderson | angela.anderson@outlook.com | `SeedPass123!` | EXPERT | CONSULTANT | **ORGANIZATION** (salaried) |
| Arjun Anderson | arjun.anderson@yahoo.com | `SeedPass123!` | EXPERT | CONSULTANT | SELF (marketplace share) |
| Benjamin Anderson | benjamin.anderson@hotmail.com | `SeedPass123!` | EXPERT | CONSULTANT | SELF |
| Catherine Anderson | catherine.anderson@protonmail.com | `SeedPass123!` | EXPERT | CONSULTANT | SELF |
| Rachel Anderson | rachel.anderson@hotmail.com | `SeedPass123!` | LEARNER | CONSULTEE | SELF |
| Raj Anderson | raj.anderson@protonmail.com | `SeedPass123!` | LEARNER | CONSULTEE | SELF |
| Rebecca Anderson | rebecca.anderson@gmail.com | `SeedPass123!` | LEARNER | CONSULTEE | SELF |
| Robert Anderson | robert.anderson@outlook.com | `SeedPass123!` | LEARNER | CONSULTEE | SELF |

---

### Arjun Anderson's Coaching — HOST (`arjun-anderson-coaching-vghi`)

Single-consultant convenience org.

| Member | Email | Password | MemberRole | UserRole | PayoutRecipient |
|--------|-------|----------|------------|----------|----------------|
| Arjun Anderson | arjun.anderson@yahoo.com | `SeedPass123!` | **OWNER** | CONSULTANT | SELF |

---

### Wipro test — SPONSOR (`wipro-test`)

| Member | Email | Password | MemberRole | UserRole | PayoutRecipient |
|--------|-------|----------|------------|----------|----------------|
| owner-test | owner-test@example.com | **Unknown** | **OWNER** | ORG_WORKSPACE | SELF |
| learner-test | learner-test@example.com | **Unknown** | LEARNER | CONSULTEE | SELF |

---

### GitHub India Test — HYBRID (`github-india-test`)

| Member | Email | Password | MemberRole | UserRole | PayoutRecipient |
|--------|-------|----------|------------|----------|----------------|
| owner-test | owner-test@example.com | **Unknown** | **OWNER** | ORG_WORKSPACE | SELF |

---

### LearnPro Test — HOST (`learnpro-test`)

| Member | Email | Password | MemberRole | UserRole | PayoutRecipient |
|--------|-------|----------|------------|----------|----------------|
| a | a@gmail.com | **Unknown** | **OWNER** | ORG_WORKSPACE | SELF |
| Aditi Anderson | aditi.anderson@outlook.com | `SeedPass123!` | EXPERT | CONSULTANT | SELF |

---

## Tour / Named Test Accounts (no org memberships assigned)

These accounts exist in the DB but have no `Membership` rows linked to any organization. Their platform role is `CONSULTEE`. Passwords are unknown.

| Name | Email | Notes |
|------|-------|-------|
| Tour Expert | tour-2026-04-26-expert@example.com | Named for a UI tour; no org membership |
| Tour Learner | tour-2026-04-26-learner@example.com | Named for a UI tour; no org membership |
| Tour Maintainer | tour-2026-04-26-maintainer@example.com | Named for a UI tour; no org membership |
| Tour Manager | tour-2026-04-26-manager@example.com | Named for a UI tour; no org membership |
| Tour Support | tour-2026-04-26-support@example.com | Named for a UI tour; no org membership |

---

## Full Permutation Matrix

Every valid combination of `UserRole × org capability kind × MemberRole`.

| UserRole | Org kind | MemberRole | Seeded example |
|----------|----------|------------|----------------|
| ORG_WORKSPACE | SPONSOR | OWNER | owner-test@example.com (Wipro test) |
| ORG_WORKSPACE | HYBRID | OWNER | charlotte.anderson@gmail.com (IIT Madras); owner-test@example.com (GitHub India Test) |
| ORG_WORKSPACE | HOST | OWNER | a@gmail.com (LearnPro Test) |
| CONSULTEE | SPONSOR | OWNER | samantha.anderson@yahoo.com (Wipro) — unusual but valid |
| CONSULTEE | SPONSOR | LEARNER | olivia/patrick/priya.anderson (Wipro); learner-test (Wipro test) |
| CONSULTEE | HYBRID | LEARNER | rachel/raj/rebecca/robert.anderson (IIT Madras) |
| CONSULTANT | HOST | OWNER | daniel.anderson@outlook.com (LearnPro Academy); arjun.anderson@yahoo.com (own org) |
| CONSULTANT | HOST | EXPERT (SELF) | aarav/aditi/alex/amit/ananya.anderson (LearnPro Academy); aditi.anderson (LearnPro Test) |
| CONSULTANT | HYBRID | EXPERT (SELF) | arjun/benjamin/catherine.anderson (IIT Madras) |
| CONSULTANT | HYBRID | EXPERT (ORGANIZATION) | andrew/angela.anderson (IIT Madras) — salaried |
| ADMIN | any | Synthetic OWNER stub | olivia.brown@protonmail.com — bypasses `requireOrgAccess` entirely |
| STAFF | any | Synthetic OWNER stub | maria.brown@gmail.com — same bypass logic as ADMIN |
| any | any | MAINTAINER | **Not seeded** — create via `PATCH /members/[id]` as OWNER |
| any | any | MANAGER | **Not seeded** — create via `PATCH /members/[id]` as OWNER |
| any | any | SUPPORT | **Not seeded** — create via `PATCH /members/[id]` as OWNER |

---

## Dashboard URL Patterns

| Surface | URL pattern |
|---------|-------------|
| Admin dashboard | `/dashboard/admin/…` |
| Staff dashboard | `/dashboard/staff/[staffProfileId]/…` |
| Consultant dashboard | `/dashboard/consultant/[consultantProfileId]/…` |
| Consultee dashboard | `/dashboard/consultee/[consulteeProfileId]/…` |
| Org-admin dashboard | `/dashboard/org-workspace/[orgWorkspaceProfileId]/…` |
| Org dashboard (any member) | `/dashboard/organization/[orgId]` → routes by MemberRole |
| Org OWNER/MAINTAINER/MANAGER/SUPPORT landing | `/dashboard/organization/[orgId]/home` |
| Org LEARNER landing | `/dashboard/organization/[orgId]/my-program` |
| Org EXPERT landing | `/dashboard/organization/[orgId]/compensation` |
