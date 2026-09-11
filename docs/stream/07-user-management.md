# User Management

This document covers Stream Chat user management operations including user upsert, role mapping, user search, and background synchronization.

## Table of Contents

- [User Upsert Operations](#user-upsert-operations)
- [Role Mapping](#role-mapping)
- [User Search](#user-search)
- [Background Sync Job](#background-sync-job)

---

## User Upsert Operations

User upsert operations ensure that users in your Prisma database are synchronized with Stream Chat. These operations create or update users in Stream Chat with the latest information from your database.

### Single User Upsert

The `upsertUserToStream` function creates or updates a single user in Stream Chat.

**Location:** `/actions/stream/chat/user.action.ts`

**Function Signature:**

```typescript
export const upsertUserToStream = async (userId: string)
```

**Parameters:**

- `userId` (string): The unique identifier of the user to upsert

**Returns:**

- `Promise<UserResponse>`: The upserted user object from Stream Chat

**Example Usage:**

```typescript
import { upsertUserToStream } from "@/actions/stream/chat/user.action";

// Upsert a single user
try {
  const streamUser = await upsertUserToStream("user-123");
  console.log("User upserted:", streamUser);
} catch (error) {
  console.error("Failed to upsert user:", error);
}
```

**Internal Process:**

1. Validates Stream API credentials
2. Fetches user details from Prisma database (id, name, email, image, role)
3. Maps the user's role to Stream Chat role using `mapRoleToStream()`
4. Calls `client.upsertUser()` with user data
5. Returns the Stream Chat user object

**Error Handling:**

- Throws error if Stream API keys are not configured
- Throws error if user is not found in database
- Logs and re-throws any Stream API errors

### Batch User Upsert

The `upsertUsersToStream` function creates or updates multiple users in a single operation for better performance.

**Location:** `/actions/stream/chat/user.action.ts`

**Function Signature:**

```typescript
export const upsertUsersToStream = async (userIds: string[])
```

**Parameters:**

- `userIds` (string[]): Array of user IDs to upsert

**Returns:**

- `Promise<UpsertManyUsersResponse>`: Batch upsert response from Stream Chat

**Example Usage:**

```typescript
import { upsertUsersToStream } from "@/actions/stream/chat/user.action";

// Upsert multiple users at once
try {
  const userIds = ["user-123", "user-456", "user-789"];
  const result = await upsertUsersToStream(userIds);
  console.log("Users upserted:", result);
} catch (error) {
  console.error("Failed to upsert users:", error);
}
```

**Internal Process:**

1. Validates Stream API credentials
2. Fetches all users from Prisma database using `findMany` with `where: { id: { in: userIds } }`
3. Maps each user's role to Stream Chat role
4. Transforms users into Stream Chat format
5. Calls `client.upsertUsers()` with batch payload
6. Returns batch upsert response

**Performance Benefits:**

- Single API call for multiple users
- Reduced network overhead
- Faster synchronization for bulk operations

---

## Role Mapping

Stream Chat uses a role-based permission system. The `mapRoleToStream` function maps application user roles to Stream Chat roles.

**Location:** `/lib/user.ts` — `mapRoleToStream`

### Least-Privilege Mapping (#899)

The mapping now follows least privilege. Only platform staff and admins receive Stream's global `admin` role; every other user, consultants included, is mapped to the plain `user` role. Consultants no longer get a blanket administrative grant. Instead, channel creation happens server-side and each host is given a channel-scoped `channel_moderator` grant on their own host channels at creation time, rather than a global moderation grant that would also cover peer direct-message channels.

Worth stating plainly how bad the previous version was, because the current
mapping reads as unremarkable and it is not: **every branch of the old switch
returned `admin`, including the `if (!role)` fallback.** Every account on the
platform held Stream global admin. The docblock said so out loud — "using admin
for consultants and consultees to ensure team channel access… can be refined
later with custom roles."

### Decision: keep `ADMIN`/`STAFF` → Stream `admin`

**Status: accepted.** Reviewed again while adding the DM eligibility gate; kept
as-is.

What it costs is real and should be understood rather than forgotten: Stream's
`admin` role bypasses channel permission checks, so a staff token can read any
channel — including any private consultant↔consultee DM — from the browser.
The blast radius of a stolen staff session is every conversation on the
platform. It is a deliberate trade, not an oversight.

Two alternatives were considered and rejected **for now**. Both remain open, and
either would be a strict improvement if the operational cost is acceptable when
someone next looks at this:

1. **Map everyone to `user`; do moderation server-side.** Staff would hold no
   special client-side role at all, and every moderation or support action would
   go through the server clients in `lib/stream-client.ts`, which present the
   API secret and bypass Stream's permission system anyway — so nothing is lost
   operationally *unless* a support surface needs to read channels directly in
   the browser. This is the least-privilege answer and removes the skeleton key
   entirely. It is the option to take if a staff account is ever compromised, or
   before the platform holds conversations it would be damaging to leak in bulk.
   Migration cost: one `upsertUsers` sweep to re-stamp existing staff rows,
   since the role is written at upsert time and the 5-minute sync cache means
   stale rows linger until they next reconnect.
2. **A Stream custom role granting `ReadChannel` and nothing else.** Staff could
   observe without being able to write, delete, or reconfigure. More precise
   than either of the above, and Stream allows up to 25 custom roles. Rejected
   for now on maintenance grounds: it is a role defined outside this repo (via
   the dashboard or an API call) that must be kept in step with the code, and we
   have no deployment path for chat roles yet. `scripts/stream/ensure-chat-type-grants.ts`
   is the obvious place to grow one.

Note that option 1 does **not** conflict with the grants script: that script
revokes `create-channel` from `user` and `guest`, which is orthogonal to whether
staff hold `admin`.

### Current Implementation

**Function Signature:**

```typescript
export function mapRoleToStream(role: string | null | undefined): string;
```

**Parameters:**

- `role` (string | null | undefined): The application user role

**Returns:**

- `string`: The Stream Chat role — `admin` for staff and admins, and `user` for everyone else

**Current Behavior:**

```typescript
export function mapRoleToStream(role: string | null | undefined): string {
  switch (role?.toUpperCase()) {
    case "ADMIN":
    case "STAFF":
      return "admin";
    default:
      return "user";
  }
}
```

### Standard Stream Chat Roles

Stream Chat provides the following standard roles:

| Role        | Permissions                                                          |
| ----------- | -------------------------------------------------------------------- |
| `admin`     | Full permissions (create, read, update, delete channels)             |
| `user`      | Basic user permissions (may not have team channel access by default) |
| `guest`     | Limited permissions                                                  |
| `anonymous` | Very limited permissions                                             |

### Channel-Scoped Moderation

Consultants are mapped to the plain `user` role globally and instead receive a channel-scoped `channel_moderator` grant on their own host channels at creation time. This gives a host moderation authority over the channels they own without granting global admin permissions or moderation rights over unrelated peer direct-message channels.

---

## User Search

The application provides two user search functions with different capabilities.

### Enhanced Search with Relationships

The `searchUsersWithRelationships` function searches for users and includes relationship status information based on appointments.

**Location:** `/actions/stream/chat/user.action.ts` (lines 125-201)

**Function Signature:**

```typescript
export const searchUsersWithRelationships = async (
  searchTerm: string,
  currentUserId: string
)
```

**Parameters:**

- `searchTerm` (string): Search query to match against name or email
- `currentUserId` (string): The current user's ID (excluded from results)

**Returns:**

```typescript
Promise<
  Array<{
    id: string;
    name: string | null;
    email: string;
    image: string | null;
    role: string;
    hasRelationship: boolean;
  }>
>;
```

**Example Usage:**

```typescript
import { searchUsersWithRelationships } from "@/actions/stream/chat/user.action";

// Search for users and check relationships
const users = await searchUsersWithRelationships("john", "current-user-id");

users.forEach((user) => {
  console.log(
    `${user.name} - ${user.hasRelationship ? "Connected" : "Not connected"}`,
  );
});
```

**Features:**

- **Relationship Detection:** Checks if users have existing appointments or subscriptions
- **Smart Sorting:** Connected users appear first, then sorted alphabetically
- **System User Exclusion:** Automatically filters out system users
- **Case-Insensitive Search:** Matches name or email regardless of case

**Exclusion Rules:**

```typescript
NOT: [
  { id: { startsWith: "recording-egress-" } },
  { id: { startsWith: "system-" } },
];
```

**Relationship Types Checked:**

1. **Consultations:** APPROVED or SCHEDULED status
2. **Subscriptions:** APPROVED or SCHEDULED, with valid end dates
3. **Shared Appointments:** Users in the same webinar or class slots

**Performance:**

- Limit: 20 results
- Uses Prisma's `findMany` with indexed fields
- Parallel relationship checking with `Promise.all`

### Legacy Search

The `searchUsers` function provides basic user search without relationship information.

**Location:** `/actions/stream/chat/user.action.ts` (lines 384-431)

**Function Signature:**

```typescript
export const searchUsers = async (searchTerm: string)
```

**Parameters:**

- `searchTerm` (string): Search query to match against name or email

**Returns:**

```typescript
Promise<
  Array<{
    id: string;
    name: string | null;
    email: string;
    image: string | null;
    role: string;
  }>
>;
```

**Example Usage:**

```typescript
import { searchUsers } from "@/actions/stream/chat/user.action";

// Simple user search
const users = await searchUsers("jane");
console.log(`Found ${users.length} users`);
```

**Features:**

- Simpler and faster than relationship search
- Same exclusion rules for system users
- Limit: 10 results
- Alphabetical sorting by name

**Use Cases:**

- Use `searchUsersWithRelationships` for Direct Message dialogs where connection status matters
- Use `searchUsers` for general admin searches or when performance is critical

---

## Background Sync Job

The background sync job maintains synchronization between your Prisma database and Stream Chat by identifying and removing stale users.

### Job Overview

**Schedule:** Daily at 03:40 UTC (9:10 AM IST)

**Execution:** GitHub Actions workflow

**Location:**

- Job logic: `/jobs/stream/stream-sync.ts` (implementation in
  `/scripts/stream/stream-sync.ts`)
- Workflow: `/.github/workflows/stream-sync.yml`

**Purpose:**

- Remove users from Stream Chat who no longer exist in the Prisma database
- Prevent orphaned users and maintain data consistency
- Clean up test accounts and deleted users

### Workflow Configuration

```yaml
name: Sync Stale Stream Users

on:
  schedule:
    # Runs at 03:30 UTC (9:00 AM IST) every day
    - cron: "30 3 * * *"
  workflow_dispatch: # Allows manual triggering

jobs:
  sync_stream_users:
    runs-on: ubuntu-latest
    env:
      DATABASE_URL: ${{ secrets.DATABASE_URL }}
      NEXT_PUBLIC_STREAM_API_KEY: ${{ secrets.NEXT_PUBLIC_STREAM_API_KEY }}
      STREAM_API_SECRET: ${{ secrets.STREAM_API_SECRET }}
```

**Required Secrets:**

- `DATABASE_URL`: Prisma database connection string
- `NEXT_PUBLIC_STREAM_API_KEY`: Stream Chat API key
- `STREAM_API_SECRET`: Stream Chat API secret

### Sync Logic

The `performStreamUserSync` function implements the core synchronization logic.

**Location:** `/jobs/stream-sync.ts` (lines 42-175)

**Function Signature:**

```typescript
export async function performStreamUserSync(): Promise<SyncSummary>;
```

**Returns:**

```typescript
interface SyncSummary {
  totalStreamUsersProcessed: number;
  totalStaleUsersIdentified: number;
  totalStaleUsersDeleted: number;
  totalFailedDeletions: number;
  failedDeletionDetails: FailedDeletionEntry[];
}
```

**Example Output:**

```
--- Summary ---
Total Stream Users Processed: 1,247
Total Stale Users Identified: 23
Total Stale Users Deleted:    22
Total Failed Deletions:       1

--- Failed Deletion Details ---
  User ID: user-xyz, Error: User is channel owner
```

### Step-by-Step Process

1. **Initialize Stream Client**

   ```typescript
   const serverStreamClient = StreamChat.getInstance(apiKey, apiSecret, {
     timeout: 30000,
   });
   ```

2. **Paginate Through Stream Users**

   ```typescript
   // Fetch 100 users per page, sorted by ID
   const streamUsersResponse = await serverStreamClient.queryUsers(
     lastStreamUserId ? { id: { $gt: lastStreamUserId } } : {},
     { id: 1 },
     { limit: 100, presence: false },
   );
   ```

3. **Check Against Prisma Database**

   ```typescript
   // Get active users from Prisma for current page
   const activePrismaUsersOnPage = await prisma.user.findMany({
     where: { id: { in: currentStreamUserIdsOnPage } },
     select: { id: true },
   });
   ```

4. **Identify Stale Users**

   ```typescript
   for (const streamUserId of currentStreamUserIdsOnPage) {
     if (!activePrismaUserIdsOnPageSet.has(streamUserId)) {
       // Check exclusion rules
       if (
         !streamUserId.startsWith("system-") &&
         !streamUserId.startsWith("recording-egress-") &&
         !EXCLUDED_USER_IDS.has(streamUserId)
       ) {
         staleUsersInPage.push(streamUserId);
       }
     }
   }
   ```

5. **Delete Stale Users** — soft, matching the job.
   ```typescript
   const deleteResponse = await serverStreamClient.deleteUsers(
     staleUsersInPage,
     { user: "soft", messages: "soft" },
   );
   ```

### Exclusion Rules

The following users are NEVER deleted:

**Pattern-Based Exclusions:**

- `system-*`: System-generated accounts
- `recording-egress-*`: Stream recording service accounts

**Hardcoded Exclusions:**

```typescript
const EXCLUDED_USER_IDS = new Set(["system"]);
```

Plus anything listed in the `STREAM_SYNC_EXCLUDED_USERS` environment variable.
This document previously showed a personal account hardcoded alongside
`"system"`; it is not in the code and must not be — an operator's own account
being un-reapable is a footgun, and the env var is the supported way to add one
temporarily.

**Reason for Exclusions:**

- System accounts are required for Stream functionality
- Recording egress users handle video recording and storage

### Deletion Strategy

**Soft delete.** This section used to document hard delete as the strategy and
soft as the alternative. The code does the opposite:

```typescript
{
  user: "soft",      // Intended 30-day grace period; expiry is NOT enforced yet
  messages: "soft"
}
```

There is no hard-delete follow-up job yet — the `TODO` in
`scripts/stream/stream-sync.ts` is tracked as #535.

**What that means concretely, for a DPDP §12 erasure request.**
`lib/compliance/erasure/scrub-user.ts` pseudonymises the local `User` row and
makes no Stream call at all. Stream-side removal is therefore incidental: the
nightly reaper notices the local row is gone and issues a *soft* delete, which
is the state the data then stays in.

- **Retention window:** the soft delete is described in the code as a 30-day
  grace period, but nothing expires it, because the job that would is #535. In
  practice the retention is indefinite.
- **Who can still read it:** nobody through the app — a soft-deleted Stream user
  cannot connect, and their messages are hidden from clients. It remains
  readable by anything holding the API secret: the Stream dashboard, a data
  export, and our own server-side clients.
- **Should erasure trigger a hard delete?** Yes, and it does not today. The
  correct shape is for the erasure path to call Stream directly with
  `{ user: "hard", messages: "hard" }` rather than waiting for a reaper whose
  input is "absent from Postgres" — an erasure is a specific, authorised
  instruction about one identified person, which is exactly the case where hard
  delete is safe and the reaper's inference is not. Deferred to #535; until it
  lands, an erasure request that must be provably complete has to be finished by
  hand in the Stream dashboard.

**Alternative Options:**

```typescript
{
  user: "hard",      // Irreversible; purges the user and their data
  messages: "hard"
}
```

Hard delete is what #535 will eventually run as a second pass over rows the soft
delete has already aged out. It is deliberately not what the nightly reaper does:
the reaper's input is "present in Stream, absent from Postgres", and that set
includes anyone the local database has merely failed to return — a bad migration,
a partial restore, a query bug. Soft-deleting that is a bad day; hard-deleting it
is unrecoverable.

### Error Handling

**Failed Deletions:**

```typescript
const sdkFailedDeletions = deleteResponse.failed_delete_users || [];

if (sdkFailedDeletions.length > 0) {
  const failures = sdkFailedDeletions.map((f) => ({
    id: f.user_id,
    error: f.message || "Unknown error",
  }));
  allFailedDeletions.push(...failures);
}
```

**Common Failure Reasons:**

- User is the owner of channels (must transfer ownership first)
- User has active sessions or connections
- Network timeouts for specific users
- Rate limiting from Stream API

**Batch Failure Handling:**

```typescript
catch (error) {
  // If entire batch fails, mark all as failed
  const failures = staleUsersInPage.map(id => ({
    id,
    error: error.message || "Batch deletion API call failed"
  }));
  allFailedDeletions.push(...failures);
}
```

### Monitoring and Reporting

**Console Output:**

```
[Stream Sync Job] Starting Stream user synchronization...
[Stream Sync Job] Fetching next page of Stream users (after ID: start)...
[Stream Sync Job] Fetched 100 users in this page. Total processed so far: 100.
[Stream Sync Job] Found 95 active Prisma users among the current Stream page.
[Stream Sync Job] Identified 5 stale users in this page. Attempting deletion...
[Stream Sync Job] Deletion task for batch completed. Targeted: 5, Successful: 5, Failed: 0
```

**Exit Codes:**

- `0`: Success (no errors)
- `1`: Fatal error (sync failed)
- `2`: Partial success (optional, if some deletions failed)

**GitHub Actions Integration:**

```yaml
- name: Sync Complete
  if: success()
  run: echo "Stream user sync script completed successfully."

- name: Sync Failed
  if: failure()
  run: echo "Stream user sync script failed."
```

### Manual Triggering

You can manually trigger the sync job:

**Via GitHub Actions UI:**

1. Navigate to Actions tab
2. Select "Sync Stale Stream Users" workflow
3. Click "Run workflow"
4. Select branch and confirm

**Via API Endpoint:**
See [API Endpoints - Manual Sync](./10-api-endpoints.md#post-apistreamsyncmanual)

### Performance Considerations

**Pagination:**

- Processes 100 users per page
- Continues until all Stream users are checked
- Prevents memory issues with large user bases

**Timeout Settings:**

- Stream Client timeout: 30 seconds
- Allows for slower network conditions
- Prevents hanging on failed requests

**Database Queries:**

- Batched per page (100 users at a time)
- Uses indexed `id` field for fast lookups
- Minimal data selected (`select: { id: true }`)

### Best Practices

1. **Monitor Logs:** Review GitHub Actions logs regularly for failed deletions
2. **Update Exclusions:** Add critical user IDs to `EXCLUDED_USER_IDS` set
3. **Test Before Production:** Use workflow_dispatch to manually test changes
4. **Set Alerts:** Configure GitHub Actions notifications for failures
5. **Review Failed Deletions:** Investigate and manually handle persistent failures

### Troubleshooting

**Problem:** Sync job times out

- **Solution:** Reduce page size from 100 to 50 users
- **Solution:** Increase timeout from 30s to 60s

**Problem:** Too many failed deletions

- **Solution:** Check if users are channel owners
- **Solution:** Transfer channel ownership before deletion
- **Solution:** Review Stream API rate limits

**Problem:** DATABASE_URL not found

- **Solution:** Ensure secret is set in GitHub repository settings
- **Solution:** Check secret name matches exactly (case-sensitive)

**Problem:** Users being deleted incorrectly

- **Solution:** Verify Prisma database connection
- **Solution:** Check exclusion rules are properly applied
- **Solution:** Add temporary logging to identify issues

---

## Related Documentation

- [Token Management](./08-token-management.md)
- [Background Sync](./09-background-sync.md)
- [API Endpoints](./10-api-endpoints.md)
