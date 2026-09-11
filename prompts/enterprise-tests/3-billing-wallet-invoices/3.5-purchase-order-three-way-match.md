# 3-billing-wallet-invoices — Purchase order 3-way match

> **Required reading:** [`_shared/shared-setup.md`](../_shared/shared-setup.md),
> [`_shared/mcp-recipes.md`](../_shared/mcp-recipes.md),
> [`_shared/case-template.md`](../_shared/case-template.md).
> Apply the **fix-and-retest gate** when any case fails.

**Surface(s) under test:**
- `app/api/organizations/[orgId]/purchase-orders/route.ts` — POST (issue PO)
- `app/api/organizations/[orgId]/purchase-orders/[poId]/route.ts` — PATCH (status changes)
- `app/api/organizations/[orgId]/billing-account/invoices/route.ts` — POST with `purchaseOrderId`
- `prisma/schema.prisma model PurchaseOrder` — `@@unique([organizationId, poNumber])`, `totalAmountPaise`, `remainingAmountPaise`

**Case roster:**
1. **PO.1** — Create PO with totalAmountPaise
2. **PO.2** — Issue invoice referencing PO; remainingAmountPaise decrements
3. **PO.3** — Reject invoice when PO is INACTIVE / TERMINATED
4. **PO.4** — Reject invoice exceeding PO remaining balance → 409
5. **PO.5** — Reject duplicate poNumber (unique on (orgId, poNumber))

---

## Common preconditions

Wipro INVOICE-funded. OWNER session.

Cleanup:
```sql
DELETE FROM "OrganizationInvoice" WHERE "purchaseOrderId" IN (
  SELECT id FROM "PurchaseOrder" WHERE "organizationId" = '<wipro-id>' AND "poNumber" LIKE 'TEST-PO-%'
);
DELETE FROM "PurchaseOrder" WHERE "organizationId" = '<wipro-id>' AND "poNumber" LIKE 'TEST-PO-%';
```

---

## Case PO.1: Create PO

```js
() => fetch("/api/organizations/<wipro-id>/purchase-orders", {
  method: "POST", credentials: "include",
  headers: {"Content-Type": "application/json"},
  body: JSON.stringify({
    poNumber: "TEST-PO-001",
    totalAmountPaise: 1000000,
    validUntil: "2027-12-31T00:00:00Z"
  })
}).then(async r => ({ status: r.status, body: await r.json() }))
```

### Assertions
- `status === 201`
- DB row: `totalAmountPaise = 1000000`, `remainingAmountPaise = 1000000`, `status = 'ACTIVE'`.
- Audit: `PO_CREATED` (verify literal in `audit-actions.ts`).

---

## Case PO.2: Issue invoice referencing PO

POST an invoice with `items` summing to 400000 paise, link to the PO via `purchaseOrderId`.

### Assertions
- Invoice row created.
- `PurchaseOrder.remainingAmountPaise` decremented by 400000:
  ```sql
  SELECT "totalAmountPaise", "remainingAmountPaise" FROM "PurchaseOrder" WHERE id = '<poId>';
  -- Expected: 1000000, 600000
  ```

---

## Case PO.3: INACTIVE / TERMINATED PO

Set the PO to status = TERMINATED:
```sql
UPDATE "PurchaseOrder" SET status = 'TERMINATED' WHERE id = '<poId>';
```

Attempt to issue another invoice against it.

### Assertions
- `status === 409`
- Body mentions PO status.

---

## Case PO.4: Exceed remaining balance

Reset PO to ACTIVE. Attempt an invoice for 700000 (remaining was 600000).

### Assertions
- `status === 409`
- Body mentions `PO_LIMIT_EXCEEDED` or remaining balance.

---

## Case PO.5: Duplicate poNumber

POST another PO with `poNumber: "TEST-PO-001"` (same as PO.1).

### Assertions
- `status === 409` (P2002 caught and translated, or unique constraint surfaces).
- No new row.

The unique key is `(organizationId, poNumber)` — so a different org can
use the same poNumber. Verify by repeating the POST against IIT Madras
or LearnPro with the same number → 201.
