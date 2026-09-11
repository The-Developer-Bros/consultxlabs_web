# 5-compliance-audit — Audit log + ledger reconciliation

> **Required reading:** [`_shared/shared-setup.md`](../_shared/shared-setup.md),
> [`_shared/mcp-recipes.md`](../_shared/mcp-recipes.md),
> [`_shared/case-template.md`](../_shared/case-template.md).
> Apply the **fix-and-retest gate** when any case fails.

**Surface(s) under test:**
- `prisma/schema.prisma model OrgAuditLog` — 10-category audit
- `lib/enterprise/audit-actions.ts` — well-known action literals
- `jobs/reconcile/reconcile-ledgers.ts` + `scripts/reconcile/reconcile-ledgers.ts` — nightly reconciler
- `app/api/admin/reconcile-ledgers/route.ts` — on-demand admin trigger
- The three ledgers: `UsageLedgerEntry`, `FundingLedgerEntry`, `SettlementLedgerEntry`

**Case roster:**
1. **A.1** — Every mutating route emits an audit row (sample 5 routes)
2. **A.2** — Audit-log filter / pagination contract works
3. **A.3** — Nightly reconcile job: ok=true on a healthy DB
4. **A.4** — Inject a discrepancy → reconcile flags it via `findings` JSON
5. **A.5** — Reconcile report is immutable (cannot UPDATE)

---

## Common preconditions

Run the existing happy paths from other case files first to seed
audit + ledger rows. Or spawn a fresh test org and walk through:
create → invite → contract → program → invoice → payout.

Cleanup: reconciliation reports are append-only; don't try to delete
them. Test orgs cleaned via prefix.

---

## Case A.1: Audit emission on mutating routes

Hit each of these mutating endpoints, then assert one new
`OrgAuditLog` row exists:

| Route | Method | Expected `action` |
|---|---|---|
| `/api/organizations` | POST | `ORG_CREATED` |
| `/api/organizations/[orgId]/invitations` | POST | `MEMBER_INVITED` |
| `/api/organizations/[orgId]/members/[id]` | PATCH | `MEMBER_ROLE_CHANGED` |
| `/api/organizations/[orgId]/billing-account/invoices` | POST | `INVOICE_ISSUED` |
| `/api/organizations/[orgId]/payouts` | POST | `PAYOUT_INITIATED` |

For each:
```sql
SELECT count(*) FROM "OrgAuditLog"
WHERE "organizationId" = '<orgId>'
  AND action = '<EXPECTED_ACTION>'
  AND "createdAt" > NOW() - INTERVAL '1 minute';
-- Expected: >= 1
```

**Regression signal:** if any mutating route fails to emit, the route
handler is missing the audit-log `create` call. TRIVIAL fix per
endpoint (just add the emission), but verify the literal exists in
`lib/enterprise/audit-actions.ts`.

---

## Case A.2: Audit-log filter / pagination

```js
() => fetch("/api/organizations/<orgId>/audit?action=PROGRAM_CREATED&limit=10", { credentials: "include" })
  .then(async r => ({ status: r.status, body: await r.json() }))
```

### Assertions
- `status === 200`
- `body.data` is an array, length ≤ 10, every row's `action` matches `PROGRAM_CREATED`.
- `body.pagination` carries `nextCursor` if more rows exist.

CSV export (audit dashboard):
```
GET /api/organizations/<orgId>/audit?format=csv&action=...
```
Expected: 200 with `Content-Type: text/csv`. Cap: 200,000 rows
(`docs/enterprise/24-monitoring.md` reference).

---

## Case A.3: Reconcile ok=true on healthy DB

```bash
npx tsx jobs/reconcile/reconcile-ledgers.ts
```

Watch stdout / DB:
```sql
SELECT id, ok, summary, findings, "durationMs", "createdAt"
FROM ledger_reconciliation_reports
ORDER BY "createdAt" DESC LIMIT 1;
-- Expected: ok = true, findings = '[]' or null, durationMs > 0
```

The reconciler covers:
- Wallet balance vs FundingLedgerEntry sum
- Funding mirror (Wallet ↔ Funding consistency)
- Settlement coverage
- Program-assignment engagement-counter drift (check E)

---

## Case A.4: Injected discrepancy

Pick a non-production org. Manually drift a balance:
```sql
UPDATE "BillingAccount" SET "walletBalance" = "walletBalance" + 99999
WHERE "ownerOrgId" = '<test-orgId>';
```

Run the reconciler. Expected:
```sql
SELECT ok, findings FROM ledger_reconciliation_reports ORDER BY "createdAt" DESC LIMIT 1;
-- Expected: ok = false, findings includes the drifted org with a wallet-vs-ledger delta
```

Restore the balance:
```sql
UPDATE "BillingAccount" SET "walletBalance" = "walletBalance" - 99999
WHERE "ownerOrgId" = '<test-orgId>';
```

---

## Case A.5: Reconcile report immutability

```sql
UPDATE ledger_reconciliation_reports SET ok = false WHERE id = '<recent-id>';
```

Expected: should fail at the DB level (immutability rule). If it
succeeds, the immutability invariant isn't enforced — TODO per
`docs/enterprise/18-three-ledger-discipline.md` #688 SC-3.

Document the gap. **Don't** apply a fix in-flight — adding a trigger is
NON-TRIVIAL (touches DB-level constraints). ASK before doing the
follow-up.
