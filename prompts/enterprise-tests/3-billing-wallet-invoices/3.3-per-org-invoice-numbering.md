# 3-billing-wallet-invoices — Per-org invoice numbering

> **Required reading:** [`_shared/shared-setup.md`](../_shared/shared-setup.md),
> [`_shared/mcp-recipes.md`](../_shared/mcp-recipes.md),
> [`_shared/case-template.md`](../_shared/case-template.md).
> Apply the **fix-and-retest gate** when any case fails.

**Surface(s) under test:**
- `lib/payments/billing/invoice-numbering.ts` — `generateOrgInvoiceNumber`, `allocateOrgInvoiceSeq`, `indianFiscalYear`
- `prisma/schema.prisma model OrgInvoiceCounter` — atomic seq allocator
- `prisma/schema.prisma model OrganizationInvoice` — `invoiceNumber`, `fiscalYear`, `@@unique([organizationId, invoiceNumber])`
- `app/api/organizations/[orgId]/billing-account/invoices/route.ts:POST` — caller (manual invoice issue)
- `jobs/billing/generate-subscription-invoices.ts` — caller (cron)

**Round-3 invariant — see shared-setup §4:** "Per-org invoice numbering — Format `<PREFIX>-<FY>-<SEQ>` (CGST Rule 46). PREFIX = `Organization.invoiceNumberPrefix` or uppercased slug. `@@unique([organizationId, invoiceNumber])`. FY = April–March. Atomic counter at `OrgInvoiceCounter`."

**Case roster:**
1. **N.1** — First invoice format + counter writes
2. **N.2** — Sequential allocation (5 invoices)
3. **N.3** — Two orgs in parallel — no cross-org collision
4. **N.4** — Fiscal-year rollover
5. **N.5** — Concurrent POSTs (race-safe)
6. **N.6** — Slug fallback when `invoiceNumberPrefix` is null
7. **N.7** — March → April FY boundary

---

## Common preconditions

Wipro has `invoiceNumberPrefix = NULL` (uses slug fallback by default).
Set it to `'WIPRO'` for cases N.1, N.2, N.3, N.4 so the format is deterministic:

```sql
UPDATE "organizations" SET "invoiceNumberPrefix" = 'WIPRO' WHERE slug = 'wipro';
```

Reset the counter for this fiscal year before the case:

```sql
DELETE FROM "org_invoice_counters"
WHERE "organizationId" = (SELECT id FROM "organizations" WHERE slug = 'wipro')
  AND "fiscalYear" = 2026;
```

(The first invoice issued will INSERT a fresh counter row.)

Login as `founder@wipro.test`. Capture `<wipro-id>` and the active
`<contract-id>` + `<billing-account-id>`.

---

## Case N.1: First invoice — format + counter writes

### Steps
Issue an invoice via the API (run via Chrome MCP `evaluate_script`):

```js
() => fetch("/api/organizations/<wipro-id>/billing-account/invoices", {
  method: "POST",
  credentials: "include",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    contractId: "<contract-id>",
    issueImmediately: true,
    displayCurrency: "INR",
    dueDate: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
    items: [{ description: "Test invoice N.1", quantity: 1, unitPrice: 100000 }]
  })
}).then(async r => ({ status: r.status, body: await r.json() }))
```

### Assertions
- `status === 201` (or 200; verify against route)
- `body.data.invoiceNumber === "WIPRO-2026-0001"` (if today is in FY2026)
- `body.data.fiscalYear === 2026`

DB confirms:
```sql
SELECT "invoiceNumber", "fiscalYear" FROM "OrganizationInvoice"
WHERE "organizationId" = '<wipro-id>' ORDER BY "createdAt" DESC LIMIT 1;
-- Expected: WIPRO-2026-0001, 2026
```

Counter row:
```sql
SELECT "nextSeq" FROM "org_invoice_counters"
WHERE "organizationId" = '<wipro-id>' AND "fiscalYear" = 2026;
-- Expected: 2 (was 1, allocated 1, now 2)
```

### Done when
- [ ] Invoice number matches `WIPRO-2026-0001`
- [ ] Counter row `nextSeq = 2`

---

## Case N.2: Sequential — 4 more invoices

Repeat the POST 4 times. Assert:
```sql
SELECT "invoiceNumber" FROM "OrganizationInvoice"
WHERE "organizationId" = '<wipro-id>'
  AND "fiscalYear" = 2026
ORDER BY "createdAt";
-- Expected: WIPRO-2026-0001, ..., WIPRO-2026-0005
```

Counter:
```sql
SELECT "nextSeq" FROM "org_invoice_counters"
WHERE "organizationId" = '<wipro-id>' AND "fiscalYear" = 2026;
-- Expected: 6
```

**No gaps allowed** — CGST Rule 46. If the sequence skips a number,
that's a critical bug (NON-TRIVIAL — touches the atomic allocator in
`lib/payments/billing/invoice-numbering.ts`). ASK before fixing.

---

## Case N.3: Two orgs in parallel

Set IIT Madras' prefix too:
```sql
UPDATE "organizations" SET "invoiceNumberPrefix" = 'IITM' WHERE slug = 'iit-madras';
DELETE FROM "org_invoice_counters"
WHERE "organizationId" = (SELECT id FROM "organizations" WHERE slug = 'iit-madras')
  AND "fiscalYear" = 2026;
```

Issue 3 invoices for Wipro, 3 for IIT Madras (interleaved). Each org's
sequence is independent.

