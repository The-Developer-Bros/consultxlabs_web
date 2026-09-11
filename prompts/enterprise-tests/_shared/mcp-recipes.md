# MCP recipes — Supabase + Chrome DevTools

> Companion to [`shared-setup.md`](./shared-setup.md). This file codifies
> the MCP command shapes every case file uses. Cite a recipe by section
> anchor (e.g. "See `mcp-recipes.md` §Login-as-OWNER") rather than
> copy-pasting the snippet.

**Supabase project ID:** `pzmbxqdgibfkhjwzeprf`

---

## §1 — Supabase MCP idioms

### SELECT-assert
```ts
mcp__supabase__execute_sql({
  project_id: "pzmbxqdgibfkhjwzeprf",
  query: `
    SELECT id, status, "canSponsor", "canHost"
    FROM "organizations"
    WHERE slug = 'wipro';
  `
})
// Expected: 1 row, status='ACTIVE', canSponsor=true, canHost=false
```

Double-quote mixed-case identifiers (`"organizations"` is lowercase per
BetterAuth `@@map`, but `"BillingAccount"` and `"OrganizationInvoice"`
are mixed-case Prisma defaults). When in doubt, check `shared-setup.md`
§6.

### INSERT-seed (fresh test org)
```ts
mcp__supabase__execute_sql({
  project_id: "pzmbxqdgibfkhjwzeprf",
  query: `
    INSERT INTO "organizations"
      (id, slug, name, status, "canSponsor", "canHost", "rootId", "createdAt", "updatedAt")
    VALUES (
      gen_random_uuid()::text,
      'test-2026-' || to_char(now(), 'YYYYMMDD') || '-acme-' || substring(gen_random_uuid()::text, 1, 8),
      'Test Acme',
      'PENDING_VERIFICATION',
      true, false,
      '__self__',
      now(), now()
    )
    RETURNING id, slug;
  `
})
// Then UPDATE rootId = id (single statement; see shared-setup §3 WITH/UPDATE form)
```

### DELETE-cleanup
```ts
mcp__supabase__execute_sql({
  project_id: "pzmbxqdgibfkhjwzeprf",
  query: `DELETE FROM "organizations" WHERE slug LIKE 'test-2026-%' AND "createdAt" < NOW() - INTERVAL '2 hours';`
})
```

Cleanup runs at the **end of the case** that spawned the row, not
nightly. Half-broken cases leaving dangling rows collide with later cases.

### Ledger trio assertion (the immutable source of truth)
After any money-moving UI action, assert all three ledgers in one query:

```ts
mcp__supabase__execute_sql({
  project_id: "pzmbxqdgibfkhjwzeprf",
  query: `
    SELECT
      (SELECT json_agg(row_to_json(u)) FROM (
         SELECT id, "appointmentId", "engagementsConsumed", "priceAtBookingPaise", "createdAt"
         FROM "UsageLedgerEntry"
         WHERE "createdAt" > NOW() - INTERVAL '1 minute'
         ORDER BY "createdAt" DESC LIMIT 5
       ) u) AS usage,
      (SELECT json_agg(row_to_json(f)) FROM (
         SELECT id, "deltaPaise", reason, "balanceAfterPaise", "createdAt"
         FROM "FundingLedgerEntry"
         WHERE "createdAt" > NOW() - INTERVAL '1 minute'
         ORDER BY "createdAt" DESC LIMIT 5
       ) f) AS funding,
      (SELECT json_agg(row_to_json(s)) FROM (
         SELECT id, kind, "amountPaise", currency, notes, "createdAt"
         FROM "SettlementLedgerEntry"
         WHERE "createdAt" > NOW() - INTERVAL '1 minute'
         ORDER BY "createdAt" DESC LIMIT 5
       ) s) AS settlement;
  `
})
```

### Audit log assertion
```ts
mcp__supabase__execute_sql({
  project_id: "pzmbxqdgibfkhjwzeprf",
  query: `
    SELECT category, action, description, details, "createdAt"
    FROM "OrgAuditLog"
    WHERE "organizationId" = '<orgId>'
    ORDER BY "createdAt" DESC
    LIMIT 5;
  `
})
// Assert: most recent row has action='PROGRAM_CREATED' (or whichever
// AUDIT_ACTIONS literal the step is supposed to emit).
```

