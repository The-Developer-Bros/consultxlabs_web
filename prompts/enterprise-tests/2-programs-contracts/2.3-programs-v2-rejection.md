# 2-programs-contracts — Programs v2 rejection

> **Required reading:** [`_shared/shared-setup.md`](../_shared/shared-setup.md),
> [`_shared/mcp-recipes.md`](../_shared/mcp-recipes.md),
> [`_shared/case-template.md`](../_shared/case-template.md).
> Apply the **fix-and-retest gate** when any case fails.

**Surface(s) under test:**
- `app/api/organizations/[orgId]/programs/route.ts` — `ProgramsV2AttemptSchema` pre-Zod check + `CreateBodySchema` discriminated union

**Round-3 invariant — see shared-setup §4:** "Programs v2 reject — POST with `type=PROJECT` or `type=RETAINER` → 400 `code: "PROGRAM_TYPE_NOT_AVAILABLE"`. Other invalid bodies → 400 with no code."

**Case roster:**
1. **V.1** — PROJECT → typed 400
2. **V.2** — RETAINER → typed 400
3. **V.3** — garbage `type` → generic 400 (no v2 code)
4. **V.4** — PROJECT with extra passthrough fields → still typed 400

There's a Jest unit test at `__tests__/enterprise/programs-v2-rejection.test.ts`. This MCP file exercises the **live HTTP boundary** + the **audit-log side effect** (no row should be written on a rejected payload).

---

## Common preconditions

Use the seed cohort. Login as `founder@wipro.test` (Wipro is SPONSOR, has
an active `Contract`). Fetch the contract id once:

```ts
mcp__supabase__execute_sql({
  project_id: "pzmbxqdgibfkhjwzeprf",
  query: `
    SELECT c.id, c.status, ba."fundingSource"
    FROM "Contract" c
    JOIN "BillingAccount" ba ON ba.id = c."billingAccountId"
    WHERE c."organizationId" = (SELECT id FROM "organizations" WHERE slug = 'wipro')
      AND c.status = 'ACTIVE'
    LIMIT 1;
  `
})
// Capture: <contractId>, <fundingSource>
```

Get the Wipro org id:
```sql
SELECT id FROM "organizations" WHERE slug = 'wipro';
```

Snapshot audit-log count before each case:
```sql
SELECT count(*) AS before_count FROM "OrgAuditLog"
WHERE "organizationId" = '<wipro-id>' AND action = 'PROGRAM_CREATED';
```

---

## Case V.1: PROJECT → 400 PROGRAM_TYPE_NOT_AVAILABLE

### Steps
From a Chrome session logged in as Wipro OWNER:

```
mcp__chrome-devtools__evaluate_script({
  function: `
    () => fetch("/api/organizations/<wipro-id>/programs", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "PROJECT",
        contractId: "<contractId>",
        name: "v2 engagement test"
      })
    }).then(async r => ({ status: r.status, body: await r.json() }))
  `
})
```

### Assertions
- `status === 400`
- `body.code === "PROGRAM_TYPE_NOT_AVAILABLE"`
- `body.error` contains the string `"PROJECT"`
- No `Program` row created:
  ```sql
  SELECT count(*) FROM "Program"
  WHERE "contractId" = '<contractId>' AND name = 'v2 engagement test';
  -- Expected: 0
  ```
- No `OrgAuditLog` row with action `PROGRAM_CREATED` since `before_count`:
  ```sql
  SELECT count(*) FROM "OrgAuditLog"
  WHERE "organizationId" = '<wipro-id>' AND action = 'PROGRAM_CREATED';
  -- Expected: == before_count
  ```

### Done when
- [ ] All assertions pass
- [ ] No row written for the rejected payload

---

## Case V.2: RETAINER → 400 PROGRAM_TYPE_NOT_AVAILABLE

Same shape as V.1 with `type: "RETAINER"`. Assert:
- `status === 400`
- `body.code === "PROGRAM_TYPE_NOT_AVAILABLE"`
- `body.error` contains the string `"RETAINER"`
- No `Program` row; no `PROGRAM_CREATED` audit row.

---

## Case V.3: Garbage `type` → generic 400

POST `{ type: "GARBAGE", contractId: "<contractId>", name: "garbage" }`.

### Assertions
- `status === 400`
- `body.error === "Invalid body"`
- `body.code` is undefined (this case must NOT match the v2 path)
- `body.detail` is a Zod flattened-error shape (`fieldErrors`, `formErrors`)
- No `Program` row; no audit row.

**Regression signal:** if `body.code === "PROGRAM_TYPE_NOT_AVAILABLE"`,
the v2 pre-check is too eager (matching non-v2 garbage). NON-TRIVIAL fix
to `app/api/organizations/[orgId]/programs/route.ts` — ASK before
applying.

---

## Case V.4: PROJECT with extra passthrough fields

```json
{
  "type": "PROJECT",
  "contractId": "<contractId>",
  "name": "v2 passthrough",
  "milestones": [{ "name": "M1", "amountPaise": 100000 }],
  "kickoffDate": "2026-06-01"
}
```

### Assertions
Same as V.1. The `ProgramsV2AttemptSchema` uses `.passthrough()` so
extra fields don't disrupt the match.

**Regression signal:** if extra fields cause the v2 check to fall
through to Zod (returning `body.error === "Invalid body"` instead of
the typed code), the schema needs `.passthrough()`. TRIVIAL one-line
fix.

---

## Cross-case assertion (run once after all 4)

```sql
SELECT count(*) FROM "Program"
WHERE name IN ('v2 engagement test', 'garbage', 'v2 passthrough')
  OR name = 'v2 retainer test';
-- Expected: 0 (no Program row should exist from any of the rejected POSTs)
```

Also confirm no audit-log noise:
```sql
SELECT count(*) FROM "OrgAuditLog"
WHERE "organizationId" = '<wipro-id>'
  AND action = 'PROGRAM_CREATED'
  AND "createdAt" > NOW() - INTERVAL '10 minutes';
-- Expected: 0 (or equal to before_count from preconditions if other actors are creating programs)
```
