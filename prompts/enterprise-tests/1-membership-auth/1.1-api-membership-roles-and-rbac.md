# 1-membership-auth — API: membership roles + RBAC

> **Required reading:** [`_shared/shared-setup.md`](../_shared/shared-setup.md),
> [`_shared/mcp-recipes.md`](../_shared/mcp-recipes.md),
> [`_shared/case-template.md`](../_shared/case-template.md).
> Apply the **fix-and-retest gate** when any case fails.

**Surface(s) under test:**
- `app/api/organizations/[orgId]/invitations/route.ts` — POST invite
- `app/api/organizations/invitations/accept/route.ts` — POST accept (atomic claim)
- `app/api/organizations/[orgId]/members/[memberId]/route.ts` — PATCH role/status, DELETE
- `lib/auth-helpers.ts` — `requireOrgAccess(orgId, minRole)`, `ORG_ROLE_RANK`
- `lib/enterprise/role-transitions.ts` — `isBlockedRoleTransition` (LEARNER ↔ EXPERT disjoint rule)

**Case roster:**
1. **R.1** — Invite LEARNER (happy)
2. **R.2** — Accept invitation (atomic claim, idempotent)
3. **R.3** — Role rank gate: MANAGER cannot promote to OWNER
4. **R.4** — Last-OWNER demotion guard
5. **R.5** — Disjoint LEARNER ↔ EXPERT transition rejected
6. **R.6** — Cross-org IDOR: Wipro MAINTAINER cannot mutate IIT Madras
7. **R.7** — Unauth: missing session → 401 on every route

---

## Common preconditions

Use Wipro from the seed cohort. Login as `founder@wipro.test` (OWNER).
Capture `<wipro-id>` and OWNER session.

For R.4, ensure exactly one OWNER exists in Wipro (the seed founder).
For R.6, capture IIT Madras's `<iit-id>` and one of its memberships.

Cleanup at end:
```sql
DELETE FROM "Invitation" WHERE "organizationId" = '<wipro-id>'
  AND email LIKE 'test-r-%@familiarise.test';
DELETE FROM "Membership" WHERE "organizationId" = '<wipro-id>'
  AND "userId" IN (SELECT id FROM users WHERE email LIKE 'test-r-%@familiarise.test');
DELETE FROM users WHERE email LIKE 'test-r-%@familiarise.test';
```

---

## Case R.1: Invite LEARNER

```js
() => fetch("/api/organizations/<wipro-id>/invitations", {
  method: "POST", credentials: "include",
  headers: {"Content-Type": "application/json"},
  body: JSON.stringify({ email: "test-r-1@familiarise.test", role: "LEARNER" })
}).then(async r => ({ status: r.status, body: await r.json() }))
```

### Assertions
- `status === 201`
- `Invitation` row: `email`, `role='LEARNER'`, `status='pending'`, `expiresAt` ~7 days.
- Audit: `MEMBER_INVITED`.

---

## Case R.2: Accept invitation (atomic)

Sign up `test-r-1@familiarise.test` via Chrome MCP. Then call accept:
```js
() => fetch("/api/organizations/invitations/accept", {
  method: "POST", credentials: "include",
  headers: {"Content-Type": "application/json"},
  body: JSON.stringify({ token: "<invitation-token>" })
}).then(async r => ({ status: r.status, body: await r.json() }))
```

### Assertions
- `status === 200`
- `Membership` row exists: `role='LEARNER'`, `status='ACTIVE'`.
- `Invitation.status === 'accepted'`.
- Audit: `INVITATION_ACCEPTED`.

**Idempotency:** call accept twice. Second call returns 409 or 200 with
"already accepted" (verify the route's contract — it uses
`updateMany WHERE status='pending'` for atomicity).

---

## Case R.3: Role rank gate

Promote a separate user to MANAGER. As MANAGER, attempt to promote a
LEARNER to OWNER:
```js
() => fetch("/api/organizations/<wipro-id>/members/<learnerMembershipId>", {
  method: "PATCH", credentials: "include",
  headers: {"Content-Type": "application/json"},
  body: JSON.stringify({ role: "OWNER" })
}).then(async r => ({ status: r.status, body: await r.json() }))
```

### Assertions
- `status === 403`
- Body mentions role rank / permission insufficient.
- DB membership row unchanged.

---

## Case R.4: Last-OWNER demotion guard

As the sole Wipro OWNER, attempt to demote yourself to MAINTAINER:
```js
() => fetch("/api/organizations/<wipro-id>/members/<self-membership-id>", {
  method: "PATCH", credentials: "include",
  headers: {"Content-Type": "application/json"},
  body: JSON.stringify({ role: "MAINTAINER" })
}).then(async r => ({ status: r.status, body: await r.json() }))
```

### Assertions
- `status === 409`
- Body mentions "last OWNER" or "must have at least one OWNER."
- DB unchanged.

---

## Case R.5: LEARNER ↔ EXPERT disjoint rule

The rule (`lib/enterprise/role-transitions.ts`): a LEARNER cannot be
promoted directly to EXPERT, and vice versa, unless the org is HYBRID
or specific membership flags allow it.

Attempt the disallowed transition on Wipro (SPONSOR-only). Expect 409.

Then try the same on a HYBRID org (`learnpro-academy` from seed) —
expect 200.

### Assertions
- Wipro: 409 with code `ROLE_TRANSITION_BLOCKED`.
- LearnPro: 200, membership role updated.

---

## Case R.6: Cross-org IDOR

As Wipro MAINTAINER, attempt to PATCH a Membership row whose
`organizationId = <iit-id>`:
```js
() => fetch("/api/organizations/<iit-id>/members/<iit-member-id>", {
  method: "PATCH", credentials: "include",
  headers: {"Content-Type": "application/json"},
  body: JSON.stringify({ role: "LEARNER" })
}).then(async r => ({ status: r.status, body: await r.json() }))
```

### Assertions
- `status === 403`
- Body: "Not a member" or similar.
- DB IIT membership unchanged.

---

## Case R.7: Unauth → 401

```js
() => fetch("/api/organizations/<wipro-id>/members", { credentials: "omit" })
  .then(async r => ({ status: r.status }))
```
Expected: 401.

Repeat for `POST /invitations`, `PATCH /members/[id]`, `DELETE /members/[id]`.
All 401 when `credentials: 'omit'`.
