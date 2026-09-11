# RLS design memo (deferred — defense-in-depth proposal)

> **Last reviewed:** 2026-06-05 (wiring claims re-verified against the repo)

## Status

**Open for design.** No Supabase Row Level Security policies are
enabled today — **verified 2026-06-05**: there is no `supabase/`
config directory and no `prisma/migrations/` directory in the repo
(schema is applied via `prisma db push`), so no policy DDL is in
force. This memo captures the tradeoff, what enabling RLS
would actually look like, and the migration risks — so that when we
DO decide to enable it (likely tied to the first SOC 2 audit or the
first time we expose the Supabase anon key in client code), the
implementation plan already exists.

## What Supabase advisory says

Every Supabase project surfaces an `rls_disabled` advisory when any
table in `public` has `relrowsecurity = false`. The Prisma schema now
declares **120 models** (was ~119 at PR #655), all with RLS disabled.
The advisory's recommendation is the
`ALTER TABLE … ENABLE ROW LEVEL SECURITY` script Supabase auto-generates,
but **running it without per-table policies would lock the app out
entirely** because RLS-enabled-without-policies defaults to
zero-rows-visible.

## Why we shipped without RLS

The application enforces authorization at the API layer:

1. **BetterAuth** validates the session cookie at every route entry
   (`requireApiAuth` in `lib/auth-helpers.ts`).
2. **`requireOrgAccess`** verifies membership + capability gates
   against the target org for every `/api/organizations/[orgId]/**`
   route.
3. **`requireOrgBillingAdminOrOwner`** layers the BILLING_ADMIN
   disjunction on top for finance-mutating routes.
4. **SCIM bearer tokens** authenticate at the SCIM endpoints and
   carry the implicit tenant scope via `ScimToken.organizationId`.
5. **Cron routes** require `CRON_SECRET` for every `/api/cleanup/*`.
6. **Outbound webhook deliveries** sign every body with HMAC-SHA256
   so receivers can verify provenance.

That stack is the security boundary today. The Prisma client connects
as the service role and trusts the app layer to scope every query —
which is the standard SaaS-on-Postgres posture and matches every
PR in the project to date.

## What RLS would buy us

The case for enabling RLS is **defense-in-depth**, not the current
threat model:

- **If the Supabase service-role key leaks** (env-var exfiltration,
  CI secret exposure), an attacker with the key can read every row
  in every table. RLS doesn't help here — service role bypasses RLS.
- **If the Supabase anon key gets used client-side** (someone wires
  it into a marketing page by mistake), every row is readable via
  the `anon` role. **RLS would close this.**
- **If a future feature uses Supabase Storage / Realtime subscriptions
  directly from the browser** (rather than through our API), RLS
  becomes load-bearing — those clients authenticate as `anon` or
  `authenticated`, not as the service role.

The third point is the future-looking one. We don't use Realtime
today; we don't expose the anon key client-side. If either changes,
RLS becomes non-optional. SOC 2 Type II audits also flag the
advisory as a deficiency even when the app-layer gates are robust,
because the auditor can't prove the app is the only access path
without code-trace evidence.

## What policies would look like

Most enterprise tables would follow this template:

```sql
-- Enable RLS, declare service-role bypass (Prisma + workers use this).
ALTER TABLE "Membership" ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_full_access ON "Membership"
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Authenticated users see only memberships in their own orgs.
CREATE POLICY membership_self_read ON "Membership"
  FOR SELECT TO authenticated
  USING (
    "userId" = (auth.jwt() ->> 'sub')::text
    OR EXISTS (
      SELECT 1 FROM "Membership" m2
       WHERE m2."organizationId" = "Membership"."organizationId"
         AND m2."userId" = (auth.jwt() ->> 'sub')::text
         AND m2.status = 'ACTIVE'
         AND m2.role IN ('OWNER','MAINTAINER','MANAGER')
    )
  );

-- Mutations stay app-layer only — no authenticated WRITE policy.
```

The pattern: `service_role` bypasses RLS (Prisma + cron workers); the
`authenticated` role gets narrow `SELECT` policies; mutations always
go through the API layer. This means RLS catches the leaked-anon-key
case AND the directly-from-browser-with-user-JWT case, without
forcing us to encode every business rule twice (once in the API,
once in SQL).

## Per-table policy sketch

| Table | SELECT policy | WRITE policy |
|---|---|---|
| `organizations` | Members of the org OR owner of an OrgWorkspaceProfile linked to it | service_role only |
| `Membership` | Same as organizations | service_role only |
| `OrganizationInvoice` | Org member where role ≥ MANAGER OR BILLING_ADMIN | service_role only |
| `WebhookEndpoint` | Org member where role ≥ MANAGER OR BILLING_ADMIN | service_role only |
| `OutboundWebhookDelivery` | Same as endpoint | service_role only |
| `ScimToken` | OWNER only | service_role only |
| `ScimGroupMapping` | OWNER only | service_role only |
| `ErasureRequest` | The requesting user OR platform ADMIN | service_role only |
| `OrgDataExportJob` | Org member where role = OWNER OR BILLING_ADMIN | service_role only |
| `users` | Self OR linked-membership operator | service_role only |
| Financial tables (`Payment*`, `OrganizationPayout`, ledger entries) | service_role only (defense-in-depth, no client read) | service_role only |

Tables NOT to touch for v1: the legacy B2C tables
(`Consultation`, `Subscription`, `Appointment`, `Recording`,
`Payment`, `Refund`, etc.) — they have their own access patterns
and the surface is wider than the enterprise carve-out. Cover them
in a Phase 2 if SOC 2 or anon-key exposure forces our hand.

## Migration risks

1. **Off-by-one on policies** — a missing `OR` in a USING clause
   silently locks legitimate readers out. Mitigation: write the
   policies in a Supabase branch first; run the full app test suite
   against the branch; only merge after CI passes against the
   RLS-enabled DB.
2. **Service-role drift** — if any future code path connects as
   something other than `service_role` (e.g. an edge function that
   uses the publishable key), it will hit the user-facing policies.
   Mitigation: audit every Supabase client construction site for
   the key being used.
3. **Migration ordering** — Prisma's `db push` cannot represent
   policies (this repo has no `prisma/migrations/` dir — it pushes the
   schema directly), so they must live in raw SQL or in Supabase's
   policy editor. The project already keeps hand-written DDL under
   **`prisma/sql/`** (e.g. `prisma/sql/ledger-triggers.sql`).
   Mitigation: add policy DDL as `prisma/sql/rls-phase-1.sql` applied
   on deploy alongside the existing trigger SQL, so the policies
   version with the schema.
4. **`auth.jwt()` mismatch** — Supabase's `auth.jwt()` returns the
   token a Supabase client minted, not BetterAuth's session. If we
   ever want client-side Supabase reads with user scoping, BetterAuth
   sessions would need to mint a matching JWT. Mitigation: only
   server-side reads go through Prisma; client reads stay through
   the API.

## When to do this work

Three concrete triggers, in priority order:

1. **First time we wire Supabase Realtime or Storage directly into a
   client component** — at that point RLS becomes non-optional and
   ships in the same PR.
2. **First time a SOC 2 / ISO 27001 audit prep starts** — the
   advisory's a recurring finding; closing it before audit saves
   weeks of remediation back-and-forth.
3. **If the Supabase project's anon key ever leaks** (rotated
   immediately, but treat the advisory as critical from that point
   on).

Otherwise: leave as-is, keep the advisory visible, ensure every new
table added to the enterprise carve-out gets a row in the policy
sketch table above when this work eventually lands.

## Owner

This memo doesn't have a code owner — it's a planning artifact. The
implementation owner will be whoever picks up the trigger above
first.