### Assertions
```sql
SELECT o.slug, oi."invoiceNumber"
FROM "OrganizationInvoice" oi
JOIN "organizations" o ON o.id = oi."organizationId"
WHERE o.slug IN ('wipro', 'iit-madras')
  AND oi."fiscalYear" = 2026
ORDER BY o.slug, oi."createdAt";
-- Expected:
--   iit-madras | IITM-2026-0001
--   iit-madras | IITM-2026-0002
--   iit-madras | IITM-2026-0003
--   wipro      | WIPRO-2026-0006  (after N.2's 5 + this case's 3)
--   wipro      | WIPRO-2026-0007
--   wipro      | WIPRO-2026-0008
```

No cross-org collision — both orgs can have `*-2026-0001`.

---

## Case N.4: Fiscal-year rollover

Pre-seed a counter for FY2027 to force the rollover:
```sql
INSERT INTO "org_invoice_counters" ("organizationId", "fiscalYear", "nextSeq", "updatedAt")
VALUES ('<wipro-id>', 2027, 1, now());
```

Issue an invoice with a future `issuedAt`. Since the helper computes FY
from `new Date()` at issue time, the test needs to simulate a future
date. **Two options:**

**Option A (preferred — direct DB):** call `generateOrgInvoiceNumber`
via a test script entry-point. Out of scope for an MCP-only case; use
Option B.

**Option B (via the route + DB UPDATE):** Issue normally (lands in
FY2026 / WIPRO-2026-0009). Then DELETE that row and UPDATE
`OrgInvoiceCounter` row for 2027 to confirm the helper's behaviour
across years. This case is intentionally split: most validation already
lives in the unit test at `__tests__/enterprise/invoice-numbering.test.ts`.
Mark this case as **DEFERRED until a date-injection hook is added to
the route**; track in the case-runner's checklist.

### Done when
- [ ] If running Option B, FY2027 counter exists with `nextSeq = 1`
- [ ] Future work item logged

---

## Case N.5: Concurrent POSTs

Fire 10 parallel POSTs against the Wipro invoice endpoint:

```js
() => Promise.all(
  Array.from({ length: 10 }, (_, i) =>
    fetch("/api/organizations/<wipro-id>/billing-account/invoices", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contractId: "<contract-id>",
        issueImmediately: true,
        displayCurrency: "INR",
        dueDate: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
        items: [{ description: `Concurrent N.5 ${i}`, quantity: 1, unitPrice: 100 }]
      })
    }).then(async r => ({ status: r.status, body: await r.json() }))
  )
).then(rs => rs.map(r => ({ status: r.status, num: r.body?.data?.invoiceNumber })))
```

### Assertions
- All 10 `status === 201` (no P2002 leaks)
- 10 distinct `invoiceNumber` values, all matching `WIPRO-2026-\d{4}` regex
- Sequence is monotonic over the 10 (allocation order = creation order
  per the atomic counter; small reorderings are acceptable as long as no
  duplicates and no gaps).

DB check:
```sql
SELECT count(*), count(DISTINCT "invoiceNumber")
FROM "OrganizationInvoice"
WHERE "organizationId" = '<wipro-id>'
  AND "fiscalYear" = 2026
  AND "createdAt" > NOW() - INTERVAL '2 minutes';
-- Expected: count = count(DISTINCT) = 10
```

**Regression signal:** if any P2002 surfaces in the network logs,
the atomic UPSERT is leaking. NON-TRIVIAL fix to
`lib/payments/billing/invoice-numbering.ts` — ASK before changing the
SQL.

---

## Case N.6: Slug fallback (null prefix)

Spawn a fresh org with `invoiceNumberPrefix = NULL`:
```sql
INSERT INTO "organizations" (id, slug, name, status, "canSponsor", "canHost", "rootId", "createdAt", "updatedAt", "invoiceNumberPrefix")
VALUES (gen_random_uuid()::text, 'test-2026-' || to_char(now(), 'YYYYMMDD') || '-fallback', 'Test Fallback', 'ACTIVE', true, false, '__self__', now(), now(), NULL)
RETURNING id;
```

Set up its BillingAccount + Contract (use the pattern from
`_shared/mcp-recipes.md`). Issue an invoice.

### Assertions
```sql
SELECT "invoiceNumber" FROM "OrganizationInvoice"
WHERE "organizationId" = '<fresh-org-id>' LIMIT 1;
-- Expected: 'TEST-2026-{YYYYMMDD}-FALLBACK-2026-0001' (slug uppercased)
```

### Cleanup
```sql
DELETE FROM "organizations" WHERE slug LIKE 'test-2026-%-fallback';
```

---

## Case N.7: March → April FY boundary

The Indian fiscal year runs April–March. An invoice issued at
`2026-03-31 23:59 UTC` lands in FY 2025; one issued at
`2026-04-01 00:01 UTC` lands in FY 2026.

This case can't be exercised via the route without a date-injection
hook — defer to the unit test at
`__tests__/enterprise/invoice-numbering.test.ts:indianFiscalYear`.

Mark this MCP case as **a documentation pointer** that says: "for the
boundary check, run `npm test -- invoice-numbering` and confirm the
unit test's `March → previous FY` and `April → start of next FY` cases
both pass." That's the contract test for this surface.

### Done when
- [ ] Unit test cited and confirmed green (the user runs `npm test`
      if not already in CI)

---

## Cross-case cleanup

```sql
-- Restore Wipro / IIT Madras prefixes if you mutated them
UPDATE "organizations" SET "invoiceNumberPrefix" = NULL WHERE slug IN ('wipro', 'iit-madras');
-- Remove fresh test orgs
DELETE FROM "organizations" WHERE slug LIKE 'test-2026-%-fallback';
-- Optional: prune test invoices to keep the cohort tidy
DELETE FROM "OrganizationInvoice"
WHERE "organizationId" IN (SELECT id FROM "organizations" WHERE slug IN ('wipro', 'iit-madras'))
  AND items::text LIKE '%Test invoice%' OR items::text LIKE '%Concurrent N.5%';
```