### Migration / schema confirmation
```ts
mcp__supabase__execute_sql({
  project_id: "pzmbxqdgibfkhjwzeprf",
  query: `SELECT migration_name, applied_steps_count, finished_at
          FROM "_prisma_migrations" ORDER BY started_at DESC LIMIT 5;`
})
// Confirms 20260515000000_post_2c423b88_drift_fix and Round-3 migrations
// are recorded as applied with finished_at NOT NULL.
```

---

## §2 — Chrome DevTools MCP idioms

### Click-fill-assert dance
```
1. mcp__chrome-devtools__navigate_page("http://localhost:3000/some/path")
2. mcp__chrome-devtools__take_snapshot()             ← read the a11y tree to find uids
3. mcp__chrome-devtools__click({ uid: "<button>" })  OR
   mcp__chrome-devtools__fill_form({ elements: [{ uid, value }, ...] })
4. mcp__chrome-devtools__wait_for({ text: "<expected new state>" })
5. mcp__chrome-devtools__take_snapshot()             ← verify new state
6. mcp__supabase__execute_sql(...)                   ← cross-tool DB assertion
```

Always `take_snapshot` immediately before a click/fill. The a11y tree
moves; uids from a stale snapshot are fragile.

### Login-as-OWNER recipe
```
1. mcp__chrome-devtools__navigate_page("http://localhost:3000/auth/signin")
2. take_snapshot()
3. fill_form({ elements: [
     { uid: "<email-input>", value: "founder@wipro.test" },
     { uid: "<password-input>", value: "TestPassword123!" }
   ]})
4. click({ uid: "<signin-button>" })
5. wait_for({ text: "Wipro" })   ← confirm the org name in the dashboard hero
6. take_snapshot()
```

Then verify membership via Supabase:
```ts
mcp__supabase__execute_sql({
  project_id: "pzmbxqdgibfkhjwzeprf",
  query: `
    SELECT m.role, m.status, u.email, o.slug
    FROM "Membership" m
    JOIN users u ON u.id = m."userId"
    JOIN "organizations" o ON o.id = m."organizationId"
    WHERE u.email = 'founder@wipro.test' AND o.slug = 'wipro';
  `
})
// Expected: role='OWNER', status='ACTIVE'
```

### Unauthenticated 401/403 path (no Chrome login)
For testing routes that should reject unauth requests:
```
mcp__chrome-devtools__evaluate_script({
  function: `
    () => fetch("/api/organizations/<orgId>/programs", {
      method: "POST",
      credentials: "omit",        // ← suppresses the session cookie
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "LICENSED_SEAT", contractId: "x", name: "test" })
    }).then(async r => ({ status: r.status, body: await r.json() }))
  `
})
// Assert: status === 401, body.error matches expected
```

Same shape works for cross-org IDOR tests (log in as Wipro OWNER, then
`evaluate_script` a POST against `iit-madras`'s org id and assert 403).

### Network + console inspection (catch silent bugs)
After any UI mutation:
```
mcp__chrome-devtools__list_console_messages()
// Look for:
//   - "Unhandled promise rejection"
//   - "Hydration failed"
//   - "[AUDIT_HOOK]" errors (signal: audit log dispatch failure)
//   - "P2002" or any Prisma error code

mcp__chrome-devtools__list_network_requests()
// Look for:
//   - 4xx responses on background queries (the UI hides them)
//   - Missing POST to /api/.../audit (the action didn't emit an audit row)
//   - Razorpay endpoint shape (when wallet/invoice flow is in scope)
```

When something specific is suspicious, drill in:
```
mcp__chrome-devtools__get_network_request({ reqid: "<id-from-list>" })
// Returns full request/response body for debugging.
```

---

## §3 — Cross-tool assertion pattern

After any UI mutation, the case **must** query Supabase to confirm the
DB state matches the UI's claim. Catches "UI says it worked but the row
never wrote" bugs (lost transactions, optimistic-update glitches,
audit-emit failures, ledger drift).

Pattern:

