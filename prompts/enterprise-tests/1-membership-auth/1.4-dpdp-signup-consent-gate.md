# 1-membership-auth — DPDP signup consent gate

> **Required reading:** [`_shared/shared-setup.md`](../_shared/shared-setup.md),
> [`_shared/mcp-recipes.md`](../_shared/mcp-recipes.md),
> [`_shared/case-template.md`](../_shared/case-template.md).
> Apply the **fix-and-retest gate** when any case fails.

**Surface(s) under test:**
- `lib/auth.ts` — `databaseHooks.user.create.after` stamps two `ConsentArtifact` rows at signup
- `actions/stream/chat/user.action.ts:upsertUserToStream` — fail-closes on missing `STREAM_DATA_PROCESSING` consent
- `actions/stream/chat/user.action.ts:upsertUsersToStream` — batch path drops non-consenters, logs the dropped userId
- `lib/compliance/dpdp.ts:checkConsent` — the predicate; `buildConsentArtifact` — the SHA-256 + 7y-retention writer

**Round-3 invariant — see shared-setup §4:** "DPDP signup consent — BetterAuth `user.create.after` stamps `ConsentArtifact` for `PRIMARY_PROCESSING` + `STREAM_DATA_PROCESSING` (SHA-256 hash, 7y retention). `upsertUserToStream` / `upsertUsersToStream` fail-close on missing/withdrawn `STREAM_DATA_PROCESSING`."

**Case roster:**
1. **D.1** — Signup stamps both ConsentArtifact rows with valid hash + retention
2. **D.2** — Stream upsert succeeds for a consenting user
3. **D.3** — Stream upsert fail-closes for a withdrawn user
4. **D.4** — Batch upsert drops non-consenters, keeps consenters
5. **D.5** — No double-stamping on the SIGNUP path

---

## Case D.1: Signup stamps both ConsentArtifact rows

### Preconditions
A fresh email not present in `users`:
```ts
mcp__supabase__execute_sql({
  project_id: "pzmbxqdgibfkhjwzeprf",
  query: `SELECT count(*) FROM users WHERE email = 'test-dpdp-d1@familiarise.test';`
})
// Expected: count = 0
```

### Steps
1. `mcp__chrome-devtools__navigate_page("http://localhost:3000/auth/signup")`
2. `mcp__chrome-devtools__take_snapshot()` — find email/password/name input uids
3. `mcp__chrome-devtools__fill_form({ elements: [
       { uid: <name>, value: "DPDP Test One" },
       { uid: <email>, value: "test-dpdp-d1@familiarise.test" },
       { uid: <password>, value: "TestPassword123!" }
   ]})`
4. `mcp__chrome-devtools__click({ uid: <signup-button> })`
5. `mcp__chrome-devtools__wait_for({ text: "onboarding" })` — confirms signup landed
6. `mcp__chrome-devtools__take_snapshot()`

### Assertions

**DB — both consent artifacts written:**
```sql
SELECT id, "purposeCodes", "dataFiduciary", language, version, hash,
       "auditRetainedUntil", "grantedAt", "withdrawnAt"
FROM "ConsentArtifact"
WHERE "userId" = (SELECT id FROM users WHERE email = 'test-dpdp-d1@familiarise.test')
ORDER BY "grantedAt";
```
Expected: **2 rows**.
- Row 1: `purposeCodes = ARRAY['PRIMARY_PROCESSING']`, `dataFiduciary = 'Familiarise'`, `language = 'en-IN'`, `version = 1`, `hash` is 64 hex chars (SHA-256), `withdrawnAt IS NULL`, `auditRetainedUntil = grantedAt + 7 years` (±1 day).
- Row 2: same shape with `purposeCodes = ARRAY['STREAM_DATA_PROCESSING']`.

**DB — predicate returns true for both purposes:**
```sql
-- Mirror lib/compliance/dpdp.ts:checkConsent logic
SELECT EXISTS (
  SELECT 1 FROM "ConsentArtifact"
  WHERE "userId" = (SELECT id FROM users WHERE email = 'test-dpdp-d1@familiarise.test')
    AND "purposeCodes" @> ARRAY['PRIMARY_PROCESSING']::text[]
    AND "withdrawnAt" IS NULL
    AND "auditRetainedUntil" > NOW()
) AS primary_ok,
EXISTS (
  SELECT 1 FROM "ConsentArtifact"
  WHERE "userId" = (SELECT id FROM users WHERE email = 'test-dpdp-d1@familiarise.test')
    AND "purposeCodes" @> ARRAY['STREAM_DATA_PROCESSING']::text[]
    AND "withdrawnAt" IS NULL
    AND "auditRetainedUntil" > NOW()
) AS stream_ok;
```
Expected: both `true`.

**Console:** `mcp__chrome-devtools__list_console_messages()` — no `[AUTH_HOOK] DPDP consent stamp error` log. If present, the hook caught an exception silently — that's a P0 bug.

