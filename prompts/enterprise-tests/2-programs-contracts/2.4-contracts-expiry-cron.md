# 2-programs-contracts — Contract expiry cron

> **Required reading:** [`_shared/shared-setup.md`](../_shared/shared-setup.md),
> [`_shared/mcp-recipes.md`](../_shared/mcp-recipes.md),
> [`_shared/case-template.md`](../_shared/case-template.md).
> Apply the **fix-and-retest gate** when any case fails.

**Surface(s) under test:**
- `jobs/compliance/contract-expiry.ts` — the cron entry
- `.github/workflows/expire-contracts.yml` — daily 03:00 UTC schedule
- `prisma/schema.prisma model Contract` — `status` enum `DRAFT | ACTIVE | EXPIRED | TERMINATED`

**Round-3 invariant — see shared-setup §4:** "Contract expiry cron — daily 03:00 UTC. ACTIVE → EXPIRED when `effectiveTo < NOW()`. In-flight earnings retain their `rateCardId` snapshot."

**Case roster:**
1. **CE.1** — Happy expiry: past-due ACTIVE → EXPIRED
2. **CE.2** — Idempotent re-run
3. **CE.3** — In-flight earnings unaffected by expiry
4. **CE.4** — Future contract untouched
5. **CE.5** — TERMINATED / DRAFT untouched

---

## Common preconditions

Spawn a fresh sponsor org + billing account + rate card so case data
doesn't bleed into the seed cohort.

```sql
-- Capture into <orgId>, <baId>, <rateCardId>:
INSERT INTO "organizations" (id, slug, name, status, "canSponsor", "canHost", "rootId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'test-2026-' || to_char(now(), 'YYYYMMDD') || '-ce-' || substring(gen_random_uuid()::text, 1, 8),
        'Test CE Org', 'ACTIVE', true, false, '__self__', now(), now())
RETURNING id;

-- (then UPDATE rootId, create BillingAccount, RateCard — full sequence in _shared/mcp-recipes.md)
```

After all cases, cleanup:
```sql
DELETE FROM "organizations" WHERE slug LIKE 'test-2026-%-ce-%';
```

---

## Case CE.1: Past-due ACTIVE → EXPIRED

### Preconditions
Insert a Contract with `effectiveTo = NOW() - INTERVAL '1 day'`, status ACTIVE:

```sql
INSERT INTO "Contract" (id, "organizationId", "billingAccountId", status, "effectiveFrom", "effectiveTo", "paymentTermsDays", "rateCardId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, '<orgId>', '<baId>', 'ACTIVE',
        NOW() - INTERVAL '30 days', NOW() - INTERVAL '1 day',
        60, '<rateCardId>', now(), now())
RETURNING id;
-- Capture as <contractId>
```

### Steps
```bash
npx tsx jobs/compliance/contract-expiry.ts
# Watch stdout: should log "Expired N contracts" with N >= 1
```

### Assertions
```sql
SELECT status FROM "Contract" WHERE id = '<contractId>';
-- Expected: 'EXPIRED'
```

```sql
SELECT category, action, description FROM "OrgAuditLog"
WHERE "organizationId" = '<orgId>'
  AND action ILIKE '%CONTRACT%'
ORDER BY "createdAt" DESC LIMIT 1;
-- Expected: a row with category=CONTRACT, action like 'CONTRACT_EXPIRED'
-- (verify against lib/enterprise/audit-actions.ts; if no such literal exists,
-- the cron is firing without audit emission — TRIVIAL fix to add the emit, or
-- ASK if it requires a new audit literal.)
```

### Done when
- [ ] Contract status = EXPIRED
- [ ] Audit row emitted (or follow the fix-and-retest gate)

---

## Case CE.2: Idempotent re-run

### Preconditions
Run CE.1 first so the contract is already EXPIRED.

### Steps
```bash
npx tsx jobs/compliance/contract-expiry.ts
# Watch stdout: "Expired 0 contracts" (or no log if zero-rows)
```

### Assertions
```sql
SELECT status, "updatedAt" FROM "Contract" WHERE id = '<contractId>';
-- Expected: status='EXPIRED', updatedAt unchanged from CE.1
```

No second audit row:
```sql
SELECT count(*) FROM "OrgAuditLog"
WHERE "organizationId" = '<orgId>' AND action ILIKE '%CONTRACT_EXPIRED%';
-- Expected: 1
```

---

## Case CE.3: In-flight earnings unaffected

### Preconditions
Same as CE.1 but BEFORE running the cron, seed an `OrganizationEarnings`
row tied to the contract:

```sql
INSERT INTO "OrganizationEarnings" (id, "organizationId", "consultantProfileId",
  "appointmentId", "rateCardId", "platformBpsApplied", "orgBpsApplied",
  "consultantBpsApplied", "grossAmountPaise", "orgSharePaise",
  "consultantSharePaise", "platformFeePaise", currency, status, "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, '<orgId>', '<seed-consultant-profile-id>',
  '<seed-appointment-id>', '<rateCardId>',
  1000, 1000, 8000, 100000, 10000, 80000, 10000, 'INR', 'READY', now(), now())
RETURNING id;
-- Capture as <earningsId>
```

### Steps
Run the cron as in CE.1.

### Assertions
```sql
SELECT id, "rateCardId", "platformBpsApplied", "orgBpsApplied", "consultantBpsApplied", status
FROM "OrganizationEarnings" WHERE id = '<earningsId>';
-- Expected: row unchanged; rateCardId still references the (now-EXPIRED) contract's rate card.
```

```sql
SELECT status FROM "Contract" WHERE id = '<contractId>';
-- Expected: 'EXPIRED' (cron still ran)
```

The earnings row's snapshot fields (`*BpsApplied`) are immutable
post-creation — the cron must not rewrite them. Bps invariant:
`platformBpsApplied + orgBpsApplied + consultantBpsApplied === 10000`.

---

## Case CE.4: Future contract untouched

### Preconditions
INSERT a Contract with `effectiveTo = NOW() + INTERVAL '30 days'`,
status ACTIVE.

### Steps
Run the cron.

### Assertions
```sql
SELECT status FROM "Contract" WHERE id = '<future-contractId>';
-- Expected: 'ACTIVE'
```

No new audit row for this contract.

---

## Case CE.5: TERMINATED / DRAFT untouched

### Preconditions
Two more contracts: one TERMINATED with `effectiveTo` in the past, one
DRAFT with `effectiveTo` in the past.

### Steps
Run the cron.

### Assertions
Both rows: status unchanged. The cron's `WHERE` clause must scope to
`status = 'ACTIVE'` only — TERMINATED/DRAFT are terminal/pre-active and
shouldn't transition.

**Regression signal:** if the cron flips TERMINATED → EXPIRED, that's a
status-machine violation (a TERMINATED contract is a deliberate kill,
not an organic expiry). NON-TRIVIAL fix to `jobs/compliance/contract-expiry.ts`
— ASK before changing.

---

## Cross-case summary assertion

```sql
SELECT status, count(*) FROM "Contract"
WHERE "organizationId" = '<orgId>'
GROUP BY status;
-- Expected: ACTIVE=1 (future), EXPIRED=1 (CE.1), TERMINATED=1 (CE.5), DRAFT=1 (CE.5)
```
