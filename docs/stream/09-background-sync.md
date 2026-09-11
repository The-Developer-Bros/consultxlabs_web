# Background Sync

This document provides detailed information about the Stream user background synchronization job, including job overview, sync logic, exclusion rules, error handling, and monitoring.

## Table of Contents

- [Job Overview](#job-overview)
- [Sync Logic](#sync-logic)
- [Exclusion Rules](#exclusion-rules)
- [Error Handling](#error-handling)
- [Background Sync Flow](#background-sync-flow)
- [Monitoring and Troubleshooting](#monitoring-and-troubleshooting)

---

## Job Overview

The Stream user background sync job maintains data consistency between your Prisma database and Stream Chat by identifying and removing stale users.

### Purpose

**Primary Goals:**

1. Remove users from Stream Chat who no longer exist in the Prisma database
2. Prevent orphaned user accounts in Stream
3. Maintain data consistency across systems
4. Clean up test accounts and deleted users

**Business Impact:**

- Reduces Stream user count (affects billing)
- Improves channel member accuracy
- Prevents messaging to deleted users
- Maintains clean user directory

### Schedule

The sweep runs daily at 03:40 UTC, which is 09:10 IST. That minute is not
arbitrary: `scripts/ci/check-workflow-hygiene.ts` costs every shared cron start
minute against a connection-pool budget, so moving it means checking that guard
rather than picking a number.

There are three ways to start it. The GitHub Actions schedule is the normal one;
`workflow_dispatch` on the same workflow is the manual one; and an administrator
can run it from the staff Jobs page, which posts `stream-sync` to
`/api/admin/system-jobs/run`. All three call the same core function, so they
cannot diverge.

### Where the definition actually lives

The workflow is `.github/workflows/stream-sync.yml`, the Actions wrapper is
`jobs/stream/stream-sync.ts`, and the core is `scripts/stream/stream-sync.ts`.
Read those rather than a copy pasted here — an earlier version of this document
carried an inline copy of the workflow, and every field in it had drifted: the
filename, the schedule, the Node version and the entrypoint path were all wrong,
and the `package.json` script it quoted pointed at a file that does not exist.

The workflow needs `DATABASE_URL` and `DIRECT_URL` for Prisma, `STREAM_API_KEY`
and `STREAM_API_SECRET` to reach Stream, `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN` for the cron lock, and the Sentry DSN so that a job
process — which never runs Next's instrumentation hook — reports its errors
anywhere. Every one of those names is justified in
[the required-secrets manifest](../enterprise/50-operations/07-required-secrets.md),
and CI fails the build if a workflow references a secret that is not listed
there.

### Locking

The job is fail-closed: without a working Redis lock it refuses to run rather
than risk two runners soft-deleting Stream users at the same time. The lock has
a forty-minute time to live, which is longer than the workflow's own
`timeout-minutes`, so it always outlives any run that can exist. A run that
finds the lock held exits cleanly rather than reporting a failure, because
skipping is the correct outcome for every runner that loses that race.

Until #1270 the job held a bespoke Redis lock of its own instead of the fleet's
`withCronLock`. It excluded correctly, but it was invisible: `withCronLock` is
what writes the `SystemJobExecution` row and refreshes the fleet heartbeat, so
the sweep had no recorded last run, no recorded duration, and no presence at all
in the operator surface. One consequence of the migration is worth stating: on a
machine with no Upstash credentials the job now throws instead of proceeding
unlocked, which is the right answer for a job that deletes users.

### Execution environment

The workflow runs Node 22 with `npm ci`, and executes the entrypoint through a
pinned `tsx`. The Stream client uses a thirty-second per-request timeout, and a
typical run takes two to ten minutes; the forty-minute lock and the thirty-five
minute workflow timeout are sized for the pathological case of a hundred
thousand Stream users, which walks a thousand pages with a half-second pause
between deletions.

---

## Sync Logic

The sync job uses pagination to process all Stream users efficiently, checking each against the Prisma database.

### Core Function

**Location:** `/jobs/stream-sync.ts`

**Function Signature:**

```typescript
export async function performStreamUserSync(): Promise<SyncSummary>;
```

**Return Type:**

```typescript
interface SyncSummary {
  totalStreamUsersProcessed: number;
  totalStaleUsersIdentified: number;
  totalStaleUsersDeleted: number;
  totalFailedDeletions: number;
  failedDeletionDetails: FailedDeletionEntry[];
}

interface FailedDeletionEntry {
  id: string;
  error: string;
}
```

### Step-by-Step Process

#### 1. Initialize Stream Client

```typescript
function getStreamClient() {
  const streamApiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;
  const streamApiSecret = process.env.STREAM_API_SECRET;

  if (!streamApiKey || !streamApiSecret) {
    console.error(
      "[Stream Sync Job] Critical: Stream API Key or Secret is not defined.",
    );
    throw new Error("Stream API Key or Secret not configured for sync job.");
  }

  return StreamChat.getInstance(streamApiKey, streamApiSecret, {
    timeout: 30000, // 30 seconds timeout
  });
}
```

**Key Points:**

- Validates environment variables before proceeding
- Sets 30-second timeout for API calls
- Throws error if credentials are missing

#### 2. Paginate Through Stream Users

```typescript
const streamPageLimit = 100;
let lastStreamUserId: string | undefined = undefined;

while (true) {
  console.log(
    `[Stream Sync Job] Fetching next page of Stream users (after ID: ${lastStreamUserId || "start"})...`,
  );

  const streamUsersResponse = await serverStreamClient.queryUsers(
    lastStreamUserId ? { id: { $gt: lastStreamUserId } } : {},
    { id: 1 }, // Sort by ID for consistent pagination
    { limit: streamPageLimit, presence: false },
  );

  const currentStreamPageUsers = streamUsersResponse.users;

  // Exit loop if no more users
  if (currentStreamPageUsers.length === 0) {
    console.log("[Stream Sync Job] No more Stream users to process.");
    break;
  }

  totalStreamUsersProcessed += currentStreamPageUsers.length;
  lastStreamUserId =
    currentStreamPageUsers[currentStreamPageUsers.length - 1].id;

  // Process this page...
}
```

**Pagination Strategy:**

- Fetches 100 users per page
- Uses cursor-based pagination with `$gt` (greater than)
- Sorts by ID for consistent ordering
- Disables presence data (`presence: false`) for performance
- Continues until no more users returned

#### 3. Check Against Prisma Database

For each page of Stream users, query Prisma to find active users:

```typescript
const currentStreamUserIdsOnPage = currentStreamPageUsers.map(
  (user) => user.id,
);

const activePrismaUsersOnPage = await prisma.user.findMany({
  where: {
    id: { in: currentStreamUserIdsOnPage },
  },
  select: { id: true },
});

const activePrismaUserIdsOnPageSet = new Set(
  activePrismaUsersOnPage.map((user) => user.id),
);

console.log(
  `[Stream Sync Job] Found ${activePrismaUserIdsOnPageSet.size} active Prisma users among the current Stream page.`,
);
```

**Query Optimization:**

- Only fetches `id` field (minimal data)
- Uses `IN` clause for batch lookup
- Converts to Set for O(1) lookup performance

#### 4. Identify Stale Users

```typescript
const staleUsersInPage: string[] = [];

for (const streamUserId of currentStreamUserIdsOnPage) {
  if (!activePrismaUserIdsOnPageSet.has(streamUserId)) {
    // Apply exclusion rules
    if (
      !streamUserId.startsWith("system-") &&
      !streamUserId.startsWith("recording-egress-") &&
      !EXCLUDED_USER_IDS.has(streamUserId)
    ) {
      staleUsersInPage.push(streamUserId);
    }
  }
}

if (staleUsersInPage.length > 0) {
  totalStaleUsersIdentified += staleUsersInPage.length;
  console.log(
    `[Stream Sync Job] Identified ${staleUsersInPage.length} stale users in this page.`,
  );
}
```

**Stale User Criteria:**

1. User exists in Stream but NOT in Prisma database
2. User ID does NOT start with `system-`
3. User ID does NOT start with `recording-egress-`
4. User ID is NOT in `EXCLUDED_USER_IDS` set

#### 5. Delete Stale Users

```typescript
if (staleUsersInPage.length > 0) {
  try {
    const deleteResponse = await serverStreamClient.deleteUsers(
      staleUsersInPage,
      { user: "hard", messages: "hard" },
    );

    // Check for failed deletions
    const sdkFailedDeletions = deleteResponse.failed_delete_users || [];

    if (sdkFailedDeletions.length > 0) {
      const failures = sdkFailedDeletions.map((f) => ({
        id: f.user_id,
        error: f.message || "Unknown error",
      }));
      allFailedDeletions.push(...failures);
      console.warn(
        `[Stream Sync Job] Failed to delete ${failures.length} users in this batch:`,
        failures,
      );
    }

    const successfullyDeletedInBatch =
      staleUsersInPage.length - sdkFailedDeletions.length;
    totalStaleUsersDeleted += successfullyDeletedInBatch;

    console.log(
      `[Stream Sync Job] Deletion task for batch completed. Targeted: ${staleUsersInPage.length}, Successful: ${successfullyDeletedInBatch}, Failed: ${sdkFailedDeletions.length}`,
    );
  } catch (error) {
    console.error(
      `[Stream Sync Job] Error during batch deletion of Stream users:`,
      error.message,
    );
    const failures = staleUsersInPage.map((id) => ({
      id,
      error: error.message || "Batch deletion API call failed",
    }));
    allFailedDeletions.push(...failures);
  }
}
```

**Deletion Strategy:**

- **Hard delete users:** Permanently removes user from Stream
- **Hard delete messages:** Removes all messages from deleted users
- Batch deletion for efficiency
- Tracks successful and failed deletions separately

### Performance Characteristics

**Scalability:**

- Processes 100 users per page
- Memory-efficient (doesn't load all users at once)
- Can handle thousands of users without issues

**Typical Execution Times:**
| User Count | Estimated Time |
|------------|----------------|
| 100 users | < 1 minute |
| 1,000 users | 2-3 minutes |
| 10,000 users | 5-10 minutes |
| 50,000 users | 20-30 minutes |

**API Calls:**

- 1 call per 100 Stream users (pagination)
- 1 Prisma query per page
- 1 deletion call per page (if stale users found)

---

## Exclusion Rules

Certain users are protected from deletion to maintain system functionality.

### Pattern-Based Exclusions

**System Users:**

```typescript
if (!streamUserId.startsWith("system-")) {
  // User may be deleted
}
```

**Examples:**

- `system-notifications`
- `system-admin`
- `system-bot`

**Purpose:** These accounts are used for automated messages, system notifications, and internal operations.

**Recording Egress Users:**

```typescript
if (!streamUserId.startsWith("recording-egress-")) {
  // User may be deleted
}
```

**Examples:**

- `recording-egress-abc123`
- `recording-egress-session-456`

**Purpose:** Stream creates these accounts automatically for recording and storage operations. Deleting them breaks recording functionality.

### Hardcoded Exclusions

**Location:** `/jobs/stream-sync.ts` (line 23)

```typescript
const EXCLUDED_USER_IDS = new Set(["system", "teetangh"]);
```

**Currently Excluded Users:**

1. `system` - Core system account
2. `teetangh` - Administrator account

**Adding New Exclusions:**

```typescript
const EXCLUDED_USER_IDS = new Set([
  "system",
  "teetangh",
  "admin",
  "support-bot",
  "demo-user",
]);
```

**When to Add Exclusions:**

- Critical administrator accounts
- Demo or showcase accounts
- Service accounts for integrations
- Accounts used in automated testing
- Bot accounts for customer support

### Exclusion Logic Flow

```typescript
for (const streamUserId of currentStreamUserIdsOnPage) {
  // Check 1: Does user exist in Prisma?
  if (!activePrismaUserIdsOnPageSet.has(streamUserId)) {
    // Check 2: Is it a system user?
    if (streamUserId.startsWith("system-")) {
      continue; // Skip deletion
    }

    // Check 3: Is it a recording egress user?
    if (streamUserId.startsWith("recording-egress-")) {
      continue; // Skip deletion
    }

    // Check 4: Is it in hardcoded exclusions?
    if (EXCLUDED_USER_IDS.has(streamUserId)) {
      continue; // Skip deletion
    }

    // All checks passed - mark for deletion
    staleUsersInPage.push(streamUserId);
  }
}
```

---

## Error Handling

The sync job implements comprehensive error handling to ensure robustness.

### Error Categories

#### 1. Configuration Errors

**Missing Environment Variables:**

```typescript
if (!process.env.DATABASE_URL) {
  console.error(
    "[Stream Sync Script] Critical: DATABASE_URL environment variable is not set.",
  );
  process.exit(1);
}

if (!streamApiKey || !streamApiSecret) {
  console.error(
    "[Stream Sync Job] Critical: Stream API Key or Secret is not defined.",
  );
  throw new Error("Stream API Key or Secret not configured for sync job.");
}
```

**Exit Behavior:**

- Script exits with code `1` (failure)
- GitHub Actions marks job as failed
- No partial deletion occurs

#### 2. Batch Deletion Errors

**Entire Batch Fails:**

```typescript
try {
  const deleteResponse = await serverStreamClient.deleteUsers(
    staleUsersInPage,
    { user: "hard", messages: "hard" },
  );
} catch (error) {
  console.error(
    `[Stream Sync Job] Error during batch deletion of Stream users:`,
    error.message,
  );

  // Mark all users in batch as failed
  const failures = staleUsersInPage.map((id) => ({
    id,
    error: error.message || "Batch deletion API call failed",
  }));
  allFailedDeletions.push(...failures);
}
```

**Common Causes:**

- Network timeout
- Stream API rate limiting
- Invalid API credentials
- Temporary service outage

**Impact:**

- Failed deletions are tracked
- Job continues to next page
- Summary includes all failures

#### 3. Individual Deletion Failures

**Partial Batch Success:**

```typescript
const sdkFailedDeletions = deleteResponse.failed_delete_users || [];

if (sdkFailedDeletions.length > 0) {
  const failures = sdkFailedDeletions.map((f) => ({
    id: f.user_id,
    error: f.message || "Unknown error",
  }));
  allFailedDeletions.push(...failures);
  console.warn(
    `[Stream Sync Job] Failed to delete ${failures.length} users in this batch:`,
    failures,
  );
}
```

**Common Causes:**

- User is channel owner (must transfer ownership first)
- User has active connections
- User in protected channel
- Rate limiting for specific user

**Response Structure:**

```typescript
interface FailedDeletionFromSDK {
  user_id: string;
  message: string;
}
```

### Error Reporting

**Summary Report:**

```typescript
return {
  totalStreamUsersProcessed: 1247,
  totalStaleUsersIdentified: 23,
  totalStaleUsersDeleted: 22,
  totalFailedDeletions: 1,
  failedDeletionDetails: [
    {
      id: "user-xyz",
      error: "User is owner of channel 'consulting-room-123'",
    },
  ],
};
```

**Console Output:**

```
[Stream Sync Job] Synchronization completed successfully.
--- Summary ---
Total Stream Users Processed: 1247
Total Stale Users Identified: 23
Total Stale Users Deleted:    22
Total Failed Deletions:       1

--- Failed Deletion Details ---
  User ID: user-xyz, Error: User is owner of channel 'consulting-room-123'
```

### Exit Codes

**Success (Exit 0):**

- All users processed
- All deletions successful OR documented failures
- No fatal errors

**Failure (Exit 1):**

- Missing environment variables
- Fatal database connection error
- Stream client initialization failure
- Unhandled exceptions

**Partial Success:**

```typescript
if (summary.totalFailedDeletions > 0) {
  console.warn(
    "[Stream Sync Script] Process completed with some failed deletions.",
  );
  // Optionally, exit with code 2 for partial success
  // process.exit(2);
}
```

### Retry Strategy

**Current Behavior:** No automatic retries

**Recommended Enhancement:**

```typescript
async function deleteUsersWithRetry(
  userIds: string[],
  maxRetries: number = 3,
): Promise<DeleteUsersResponse> {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Deletion attempt ${attempt}/${maxRetries}`);
      return await serverStreamClient.deleteUsers(userIds, {
        user: "hard",
        messages: "hard",
      });
    } catch (error) {
      lastError = error;
      console.warn(`Attempt ${attempt} failed:`, error.message);

      // Exponential backoff
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
```

---

## Background Sync Flow

The following flowchart illustrates the complete background sync process.

```mermaid
flowchart TD
    Start([GitHub Actions Trigger<br/>Daily at 03:30 UTC]) --> CheckEnv{Environment<br/>Variables Set?}

    CheckEnv -->|No| ErrorExit1[Exit with Error Code 1]
    CheckEnv -->|Yes| InitClient[Initialize Stream Client<br/>timeout: 30s]

    InitClient --> InitVars[Initialize Variables<br/>- totalProcessed = 0<br/>- totalStale = 0<br/>- totalDeleted = 0<br/>- failedDeletions = []]

    InitVars --> StartLoop{More Stream<br/>Users?}

    StartLoop -->|No| GenerateSummary[Generate Summary Report]
    StartLoop -->|Yes| FetchPage[Fetch Page of Stream Users<br/>limit: 100, sort by ID]

    FetchPage --> CheckPage{Users<br/>Returned?}
    CheckPage -->|No| GenerateSummary
    CheckPage -->|Yes| UpdateProcessed[totalProcessed += page.length]

    UpdateProcessed --> ExtractIDs[Extract User IDs from Page]
    ExtractIDs --> QueryPrisma[Query Prisma for Active Users<br/>WHERE id IN ...]

    QueryPrisma --> CreateSet[Create Set of Active User IDs]
    CreateSet --> InitStale[Initialize staleUsersInPage = []]

    InitStale --> LoopUsers[For Each Stream User ID]

    LoopUsers --> CheckPrisma{User in<br/>Prisma?}
    CheckPrisma -->|Yes| NextUser[Continue to Next User]
    CheckPrisma -->|No| CheckSystem{Starts with<br/>'system-'?}

    CheckSystem -->|Yes| NextUser
    CheckSystem -->|No| CheckRecording{Starts with<br/>'recording-egress-'?}

    CheckRecording -->|Yes| NextUser
    CheckRecording -->|No| CheckExcluded{In<br/>EXCLUDED_USER_IDS?}

    CheckExcluded -->|Yes| NextUser
    CheckExcluded -->|No| AddToStale[Add to staleUsersInPage]

    AddToStale --> NextUser
    NextUser --> MoreUsers{More Users<br/>in Page?}

    MoreUsers -->|Yes| LoopUsers
    MoreUsers -->|No| CheckStale{staleUsersInPage<br/>empty?}

    CheckStale -->|Yes| UpdateCursor[Update lastStreamUserId<br/>to last user in page]
    CheckStale -->|No| UpdateStaleCount[totalStale += staleUsersInPage.length]

    UpdateStaleCount --> TryDelete{Attempt Batch<br/>Deletion}

    TryDelete -->|Success| CheckFailed{Any Failed<br/>Deletions?}
    TryDelete -->|Error| LogError[Log Batch Error]

    LogError --> MarkAllFailed[Mark All Users in Batch<br/>as Failed]
    MarkAllFailed --> UpdateCursor

    CheckFailed -->|Yes| ExtractFailed[Extract Failed User IDs<br/>and Error Messages]
    CheckFailed -->|No| UpdateDeleted[totalDeleted +=<br/>staleUsersInPage.length]

    ExtractFailed --> AddFailures[Add to failedDeletions Array]
    AddFailures --> CalcSuccess[Calculate Successful Deletions<br/>= total - failed]
    CalcSuccess --> UpdateDeletedPartial[totalDeleted += successful]

    UpdateDeletedPartial --> LogResults[Log Deletion Results]
    UpdateDeleted --> LogResults

    LogResults --> UpdateCursor
    UpdateCursor --> StartLoop

    GenerateSummary --> LogSummary[Log Summary to Console<br/>- Total Processed<br/>- Total Stale<br/>- Total Deleted<br/>- Total Failed]

    LogSummary --> CheckFailures{Any Failed<br/>Deletions?}

    CheckFailures -->|Yes| LogFailureDetails[Log Failed Deletion Details<br/>User IDs and Errors]
    CheckFailures -->|No| SuccessExit[Exit with Code 0<br/>Success]

    LogFailureDetails --> WarnPartial[Warn: Partial Success]
    WarnPartial --> SuccessExit

    ErrorExit1 --> End([End])
    SuccessExit --> End

    style Start fill:#e1f5ff
    style End fill:#e1f5ff
    style ErrorExit1 fill:#ffebee
    style SuccessExit fill:#e8f5e9
    style CheckEnv fill:#fff9c4
    style CheckPage fill:#fff9c4
    style CheckPrisma fill:#fff9c4
    style CheckSystem fill:#fff9c4
    style CheckRecording fill:#fff9c4
    style CheckExcluded fill:#fff9c4
    style CheckStale fill:#fff9c4
    style TryDelete fill:#fff9c4
    style CheckFailed fill:#fff9c4
    style CheckFailures fill:#fff9c4
    style MoreUsers fill:#fff9c4
    style StartLoop fill:#fff9c4
```

### Flow Explanation

**Phase 1: Initialization**

1. GitHub Actions triggers workflow at scheduled time
2. Environment variables are validated
3. Stream client is initialized with 30-second timeout
4. Tracking variables are initialized

**Phase 2: Pagination Loop** 5. Fetch next page of 100 Stream users (sorted by ID) 6. Update total processed count 7. Extract user IDs from current page 8. Query Prisma for active users matching these IDs

**Phase 3: Stale User Identification** 9. For each Stream user ID in page:

- Check if user exists in Prisma
- Apply system prefix exclusion
- Apply recording egress exclusion
- Apply hardcoded exclusions
- Add to stale list if all checks pass

**Phase 4: Deletion** 10. If stale users found in page: - Attempt batch deletion with hard delete - Handle partial failures (some succeed, some fail) - Handle complete batch failures (all fail) - Update counters and track failures

**Phase 5: Loop Continuation** 11. Update pagination cursor to last user ID 12. Return to step 5 if more users exist

**Phase 6: Completion** 13. Generate comprehensive summary report 14. Log summary to console 15. Log individual failure details if any 16. Exit with appropriate code (0 = success, 1 = failure)

---

## Monitoring and Troubleshooting

### Monitoring Best Practices

#### 1. GitHub Actions Logs

**Accessing Logs:**

1. Navigate to your repository on GitHub
2. Click "Actions" tab
3. Select "Sync Stale Stream Users" workflow
4. Click on specific run to view logs

**Key Metrics to Monitor:**

```
[Stream Sync Job] Total processed so far: 1247
[Stream Sync Job] Found 1195 active Prisma users among the current Stream page
[Stream Sync Job] Identified 5 stale users in this page
[Stream Sync Job] Deletion task for batch completed. Targeted: 5, Successful: 5, Failed: 0
```

#### 2. Set Up Notifications

**Email Notifications:**
GitHub Settings > Notifications > Actions > Email notifications for workflow failures

**Slack Integration:**

```yaml
- name: Notify Slack on Failure
  if: failure()
  uses: 8398a7/action-slack@v3
  with:
    status: ${{ job.status }}
    text: "Stream sync job failed!"
    webhook_url: ${{ secrets.SLACK_WEBHOOK_URL }}
```

#### 3. Metrics Dashboard

**Track Over Time:**

- Total users processed per run
- Stale users identified per run
- Deletion success rate
- Failed deletions trend

**Example Tracking:**

```typescript
// Store metrics in database or monitoring service
await metrics.record({
  timestamp: new Date(),
  totalProcessed: summary.totalStreamUsersProcessed,
  totalStale: summary.totalStaleUsersIdentified,
  totalDeleted: summary.totalStaleUsersDeleted,
  totalFailed: summary.totalFailedDeletions,
  successRate:
    (summary.totalStaleUsersDeleted / summary.totalStaleUsersIdentified) * 100,
});
```

### Common Issues and Solutions

#### Issue: Sync Job Times Out

**Symptoms:**

- GitHub Actions job exceeds time limit
- Incomplete processing of users

**Solutions:**

1. **Reduce Page Size:**

   ```typescript
   const streamPageLimit = 50; // Reduced from 100
   ```

2. **Increase Timeout:**

   ```yaml
   jobs:
     sync_stream_users:
       timeout-minutes: 60 # Default is 360
   ```

3. **Split into Multiple Jobs:**
   ```typescript
   // Process users in chunks across multiple workflow runs
   const startFromId = process.env.START_FROM_USER_ID;
   const maxUsers = 1000;
   ```

#### Issue: High Failure Rate

**Symptoms:**

- Many users in `failedDeletionDetails`
- Consistent failure messages

**Solutions:**

1. **Check Error Messages:**

   ```
   User ID: user-123, Error: User is owner of channel 'room-456'
   ```

2. **Transfer Channel Ownership:**

   ```typescript
   // Before running sync, transfer channel ownership
   await channel.updatePartial({
     set: {
       created_by_id: "new-owner-id",
     },
   });
   ```

3. **Implement Pre-deletion Checks:**

   ```typescript
   // Check if user owns channels before deleting
   const channels = await serverStreamClient.queryChannels({
     created_by_id: userId,
   });

   if (channels.length > 0) {
     console.warn(`User ${userId} owns ${channels.length} channels`);
     // Transfer or delete channels first
   }
   ```

#### Issue: Missing Environment Variables

**Symptoms:**

- Job fails immediately
- Error: "DATABASE_URL environment variable is not set"

**Solutions:**

1. **Verify Secrets:**
   - Go to Repository Settings > Secrets and variables > Actions
   - Ensure all required secrets are set

2. **Check Secret Names:**
   - Names are case-sensitive
   - Must match exactly: `DATABASE_URL`, not `database_url`

3. **Test Locally:**

   ```bash
   # Load environment variables
   export DATABASE_URL="postgresql://..."
   export NEXT_PUBLIC_STREAM_API_KEY="..."
   export STREAM_API_SECRET="..."

   # Run sync script
   npm run scripts:stream-sync
   ```

#### Issue: Database Connection Failures

**Symptoms:**

- Prisma query errors
- "Can't reach database server" messages

**Solutions:**

1. **Check Connection String:**

   ```typescript
   console.log("Testing database connection...");
   await prisma.$connect();
   console.log("Database connected successfully");
   ```

2. **Verify IP Allowlist:**
   - GitHub Actions uses dynamic IPs
   - Ensure database allows connections from GitHub IP ranges
   - Consider using connection pooling (PgBouncer)

3. **Check Connection Limits:**
   - Prisma connection pool size
   - Database max connections
   - Close connections properly

#### Issue: Rate Limiting from Stream API

**Symptoms:**

- Error: "Too many requests"
- 429 HTTP status codes

**Solutions:**

1. **Add Rate Limit Handling:**

   ```typescript
   async function deleteWithRateLimit(userIds: string[]) {
     try {
       return await serverStreamClient.deleteUsers(userIds, {
         user: "hard",
         messages: "hard",
       });
     } catch (error) {
       if (error.status === 429) {
         const retryAfter = error.response?.headers?.["retry-after"] || 60;
         console.log(`Rate limited. Waiting ${retryAfter}s...`);
         await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
         return await serverStreamClient.deleteUsers(userIds, {
           user: "hard",
           messages: "hard",
         });
       }
       throw error;
     }
   }
   ```

2. **Reduce Batch Size:**

   ```typescript
   // Delete in smaller batches
   const maxBatchSize = 25; // Reduced from 100
   ```

3. **Add Delays Between Batches:**
   ```typescript
   await deleteUsers(staleUsersInPage);
   await new Promise((resolve) => setTimeout(resolve, 1000)); // 1 second delay
   ```

### Testing the Sync Job

#### Local Testing

```bash
# 1. Set up environment variables
cp .env.example .env.local
# Edit .env.local with actual credentials

# 2. Run the sync script
npm run scripts:stream-sync

# 3. Check output
# Should see summary report at the end
```

#### Dry Run Mode

**Recommended Enhancement:**

```typescript
// Add DRY_RUN environment variable
const DRY_RUN = process.env.DRY_RUN === "true";

if (DRY_RUN) {
  console.log(
    `[DRY RUN] Would delete ${staleUsersInPage.length} users:`,
    staleUsersInPage,
  );
  // Don't actually delete
} else {
  // Perform actual deletion
  await serverStreamClient.deleteUsers(staleUsersInPage, {
    user: "hard",
    messages: "hard",
  });
}
```

**Usage:**

```bash
DRY_RUN=true npm run scripts:stream-sync
```

#### Manual Workflow Testing

1. Go to GitHub Actions
2. Select "Sync Stale Stream Users"
3. Click "Run workflow"
4. Select branch
5. Monitor execution in real-time
6. Review logs after completion

---

## Related Documentation

- [User Management](./07-user-management.md)
- [Token Management](./08-token-management.md)
- [API Endpoints](./10-api-endpoints.md)