**Network:** `mcp__chrome-devtools__list_network_requests()` — `/api/auth/sign-up/email` returned 200; no parallel call to `/api/organizations/.../consent` (signup must not call the org-consent route — it's BetterAuth-internal).

### Cleanup
```sql
DELETE FROM "ConsentArtifact" WHERE "userId" = (SELECT id FROM users WHERE email = 'test-dpdp-d1@familiarise.test');
DELETE FROM users WHERE email = 'test-dpdp-d1@familiarise.test';
```

### Done when
- [ ] 2 ConsentArtifact rows present with correct shape
- [ ] checkConsent-equivalent predicate returns true for both
- [ ] No console error from the auth hook
- [ ] Cleanup completed

---

## Case D.2: Stream upsert succeeds for a consenting user

### Preconditions
Reuse Case D.1's signup but without cleanup. (Or run D.1 then immediately D.2 in sequence.)

```sql
SELECT id FROM users WHERE email = 'test-dpdp-d1@familiarise.test';
-- Expected: 1 row
```

### Steps
1. From Chrome, log in as `test-dpdp-d1@familiarise.test` (see `mcp-recipes.md §Login-as-OWNER` recipe).
2. Navigate to any page that triggers `upsertUserToStream` — easiest is opening a meeting URL or any page hosting `<StreamProvider>`. `mcp__chrome-devtools__navigate_page("http://localhost:3000/dashboard")` suffices because the dashboard layout mounts the Stream provider for authed users.
3. `mcp__chrome-devtools__wait_for({ text: "Dashboard" })`
4. `mcp__chrome-devtools__take_snapshot()`

### Assertions
**Stream side:**
```ts
mcp__streamio__chat_query_users({
  filter_conditions: { id: { $eq: "<userId-from-D.1>" } }
})
// Expected: 1 user returned, matching the signup name + email
```

**Console:** No `Refusing Stream upsert — STREAM_DATA_PROCESSING consent absent` warn log.

### Cleanup
Same as D.1 plus:
```ts
mcp__streamio__chat_query_users(...)  // confirm cleanup
// (Stream's CRUD MCP may not have a delete-user method; leaving the Stream user is acceptable since the userId is namespaced to test-dpdp-d1.)
```

### Done when
- [ ] Stream user exists matching the signup
- [ ] No fail-closed warn log

---

## Case D.3: Stream upsert fail-closes for a withdrawn user

### Preconditions
Reuse D.1's user. Withdraw consent via direct DB update (simulates an in-app withdrawal):
```sql
UPDATE "ConsentArtifact"
   SET "withdrawnAt" = NOW()
 WHERE "userId" = (SELECT id FROM users WHERE email = 'test-dpdp-d1@familiarise.test')
   AND "purposeCodes" @> ARRAY['STREAM_DATA_PROCESSING']::text[];
-- Expected: 1 row updated
```

Then clear Stream cache so `isUserSynced` doesn't short-circuit:
```ts
// Restart dev server OR wait > stream-cache TTL; alternatively, the next
// upsert will reuse the cache and skip the check. To force fresh:
// (a) ask the user to restart `npm run dev`, OR
// (b) call upsertUserToStream from a fresh process (e.g. a script entry).
```

For this case, the simplest path is (a). Document the restart as part of
the case in the case-runner's checklist.

### Steps
1. Restart `npm run dev` (ASK the user; do not auto-restart).
2. Log in as `test-dpdp-d1@familiarise.test` again.
3. Trigger Stream upsert via dashboard navigation.
4. Observe the error UI / toast (current UX is a thrown error surfaced as a generic boundary; the case asserts the underlying server log + a sensible UI fallback).

### Assertions
**Console:**
```ts
mcp__chrome-devtools__list_console_messages()
```
Expected: a `warn` entry mentioning `Refusing Stream upsert — STREAM_DATA_PROCESSING consent absent` with `userId` matching D.1.

**Server-side:** the `upsertUserToStream` action throws with the message `"Stream video/chat consent is required. Please re-grant data processing consent under Account → Privacy."` This surfaces as a 500 on the relevant API endpoint, or as a React error-boundary UI; either is acceptable as long as the user never silently lands in a chat session.

**DB:**
```sql
SELECT "withdrawnAt" FROM "ConsentArtifact"
WHERE "userId" = (...)
  AND "purposeCodes" @> ARRAY['STREAM_DATA_PROCESSING']::text[];
-- Expected: withdrawnAt IS NOT NULL (still withdrawn after the failed upsert)
```

### Fix-and-retest signals
- If Stream upsert *succeeds* despite withdrawn consent → `checkConsent` returned true incorrectly. Bug in `lib/compliance/dpdp.ts` predicate (NON-TRIVIAL — touches compliance). STOP and ASK.
- If the UI shows a successful chat session → the fail-closed path is bypassed somewhere. Bug surface includes `actions/stream/chat/user.action.ts` + every caller. STOP and ASK.

### Cleanup
```sql
DELETE FROM "ConsentArtifact" WHERE "userId" = (SELECT id FROM users WHERE email = 'test-dpdp-d1@familiarise.test');
DELETE FROM users WHERE email = 'test-dpdp-d1@familiarise.test';
```

### Done when
- [ ] Warn log captured with the correct userId
- [ ] Stream user upsert did not proceed (verify via `mcp__streamio__chat_query_users` — user should match D.2's state, no new updates)
- [ ] Cleanup completed

---

## Case D.4: Batch upsert drops non-consenters, keeps consenters

### Preconditions
Spawn two test users via signup (D.1 pattern), then withdraw STREAM consent for exactly one of them:

```sql
-- User A: consent intact
-- User B: withdraw STREAM
UPDATE "ConsentArtifact"
   SET "withdrawnAt" = NOW()
 WHERE "userId" = (SELECT id FROM users WHERE email = 'test-dpdp-d4b@familiarise.test')
   AND "purposeCodes" @> ARRAY['STREAM_DATA_PROCESSING']::text[];
```

### Steps
1. From any Chrome session, trigger a code path that calls
   `upsertUsersToStream([userA, userB])`. The simplest is creating a
   chat channel that lists both users via the existing channel-action
   wrapper at `actions/stream/chat/channel.action.ts`.
2. (If the UI doesn't reach this code path easily, use
   `mcp__chrome-devtools__evaluate_script` to POST a server action that
   triggers the batch upsert. Document the action used in the case run.)

### Assertions
**Console:** A `warn` log: `Batch upsert dropping users missing STREAM_DATA_PROCESSING consent` with `droppedIds` containing exactly User B's id and `droppedCount: 1`.

**Stream side:**
```ts
mcp__streamio__chat_query_users({
  filter_conditions: { id: { $in: ["<userA-id>", "<userB-id>"] } }
})
// Expected: only User A appears; User B absent (or unchanged from any prior state — verify no NEW upsert touched it).
```

**DB:** Both ConsentArtifact rows still as set in Preconditions — the batch upsert must not mutate consent state.

### Fix-and-retest signals
- Both users appear in Stream → fail-closed batch path is broken (NON-TRIVIAL — touches `actions/stream/chat/user.action.ts`). ASK before fixing.
- Neither user appears → consenter A was incorrectly dropped. Bug in the filter logic. ASK before fixing.

### Cleanup
```sql
DELETE FROM "ConsentArtifact" WHERE "userId" IN (
  SELECT id FROM users WHERE email IN ('test-dpdp-d4a@familiarise.test', 'test-dpdp-d4b@familiarise.test')
);
DELETE FROM users WHERE email IN ('test-dpdp-d4a@familiarise.test', 'test-dpdp-d4b@familiarise.test');
```

### Done when
- [ ] Warn log captured naming User B specifically
- [ ] Stream side shows only User A
- [ ] Cleanup completed

---

## Case D.5: No double-stamping on the SIGNUP path

This case is a regression guard. The signup hook must not write
ConsentArtifact rows on *every* User update — only on creation.

### Preconditions
Fresh user from D.1 pattern: `test-dpdp-d5@familiarise.test` with the 2
ConsentArtifact rows already stamped.

```sql
SELECT count(*) FROM "ConsentArtifact"
WHERE "userId" = (SELECT id FROM users WHERE email = 'test-dpdp-d5@familiarise.test');
-- Expected: 2
```

### Steps
1. Trigger a User update via the UI — easiest is editing the display
   name on the profile page (or any settings save). `mcp__chrome-devtools__navigate_page`
   + take_snapshot + fill_form + click "Save".
2. Confirm the save landed via `list_network_requests` (200 from the
   profile update endpoint).

### Assertions
**DB:**
```sql
SELECT count(*) FROM "ConsentArtifact"
WHERE "userId" = (SELECT id FROM users WHERE email = 'test-dpdp-d5@familiarise.test');
-- Expected: still 2 (no third row from the update)
```

**Audit log (defensive):**
```sql
SELECT count(*) FROM "OrgAuditLog"
WHERE details::text LIKE '%test-dpdp-d5%' AND action ILIKE '%CONSENT%';
-- Expected: 0 (consent stamping is BetterAuth-internal; should not emit OrgAuditLog rows from a user-update path)
```

### Cleanup
```sql
DELETE FROM "ConsentArtifact" WHERE "userId" = (SELECT id FROM users WHERE email = 'test-dpdp-d5@familiarise.test');
DELETE FROM users WHERE email = 'test-dpdp-d5@familiarise.test';
```

### Done when
- [ ] Exactly 2 ConsentArtifact rows for the user after the profile update
- [ ] No CONSENT-flavored audit row from the update path
- [ ] Cleanup completed