```
[Chrome UI step] → [Chrome wait_for success message] →
[Supabase SELECT to confirm row exists] → [Chrome network/console check for silent errors]
```

Example: invoice payment.
```
1. Chrome: click "Pay" → Razorpay popup completes → wait_for("Invoice paid")
2. Supabase: SELECT id, status, "paidAt" FROM "OrganizationInvoice" WHERE id = '<id>'
   Assert: status='PAID', paidAt > test-start-time
3. Supabase: SELECT count(*) FROM "SettlementLedgerEntry"
              WHERE "invoiceId" = '<id>' AND kind='INVOICE_PAID'
   Assert: 1 row
4. Chrome: list_console_messages() — assert no Prisma error / hydration warning
5. Chrome: list_network_requests() — assert no 4xx on /api/.../audit
```

If the UI says success but the DB row didn't write, you've found a real
bug. Apply the fix-and-retest gate.

---

## §4 — Cron / job invocation

Crons run via `npx tsx <path>`. They self-execute on `require.main === module`.

```bash
# Example: contract expiry cron (idempotent — safe to re-run)
npx tsx jobs/compliance/contract-expiry.ts

# DataBreach 72h alert (hourly in production)
npx tsx jobs/compliance/databreach-deadline-alerts.ts

# IRP uploader (daily 02:30 UTC in production)
npx tsx jobs/compliance/irp-uploader.ts
```

For async cron assertions, **don't sleep-and-poll**. Instead:

1. Seed the state the cron is meant to act on (Supabase INSERT).
2. Run the cron synchronously: `npx tsx <path>` (it blocks until done).
3. Immediately query the DB to confirm the cron's effect.

Cron output (`console.log` summaries) goes to stdout — the Bash tool
captures it.

---

## §5 — Common assertion shapes

### "Audit log emitted"
```sql
SELECT 1 FROM "OrgAuditLog"
WHERE "organizationId" = '<orgId>'
  AND action = 'PROGRAM_CREATED'
  AND "createdAt" > NOW() - INTERVAL '30 seconds';
-- Expect: 1 row
```

### "Settlement ledger entry"
```sql
SELECT kind, "amountPaise", currency, notes
FROM "SettlementLedgerEntry"
WHERE "organizationId" = '<orgId>'
ORDER BY "createdAt" DESC LIMIT 1;
-- Expect: kind matches the action (INVOICE_ISSUED / PAYOUT_SENT / etc.)
```

### "Per-org invoice number format"
```sql
SELECT "invoiceNumber", "fiscalYear"
FROM "OrganizationInvoice"
WHERE "organizationId" = '<orgId>'
ORDER BY "createdAt" DESC LIMIT 1;
-- Expect: invoiceNumber matches /^[A-Z][A-Z0-9-]*-\d{4}-\d{4,}$/
```

### "Org-scoped FK populated (Round-3)"
```sql
SELECT id, "organizationId"
FROM "Recording"
WHERE "createdAt" > NOW() - INTERVAL '5 minutes';
-- Expect: organizationId NOT NULL when the parent plan is org-owned
```

### "TDS withheld on payout (Round-3)"
```sql
SELECT id, "amountPaise", "netPayoutPaise", "tdsSectionApplied",
       "tdsAmountPaise", "dtaaRateApplied", "mustPayByDate"
FROM "OrganizationPayout"
ORDER BY "createdAt" DESC LIMIT 1;
-- Expect: tdsSectionApplied IS NOT NULL,
--         amountPaise = netPayoutPaise - tdsAmountPaise,
--         mustPayByDate IS NOT NULL
```

---

## §6 — When NOT to use these tools

- **Don't `npm run dev`.** Ask the user to start it.
- **Don't `npm run build` / `tsc --noEmit` / `lint`** unless the user explicitly asks.
- **Don't seed via `npm run db:seed`** mid-case — the seed cohort already exists; fresh orgs go through Supabase MCP INSERT.
- **Don't write to `_prisma_migrations` manually.** Schema sync happens via `prisma migrate deploy` outside test runs.
- **Don't call BetterAuth's `/api/auth/sign-in/email` via curl.** It needs the full browser cookie / CSRF dance; log in via Chrome MCP, then read the session cookie via `list_network_requests` if you need it.
