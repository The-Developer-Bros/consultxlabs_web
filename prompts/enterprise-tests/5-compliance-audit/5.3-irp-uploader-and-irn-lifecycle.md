# 5-compliance-audit — IRP uploader + IRN lifecycle

> **Required reading:** [`_shared/shared-setup.md`](../_shared/shared-setup.md),
> [`_shared/mcp-recipes.md`](../_shared/mcp-recipes.md),
> [`_shared/case-template.md`](../_shared/case-template.md).
> Apply the **fix-and-retest gate** when any case fails.

**Surface(s) under test:**
- `jobs/compliance/irp-uploader.ts` — daily 02:30 UTC cron
- `lib/compliance/irp.ts:generateIrn` — ClearTax connector (env-gated)
- `prisma/schema.prisma model OrganizationInvoice` — `irn`, `ackNumber`, `ackDate`, `signedQrPayload`, `irpStatus`, `irpRetryCount`, `irpLastError`, `irpLastAttemptAt`
- `prisma/schema.prisma enum IrpStatus` — `PENDING | GENERATED | CANCELLED | FAILED`

**Case roster:**
1. **IRP.1** — Cron picks up PENDING invoices within 30-day window
2. **IRP.2** — Env unset → status flips to FAILED with sensible reason
3. **IRP.3** — Env set but invalid creds → retry with `irpRetryCount` increment
4. **IRP.4** — Cron skips already-GENERATED invoices
5. **IRP.5** — Manual trigger for a single invoice (if route exists)

---

## Common preconditions

Use Wipro. Issue 3 fresh ISSUED invoices via the API route (see
`api-wallet-top-up-and-invoices.md` case W.5).

Cleanup:
```sql
UPDATE "OrganizationInvoice" SET "irpStatus" = 'PENDING',
  "irpRetryCount" = 0, "irpLastError" = NULL, "irpLastAttemptAt" = NULL,
  irn = NULL, "ackNumber" = NULL, "ackDate" = NULL, "signedQrPayload" = NULL
WHERE id IN (<test-invoice-ids>);
```

---

## Case IRP.1: Cron picks up PENDING invoices

### Steps
```bash
npx tsx jobs/compliance/irp-uploader.ts
```

### Assertions
Cron stdout shows iteration over PENDING invoices within the 30-day
window. Each test invoice should appear in the log.

Without ClearTax credentials configured, the rows transition:
```sql
SELECT "irpStatus", "irpRetryCount", "irpLastError", "irpLastAttemptAt"
FROM "OrganizationInvoice" WHERE id = '<test-invoice-id>';
```

Expected:
- `irpStatus = 'FAILED'` after the retry cap is hit (typically 12 per the cron's docblock)
- `irpRetryCount > 0`
- `irpLastError` contains a string referencing missing env / stub status

OR if credentials are set:
- `irpStatus = 'GENERATED'`
- `irn` populated (64-char string)
- `ackNumber`, `ackDate`, `signedQrPayload` populated

---

## Case IRP.2: Env unset → FAILED (graceful)

ASK the user to confirm `CLEARTAX_API_KEY` is unset. Run cron.

### Assertions
- All test invoices land on `irpStatus = 'FAILED'` after the retry cap.
- No crash; cron exits 0.
- `irpLastError` mentions "STUB" or "missing credentials."

**Regression signal:** if the cron crashes / exits non-zero when creds
are missing, the env-gated path is broken. NON-TRIVIAL — ASK.

---

## Case IRP.3: Invalid creds → retry behavior

Set `CLEARTAX_API_KEY=invalid-key`. Run cron.

### Assertions
- `irpStatus` may oscillate between `PENDING` and `FAILED` across runs;
  `irpRetryCount` increments by 1 per cron invocation up to the cap
  (12).
- Once `irpRetryCount` reaches the cap, `irpStatus = 'FAILED'`
  permanently (no further retries).
- `irpLastError` mirrors the ClearTax 4xx response shape.

---

## Case IRP.4: Cron skips GENERATED invoices

After IRP.1 produces a `GENERATED` row (if creds set), re-run cron.

### Assertions
```sql
SELECT "irpStatus", "irpRetryCount" FROM "OrganizationInvoice" WHERE id = '<generated-invoice-id>';
-- Expected: same irpStatus='GENERATED', irpRetryCount unchanged (cron's WHERE filters to PENDING only)
```

---

## Case IRP.5: Manual single-invoice trigger

If an admin route exists at `/api/admin/invoices/[id]/upload-irp` (or
similar), trigger it for a single invoice. Otherwise mark this case as
**deferred** until that route ships.

Document the gap.
