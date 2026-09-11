# Stream Troubleshooting Guide

Comprehensive troubleshooting guide for Stream Chat and Video integration issues, including critical known issues and workarounds.

## Navigation

- [Architecture](./01-architecture.md)
- [Setup & Configuration](./02-setup-configuration.md)
- [Provider & Authentication](./03-provider-authentication.md)
- [Hooks & Utilities](./11-hooks-utilities.md)
- [Error Handling](./12-error-handling.md)
- [Recording & Webhooks](./13-recording-webhooks.md)

---

## Table of Contents

1. [Critical Issues & Workarounds](#critical-issues--workarounds)
2. [Quick Debug Checklist](#quick-debug-checklist)
3. [Connection Issues](#connection-issues)
4. [Token Issues](#token-issues)
5. [Channel Issues](#channel-issues)
6. [Meeting Issues](#meeting-issues)
7. [Common Error Messages](#common-error-messages)
8. [Debug Tools](#debug-tools)
9. [Server Log Analysis](#server-log-analysis)
10. [Browser Console Inspection](#browser-console-inspection)

---

## Critical Issues & Workarounds

This section documents known critical bugs and their workarounds. Review before deploying to production.

### Stream Role Mapping (Resolved in #899)

**Severity:** RESOLVED | **Security Impact:** N/A

#### Problem Description

Earlier builds mapped every user to the "admin" role in Stream Chat regardless of their actual role, which left no permission differentiation between user types. As of #899 the mapping follows least privilege, so this is no longer an issue.

#### Location

**File:** `lib/user.ts`

#### Current Code

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

#### How Hosts Get Moderation

Only platform staff and admins receive Stream's global `admin` role. Everyone else, consultants included, is mapped to the plain `user` role. Channel creation happens server-side, and each host is given a channel-scoped `channel_moderator` grant on their own host channels at creation time. Hosts therefore moderate the channels they own without receiving global admin permissions or moderation rights over unrelated peer direct-message channels.

---

### Token Expiry Race Condition (Medium)

**Severity:** MEDIUM | **Impact:** Potential connection drops during long sessions

#### Problem Description

Tokens are cached for 50 minutes but have a 1-hour validity. There's a 10-minute window where the cached token might be used even though it's close to expiry.

#### Location

**File:** `providers/StreamProvider.tsx`
**Function:** `getCachedToken()`

#### Current Implementation

```typescript
const TOKEN_CACHE_DURATION = 50 * 60 * 1000; // 50 minutes

const getCachedToken = useCallback(async (type: "chat" | "video") => {
  const cached = tokenCache.current[type];

  if (cached && Date.now() - cached.timestamp < TOKEN_CACHE_DURATION) {
    return cached.token; // Token might expire soon
  }

  // Generate new token
  const newToken = await generateToken(type);
  return newToken;
}, []);
```

#### Impact

1. **Potential Disconnections:**
   - User might use token in the last 10 minutes
   - Token expires mid-operation
   - Connection drops unexpectedly

2. **Poor User Experience:**
   - Unexpected disconnections
   - Message send failures
   - Video call drops

#### Recommended Fix

**Option 1: Proactive Token Refresh** (Recommended)

```typescript
const TOKEN_REFRESH_THRESHOLD = 45 * 60 * 1000; // Refresh at 45 minutes

useEffect(() => {
  const interval = setInterval(async () => {
    // Proactively refresh token before it expires
    await refreshAllTokens();
  }, TOKEN_REFRESH_THRESHOLD);

  return () => clearInterval(interval);
}, []);
```

**Option 2: Token Expiry Listeners**

```typescript
chatClient.on("token.expired", async () => {
  const newToken = await chatTokenProvider(userId);
  await chatClient.setToken(newToken);
});
```

#### Current Workaround

5-minute safety buffer in cache check:

```typescript
// Check if token will expire soon
const willExpireSoon = Date.now() - cached.timestamp > 55 * 60 * 1000;
if (willExpireSoon) {
  // Generate new token
}
```

---

### Channel Creation Race Conditions (Medium)

**Severity:** MEDIUM | **Impact:** Channel creation failures for concurrent users

#### Problem Description

Event channels (webinars, classes) are created lazily on first access. When multiple users access the same event simultaneously, they may attempt to create the same channel concurrently.

#### Location

**File:** `actions/stream/chat/event-channel.action.ts`
**Functions:** `createWebinarChannel()`, `createClassChannel()`

#### Impact

1. **Creation Failures:**
   - Second request fails with "channel already exists"
   - User sees error message
   - Must retry manually

2. **Inconsistent State:**
   - First user might be added as member
   - Second user might not be added
   - Channel membership incomplete

#### Recommended Fix

**Option 1: Idempotency Pattern** (Recommended)

```typescript
export async function getOrCreateWebinarChannel(webinarId: string) {
  try {
    // Try to get existing channel
    const channel = chatClient.channel("team", `webinar-${webinarId}`);
    await channel.watch(); // Will fail if doesn't exist
    return channel;
  } catch (error) {
    // Channel doesn't exist, create it
    return await createWebinarChannel(webinarId);
  }
}
```

**Option 2: Eager Creation**

```typescript
// Create channel when webinar is scheduled (not on first access)
export async function handleWebinarScheduled(webinar: Webinar) {
  await createWebinarChannel(webinar.id);
}
```

#### Current Workaround

Atomic creation with members:

```typescript
// Create channel AND add members in one call (reduces race window)
await channel.create({
  members: allParticipants,
  data: {
    /* metadata */
  },
});
```

---

### Aggressive User Cleanup (Low)

**Severity:** LOW | **Impact:** Potential deletion of legitimate users

#### Problem Description

The daily sync job hard-deletes users from Stream who don't exist in Prisma. This could accidentally delete users being registered or temporarily removed from DB.

#### Location

**File:** `jobs/stream-sync.ts`
**Scheduled:** Daily at 03:30 UTC (09:00 AM IST)

#### Current Behavior

```typescript
// Delete users immediately if not in Prisma
for (const streamUser of staleUsers) {
  await chatClient.deleteUser(streamUser.id, {
    delete_conversation_channels: true, // Deletes ALL messages
    hard_delete: true, // Permanent deletion
  });
}
```

#### Impact

1. **Data Loss Risk:**
   - User and all their messages deleted permanently
   - No recovery possible
   - Conversation history lost

2. **Timing Issues:**
   - User being registered during sync window
   - User temporarily removed from Prisma
   - Race conditions with signup flow

#### Recommended Fix

**Option 1: Grace Period** (Recommended)

```typescript
// Add "deletedAt" timestamp to Stream user metadata
await chatClient.upsertUser({
  id: userId,
  deleted_at: new Date().toISOString(),
});

// Delete only after 7 days
const gracePeriod = 7 * 24 * 60 * 60 * 1000;
if (Date.now() - deletedAt > gracePeriod) {
  await deleteUser(userId);
}
```

#### Current Workaround

Exclusion list:

```typescript
const EXCLUDED_USERS = ["system", "teetangh" /* others */];
const shouldSkip =
  EXCLUDED_USERS.includes(streamUser.id) ||
  streamUser.id.startsWith("system-") ||
  streamUser.id.startsWith("recording-egress-");
```

---

### Missing Error Context (Low)

**Severity:** LOW | **Impact:** Difficult debugging

#### Problem Description

Error logs don't include sufficient context for debugging Stream issues.

#### Examples

```typescript
// Current
console.log("Chat connection failed:", error);

// Better
console.log("Chat connection failed:", {
  userId,
  error: error.message,
  code: error.code,
  timestamp: new Date().toISOString(),
  retryAttempt: attemptNumber,
});
```

#### Recommended Fix

Implement structured logging:

```typescript
import { logger } from "@/lib/logger";

logger.error("stream.chat.connection_failed", {
  userId,
  error,
  context: {
    /* additional context */
  },
});
```

---

### Workarounds Summary

| Issue           | Workaround                   | Effectiveness | Notes                            |
| --------------- | ---------------------------- | ------------- | -------------------------------- |
| Admin role bug  | Resolved in #899             | Fixed         | Least-privilege role mapping now in place |
| Token expiry    | 50-min cache (10-min buffer) | Good          | Still occasional drops           |
| Race conditions | Atomic creation              | Moderate      | Race window still exists         |
| User cleanup    | Exclusion list               | Good          | Manual maintenance required      |

---

## Quick Debug Checklist

Before diving deep, check these common issues:

### Environment Variables

```bash
# Check if all required variables are set
echo $NEXT_PUBLIC_STREAM_API_KEY
echo $STREAM_API_SECRET
```

Required variables:

- `NEXT_PUBLIC_STREAM_API_KEY` - Stream API key (public)
- `STREAM_API_SECRET` - Stream API secret (server-side only)

### Provider Setup

```typescript
// Ensure StreamProvider wraps your components
<StreamProvider userId={userId} enableChat={true} enableVideo={true}>
  <YourComponents />
</StreamProvider>
```

### Client Availability

```typescript
const client = useStreamVideoClient();
if (!client) {
  console.error("StreamProvider may be missing or not initialized");
}
```

### User Authentication

```typescript
const { userDetails, isLoading, error } = useUserData(userId);
if (error) {
  console.error("User authentication failed:", error);
}
```

### Network Connectivity

```bash
# Test Stream API connectivity
curl -X GET "https://chat.stream-io-api.com/health"
```

---

## Connection Issues

### Issue: The dashboard flickers or reloads as the page settles, and the first Join click does nothing

#### Symptoms

- The dashboard visibly remounts a second or two after load
- Clicking Join appears to do nothing, so the user clicks it several more times
- Component state (open dialogs, scroll position, half-filled forms) resets on its own
- Possibly a React error #310 — "rendered more hooks than during the previous render" — pointing into Stream SDK internals

#### Cause

The provider held the chat and video clients in two independent `useState`s. Their connects race, so the element wrapping the dashboard changed *type* between renders (`children` → `<StreamVideo>` → `<Chat>`, in socket-arrival order). React cannot reconcile a type change in place, so it remounted the whole subtree — destroying any in-flight join.

#### Fix

Both clients are committed in a single `setClients` via `Promise.allSettled`, so the tree shape is a pure function of one settled value. See §Why one state and not two in `docs/stream/03-provider-authentication.md`.

**If you see this again**, the first thing to check is whether someone has reintroduced a second source of truth for client state, or made the wrapper nesting order depend on which client arrived first.

### Issue: Video works locally but fails in production, or the console fills with CSP violations

#### Symptoms

- `Refused to connect to 'https://hint.stream-io-video.com/…'` or `'wss://video.stream-io-api.com/…'`
- Calls connect locally (where CSP is often not exercised) but not on a deploy preview or production
- `POST /api/csp-report` returning `429`

#### Cause

Stream does **not** use `getstream.io` at runtime — that is the marketing domain. The SDKs talk to `*.stream-io-api.com`, `*.stream-io-video.com`, and `*.stream-io-cdn.com`. An allow-list containing only `*.getstream.io` does not match any of them.

Separately, `/api/csp-report` was rate-limited at 5/hour, so the violation reports that would have revealed this were themselves being dropped.

#### Fix

Both are corrected in `next.config.mjs` and `lib/rate-limit.ts`. The full domain breakdown is in `docs/enterprise/20-iam-and-security/05-security-headers.md`.

**Verify with the browser, not the docs.** This class of drift is only visible in a real network log; Stream's documentation does not enumerate the SFU and hint domains in one place.

### Issue: "Chat connection failed"

#### Symptoms

- Error message: "Chat connection failed"
- Chat features not loading
- Infinite loading spinner

#### Possible Causes

1. **Missing or invalid API key**

   ```typescript
   // Check in browser console
   console.log(process.env.NEXT_PUBLIC_STREAM_API_KEY);
   // Should output your API key, not undefined
   ```

2. **Token generation failure**

   ```typescript
   // Check server logs for token generation
   const token = await chatTokenProvider(userId);
   console.log("Token generated:", !!token);
   ```

3. **User not upserted to Stream**

   ```typescript
   // Verify user exists in Stream
   await upsertUserToStream(userId);
   ```

4. **Network firewall blocking Stream**
   ```bash
   # Test connectivity
   curl https://chat.stream-io-api.com/health
   ```

#### Solutions

**Solution 1: Verify Environment Variables**

```bash
# .env.local
NEXT_PUBLIC_STREAM_API_KEY=your_api_key_here
STREAM_API_SECRET=your_api_secret_here
```

Restart your development server after changing env vars:

```bash
npm run dev
```

**Solution 2: Check Token Provider**

```typescript
// actions/stream/chat/stream.action.ts
export async function chatTokenProvider(userId: string) {
  try {
    const token = serverClient.createToken(userId);
    console.log(`Token created for user ${userId}`);
    return token;
  } catch (error) {
    console.error("Token generation failed:", error);
    throw error;
  }
}
```

**Solution 3: Manual User Upsert**

```typescript
import { upsertUserToStream } from "@/actions/stream/chat/user.action";

// In your component or effect
useEffect(() => {
  const setupUser = async () => {
    try {
      await upsertUserToStream(userId);
      console.log("User upserted successfully");
    } catch (error) {
      console.error("User upsert failed:", error);
    }
  };

  setupUser();
}, [userId]);
```

**Solution 4: Check Network**

```typescript
// Add network error detection
const connectChat = async () => {
  try {
    await client.connectUser(userData, tokenProvider);
  } catch (error) {
    if (error.message.includes("network")) {
      console.error("Network issue detected");
      // Show network error to user
    }
    throw error;
  }
};
```

---

### Issue: "Video client not available"

#### Symptoms

- Error from `useGetCallById`: "Video client not available"
- Video features not rendering
- Meeting page shows error

#### Possible Causes

1. **StreamProvider missing `enableVideo` prop**
2. **StreamProvider not wrapping component**
3. **Video client initialization failed**
4. **Component rendered before provider ready**

#### Solutions

**Solution 1: Enable Video in Provider**

```typescript
<StreamProvider
  userId={userId}
  enableChat={true}
  enableVideo={true}  // Ensure this is true
>
  <MeetingPage />
</StreamProvider>
```

**Solution 2: Check Provider Hierarchy**

```typescript
// app/layout.tsx or page wrapper
export default function RootLayout({ children }) {
  return (
    <ClerkProvider>
      {/* Stream Provider MUST wrap components using video */}
      <StreamProvider userId={user.id} enableVideo={true}>
        {children}
      </StreamProvider>
    </ClerkProvider>
  );
}
```

**Solution 3: Wait for Client**

```typescript
function MeetingPage({ callId }: { callId: string }) {
  const client = useStreamVideoClient();
  const { call, isCallLoading, error } = useGetCallById(callId);

  // Wait for client to be available
  if (!client) {
    return <div>Initializing video client...</div>;
  }

  if (isCallLoading) {
    return <LoadingSpinner />;
  }

  return <VideoCall call={call} />;
}
```

---

### Issue: Network Timeouts

#### Symptoms

- Requests hanging or timing out
- "Network request failed" errors
- Slow connection establishment

#### Solutions

**Solution 1: Check Internet Connection**

```bash
# Ping Stream servers
ping chat.stream-io-api.com
ping video.stream-io-api.com
```

**Solution 2: Increase Timeout**

```typescript
// Custom timeout for operations
const connectWithTimeout = async (
  connectFn: () => Promise<void>,
  timeoutMs = 30000,
) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Connection timeout")), timeoutMs),
  );

  return Promise.race([connectFn(), timeoutPromise]);
};

// Usage
try {
  await connectWithTimeout(() => connectChat(), 30000);
} catch (error) {
  console.error("Connection timed out:", error);
}
```

**Solution 3: Retry with Exponential Backoff**

Already implemented in `StreamProvider`:

```typescript
// Automatic retry on failure
if (newAttempts < 5) {
  const delay = getRetryDelay(newAttempts);
  // Delays: 1s, 2s, 4s, 8s, 16s
  setTimeout(() => connectServices(), delay);
}
```

---

## Token Issues

### Issue: "Token expired"

#### Symptoms

- Error: "Token expired"
- Sudden disconnection after ~1 hour
- Re-authentication required

#### Solutions

**Solution 1: Check Token Expiry**

```typescript
// Token cache includes expiry tracking
const isTokenValid = (type: "chat" | "video") => {
  const expiresAt = tokenCache.expiresAt;

  if (!expiresAt) return false;

  // Check if token expires within next 5 minutes
  return Date.now() < expiresAt - 5 * 60 * 1000;
};
```

**Solution 2: Automatic Token Refresh**

Already implemented in `StreamProvider`:

```typescript
const getCachedToken = async (type: "chat" | "video") => {
  if (isTokenValid(type)) {
    return tokenCache[`${type}Token`];
  }

  // Generate new token
  const newToken =
    type === "chat"
      ? await chatTokenProvider(userId)
      : await tokenProvider(userId);

  // Cache with 50-minute expiry
  const expiresAt = Date.now() + 50 * 60 * 1000;
  setTokenCache({ ...tokenCache, [`${type}Token`]: newToken, expiresAt });

  return newToken;
};
```

**Solution 3: Manual Token Refresh**

```typescript
function useTokenRefresh(userId: string) {
  const refreshToken = async () => {
    try {
      const newChatToken = await chatTokenProvider(userId);
      const newVideoToken = await tokenProvider(userId);

      console.log("Tokens refreshed successfully");
      return { chatToken: newChatToken, videoToken: newVideoToken };
    } catch (error) {
      console.error("Token refresh failed:", error);
      throw error;
    }
  };

  // Auto-refresh every 45 minutes
  useEffect(() => {
    const interval = setInterval(refreshToken, 45 * 60 * 1000);
    return () => clearInterval(interval);
  }, [userId]);

  return { refreshToken };
}
```

---

### Issue: "Invalid token"

#### Symptoms

- Error: "Invalid token" or "Authentication failed"
- Cannot connect to Stream services
- Token validation fails

#### Solutions

**Solution 1: Verify Token Generation**

```typescript
// Server-side token generation
import { StreamChat } from "stream-chat";

const serverClient = StreamChat.getInstance(apiKey, apiSecret);

export async function chatTokenProvider(userId: string) {
  if (!userId) {
    throw new Error("User ID is required for token generation");
  }

  try {
    // Generate token with user ID
    const token = serverClient.createToken(userId);
    console.log(`Token created for user: ${userId}`);
    console.log(`Token length: ${token.length}`);

    return token;
  } catch (error) {
    console.error("Token generation error:", error);
    throw new Error(`Failed to generate token: ${error.message}`);
  }
}
```

**Solution 2: Check API Credentials**

```typescript
// Verify credentials are correct
const apiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;
const apiSecret = process.env.STREAM_API_SECRET;

if (!apiKey || !apiSecret) {
  console.error("Missing Stream API credentials");
  throw new Error("Stream API credentials not configured");
}

console.log("API Key:", apiKey.substring(0, 10) + "...");
console.log("API Secret:", apiSecret ? "Set" : "Missing");
```

**Solution 3: Validate User ID Format**

```typescript
function validateUserId(userId: string) {
  // Stream user IDs must be alphanumeric + underscores/hyphens
  const validPattern = /^[a-zA-Z0-9_-]+$/;

  if (!validPattern.test(userId)) {
    throw new Error(
      `Invalid user ID format: ${userId}. ` +
        `Must contain only letters, numbers, hyphens, and underscores.`,
    );
  }

  return true;
}

// Use before token generation
validateUserId(userId);
const token = await chatTokenProvider(userId);
```

---

## Channel Issues

### Issue: "Channel not found"

#### Symptoms

- Error: "Channel not found" or "Channel does not exist"
- Cannot load chat channel
- 404 error on channel query

#### Solutions

**Solution 1: Create Channel if Missing**

```typescript
async function getOrCreateChannel(
  client: StreamChat,
  channelType: string,
  channelId: string,
  members: string[],
) {
  try {
    // Try to get existing channel
    const channel = client.channel(channelType, channelId, {
      members,
    });

    await channel.watch();
    console.log("Channel found:", channelId);
    return channel;
  } catch (error) {
    if (error.message.includes("not found")) {
      console.log("Channel not found, creating:", channelId);

      // Create new channel
      const channel = client.channel(channelType, channelId, {
        members,
        created_by_id: client.userID,
      });

      await channel.create();
      console.log("Channel created:", channelId);
      return channel;
    }
    throw error;
  }
}
```

**Solution 2: Verify Channel Sync**

```typescript
// Ensure channel is synced from database
import { syncUserEventChannels } from "@/actions/stream/chat/event-channel.action";

useEffect(() => {
  const syncChannels = async () => {
    try {
      await syncUserEventChannels(userId);
      console.log("Channels synced for user:", userId);
    } catch (error) {
      console.error("Channel sync failed:", error);
    }
  };

  syncChannels();
}, [userId]);
```

**Solution 3: Check Channel Membership**

```typescript
async function verifyChannelMembership(
  client: StreamChat,
  channelId: string,
  userId: string,
) {
  try {
    const channel = client.channel("messaging", channelId);
    const state = await channel.watch();

    const isMember = Object.keys(state.members).includes(userId);

    if (!isMember) {
      console.warn(`User ${userId} is not a member of channel ${channelId}`);
      // Add user to channel
      await channel.addMembers([userId]);
      console.log(`User ${userId} added to channel ${channelId}`);
    }

    return channel;
  } catch (error) {
    console.error("Channel membership check failed:", error);
    throw error;
  }
}
```

---

### Issue: "Permission denied"

#### Symptoms

- Error: "Permission denied"
- Cannot send messages
- Cannot access channel

#### Solutions

**Solution 1: Check User Role**

```typescript
// Verify user has correct Stream role
import { mapRoleToStream } from "@/lib/user";

const userRole = userDetails.role; // "CONSULTANT", "CONSULTEE", etc.
const streamRole = mapRoleToStream(userRole);

console.log("User role:", userRole);
console.log("Stream role:", streamRole);

// Roles: "admin", "user", "guest", "channel_moderator"
```

**Solution 2: Update Channel Permissions**

```typescript
async function updateChannelPermissions(channelId: string, userId: string) {
  try {
    const channel = client.channel("messaging", channelId);

    // Add user as moderator if needed
    await channel.addModerators([userId]);

    console.log(`User ${userId} granted moderator permissions`);
  } catch (error) {
    console.error("Failed to update permissions:", error);
  }
}
```

**Solution 3: Verify Channel Type Permissions**

Different channel types have different permissions. Check your channel type configuration in Stream dashboard.

```typescript
// Use correct channel type
const channel = client.channel("messaging", channelId); // Not 'livestream', etc.
```

---

### Issue: Missing Members

#### Symptoms

- Expected members not showing in channel
- User cannot see channel messages
- Channel appears empty

#### Solutions

**Solution 1: Add Members to Channel**

```typescript
async function addMembersToChannel(
  client: StreamChat,
  channelId: string,
  memberIds: string[],
) {
  try {
    const channel = client.channel("messaging", channelId);
    await channel.addMembers(memberIds);

    console.log(`Added ${memberIds.length} members to channel ${channelId}`);
  } catch (error) {
    console.error("Failed to add members:", error);
    throw error;
  }
}

// Usage
await addMembersToChannel(client, "consultation-123", [
  "consultant-user-id",
  "consultee-user-id",
]);
```

**Solution 2: Verify Member IDs**

```typescript
// Check if member IDs are correct
async function verifyMembers(
  client: StreamChat,
  channelId: string,
  expectedMembers: string[],
) {
  const channel = client.channel("messaging", channelId);
  const state = await channel.watch();

  const actualMembers = Object.keys(state.members);
  const missingMembers = expectedMembers.filter(
    (id) => !actualMembers.includes(id),
  );

  if (missingMembers.length > 0) {
    console.warn("Missing members:", missingMembers);
    // Add missing members
    await channel.addMembers(missingMembers);
  }

  return actualMembers;
}
```

---

## Meeting Issues

### Issue: Cannot Join Meeting

#### Symptoms

- "Failed to join call" error
- Call not loading
- Stuck on joining screen

#### Solutions

**Solution 1: Verify Call Exists**

```typescript
const { call, isCallLoading, error } = useGetCallById(callId);

if (error) {
  console.error("Call retrieval error:", error);

  if (error.message.includes("not found")) {
    // Call doesn't exist, create it
    try {
      const newCall = client.call("default", callId);
      await newCall.getOrCreate();
      console.log("Call created:", callId);
    } catch (createError) {
      console.error("Call creation failed:", createError);
    }
  }
}
```

**Solution 2: Check Call Permissions**

```typescript
async function checkCallPermissions(call: Call, userId: string) {
  try {
    // Verify user can join
    const callState = await call.get();

    console.log("Call state:", callState);
    console.log("Current user:", userId);

    // Check if call has restrictions
    if (callState.settings?.audio?.access_request_enabled) {
      console.log("Call requires access request");
    }
  } catch (error) {
    console.error("Failed to check call permissions:", error);
  }
}
```

**Solution 3: Join with Error Handling**

```typescript
async function joinCallSafely(call: Call) {
  try {
    await call.join();
    console.log("Successfully joined call");
  } catch (error) {
    console.error("Failed to join call:", error);

    if (error.message.includes("permission")) {
      // Request permission
      await call.requestPermission();
    } else if (error.message.includes("not found")) {
      // Recreate call
      await call.getOrCreate();
      await call.join();
    } else {
      throw error;
    }
  }
}
```

---

### Issue: Call Not Found

#### Symptoms

- "Call not found" error from `useGetCallById`
- Call query returns empty array
- Cannot retrieve existing call

#### Solutions

**Solution 1: Debug Call Query**

```typescript
// In useGetCallById hook
const { calls } = await client.queryCalls({
  filter_conditions: { id: callId },
});

console.log(`Query result: found ${calls.length} calls for ID ${callId}`);

if (calls.length === 0) {
  console.log("No call found, checking if ID is correct...");
  console.log("Call ID:", callId);
  console.log("Client user:", client.user?.id);
}
```

**Solution 2: Create Call Explicitly**

```typescript
// If query fails, create call
if (calls.length === 0) {
  console.log(`Creating new call with ID: ${callId}`);

  try {
    const callInstance = client.call("default", callId);
    await callInstance.getOrCreate();
    console.log(`Successfully created/retrieved call: ${callInstance.id}`);
    setCall(callInstance);
  } catch (error) {
    console.error("Call creation failed:", error);
  }
}
```

---

### Issue: Audio/Video Not Working

#### Symptoms

- Microphone not capturing audio
- Camera not showing video
- Permissions denied
- No media devices found

#### Solutions

**Solution 1: Check Browser Permissions**

```typescript
async function checkMediaPermissions() {
  try {
    // Request permissions
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true,
    });

    console.log("Media permissions granted");
    console.log("Audio tracks:", stream.getAudioTracks().length);
    console.log("Video tracks:", stream.getVideoTracks().length);

    // Clean up
    stream.getTracks().forEach((track) => track.stop());

    return true;
  } catch (error) {
    console.error("Media permission denied:", error);

    if (error.name === "NotAllowedError") {
      alert("Please allow camera and microphone access");
    } else if (error.name === "NotFoundError") {
      alert("No camera or microphone found");
    }

    return false;
  }
}

// Check before joining call
const hasPermissions = await checkMediaPermissions();
if (hasPermissions) {
  await call.join();
}
```

**Solution 2: List Available Devices**

```typescript
async function listMediaDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();

    const audioInputs = devices.filter((d) => d.kind === "audioinput");
    const videoInputs = devices.filter((d) => d.kind === "videoinput");

    console.log("Audio inputs:", audioInputs.length);
    console.log("Video inputs:", videoInputs.length);

    audioInputs.forEach((device) => {
      console.log(`Microphone: ${device.label || "Unknown"}`);
    });

    videoInputs.forEach((device) => {
      console.log(`Camera: ${device.label || "Unknown"}`);
    });

    return { audioInputs, videoInputs };
  } catch (error) {
    console.error("Failed to enumerate devices:", error);
    return { audioInputs: [], videoInputs: [] };
  }
}
```

**Solution 3: Enable Devices in Call**

```typescript
async function enableMediaDevices(call: Call) {
  try {
    // Enable microphone
    await call.microphone.enable();
    console.log("Microphone enabled");

    // Enable camera
    await call.camera.enable();
    console.log("Camera enabled");
  } catch (error) {
    console.error("Failed to enable devices:", error);

    if (error.message.includes("permission")) {
      // Request permissions first
      await checkMediaPermissions();
      // Retry
      await enableMediaDevices(call);
    }
  }
}
```

---

## Common Error Messages

### Error: "StreamVideoClient not available"

**Cause:** `useStreamVideoClient` called outside of `StreamVideo` provider.

**Solution:**

```typescript
// Ensure component is wrapped
<StreamProvider userId={userId} enableVideo={true}>
  <YourComponent /> {/* Can use useStreamVideoClient here */}
</StreamProvider>
```

---

### Error: "useStreamConnection must be used within StreamProvider"

**Cause:** Hook called outside provider context.

**Solution:**

```typescript
// Move component inside provider
<StreamProvider userId={userId}>
  <ComponentUsingHook />
</StreamProvider>
```

---

### Error: "Call ID is required"

**Cause:** `useGetCallById` called with empty or undefined `callId`.

**Solution:**

```typescript
// Validate callId before using hook
function MeetingPage({ params }: { params: { id: string } }) {
  const callId = params.id;

  if (!callId) {
    return <div>Invalid meeting ID</div>;
  }

  const { call } = useGetCallById(callId);
  return <Meeting call={call} />;
}
```

---

### Error: "Maximum retry attempts reached"

**Cause:** Connection failed after 5 retry attempts.

**Solution:**

```typescript
const { error, retryConnection } = useStreamConnection();

if (error && error.includes("Maximum retry")) {
  // Show user option to manually retry
  return (
    <div>
      <p>Connection failed after multiple attempts</p>
      <button onClick={retryConnection}>Try Again</button>
    </div>
  );
}
```

---

## Debug Tools

### Stream Debug API

Use the built-in debug endpoint to inspect user channels and data.

```bash
# Get user debug info
curl -X GET "http://localhost:3000/api/stream/debug?userId=USER_ID"
```

**Response includes:**

- User details
- All channels user is member of
- Consultations, subscriptions, webinars, classes
- Channel member counts
- Message counts

**Example:**

```json
{
  "success": true,
  "user": {
    "id": "user_123",
    "name": "John Doe",
    "email": "john@example.com",
    "role": "CONSULTANT"
  },
  "channels": [
    {
      "id": "consultation-456",
      "type": "messaging",
      "name": "Consultation Channel",
      "members": ["user_123", "user_789"],
      "memberCount": 2,
      "messageCount": 15
    }
  ],
  "consultations": [],
  "subscriptions": []
}
```

---

### Browser Console Commands

Add these debugging helpers to your components:

```typescript
// Add to window in development mode
if (process.env.NODE_ENV === "development") {
  window.debugStream = {
    // Get current connection state
    getConnectionState: () => {
      const state = useStreamConnection();
      console.table({
        chatConnected: state.chatConnected,
        videoConnected: state.videoConnected,
        isConnecting: state.isConnecting,
        error: state.error,
      });
    },

    // Get video client info
    getVideoClient: () => {
      const client = useStreamVideoClient();
      console.log("Video client:", client);
      console.log("User:", client?.user);
      console.log("User ID:", client?.user?.id);
    },

    // Get chat client info
    getChatClient: () => {
      const { client } = useChatContext();
      console.log("Chat client:", client);
      console.log("User:", client.user);
      console.log("Connection state:", client.connectionState);
    },

    // List active calls
    listCalls: async () => {
      const client = useStreamVideoClient();
      const { calls } = await client.queryCalls({});
      console.log(`Found ${calls.length} calls`);
      calls.forEach((call) => {
        console.log(`- ${call.id} (${call.type})`);
      });
    },

    // List user channels
    listChannels: async () => {
      const { client } = useChatContext();
      const channels = await client.queryChannels({
        members: { $in: [client.userID] },
      });
      console.log(`Found ${channels.length} channels`);
      channels.forEach((channel) => {
        console.log(`- ${channel.id} (${channel.type})`);
      });
    },
  };
}
```

**Usage in console:**

```javascript
// Check connection state
window.debugStream.getConnectionState();

// List all channels
await window.debugStream.listChannels();

// List all calls
await window.debugStream.listCalls();
```

---

### Stream CLI (Official)

Install Stream's official CLI for advanced debugging:

```bash
npm install -g stream-cli
```

**Login:**

```bash
stream-cli auth:login
```

**Useful commands:**

```bash
# List users
stream-cli chat:user:list

# Get user details
stream-cli chat:user:get USER_ID

# List channels
stream-cli chat:channel:list

# Get channel details
stream-cli chat:channel:get CHANNEL_TYPE CHANNEL_ID

# Delete channel
stream-cli chat:channel:delete CHANNEL_TYPE CHANNEL_ID

# Create token for user
stream-cli chat:token:create USER_ID

# List video calls
stream-cli video:call:list

# Get call details
stream-cli video:call:get CALL_TYPE CALL_ID
```

---

## Server Log Analysis

### Enable Detailed Logging

Add comprehensive logging to your Stream operations:

```typescript
// providers/StreamProvider.tsx
const connectChat = async () => {
  console.log("=== CHAT CONNECTION START ===");
  console.log("User ID:", userDetails.id);
  console.log("API Key:", apiKey?.substring(0, 10) + "...");
  console.log("Timestamp:", new Date().toISOString());

  try {
    console.log("Creating StreamChat instance...");
    const client = StreamChat.getInstance(apiKey);

    console.log("Upserting user to Stream...");
    await upsertUserToStream(userDetails.id);

    console.log("Generating token...");
    const token = await getCachedToken("chat");
    console.log("Token length:", token.length);

    console.log("Connecting user...");
    await client.connectUser(
      {
        id: userDetails.id,
        name: userDetails.name ?? userDetails.id,
        image: userDetails.image ?? undefined,
        role: mapRoleToStream(userDetails.role),
      },
      token,
    );

    console.log("=== CHAT CONNECTION SUCCESS ===");
  } catch (error) {
    console.error("=== CHAT CONNECTION FAILED ===");
    console.error("Error:", error);
    console.error("Stack:", error.stack);
    throw error;
  }
};
```

### Log Patterns to Watch

**Success pattern:**

```
=== CHAT CONNECTION START ===
User ID: user_123
API Key: abcd1234...
Creating StreamChat instance...
Upserting user to Stream...
Generating token...
Token length: 189
Connecting user...
=== CHAT CONNECTION SUCCESS ===
```

**Failure pattern - Token:**

```
=== CHAT CONNECTION START ===
User ID: user_123
API Key: abcd1234...
Creating StreamChat instance...
Upserting user to Stream...
Generating token...
=== CHAT CONNECTION FAILED ===
Error: Token generation failed
```

**Failure pattern - Network:**

```
=== CHAT CONNECTION START ===
User ID: user_123
API Key: abcd1234...
Creating StreamChat instance...
Upserting user to Stream...
Generating token...
Token length: 189
Connecting user...
=== CHAT CONNECTION FAILED ===
Error: Network request failed
```

---

## Browser Console Inspection

### Check Network Requests

1. **Open DevTools** (F12 or Cmd+Opt+I)
2. **Go to Network tab**
3. **Filter by "stream"**

Look for:

- WebSocket connections to `wss://chat.stream-io-api.com`
- API requests to `https://chat.stream-io-api.com`
- Failed requests (red)
- Slow requests (waterfall timing)

### Check Console Errors

Common console error patterns:

**Token expiry:**

```
Error: TokenExpired: token expired
  at StreamChat.connectUser
```

**Network issues:**

```
Error: NetworkError: Failed to fetch
  at StreamChat.queryCalls
```

**Permission issues:**

```
Error: PermissionDenied: User does not have permission
  at Channel.sendMessage
```

### React DevTools

Install React DevTools extension:

1. **Find StreamProvider** in component tree
2. **Check props:**
   - `userId` is set
   - `enableChat` is true
   - `enableVideo` is true
3. **Check state:**
   - `chatConnected` status
   - `videoConnected` status
   - `error` message

### Application Tab

Check stored data:

1. **LocalStorage** - May contain cached data
2. **SessionStorage** - Temporary session data
3. **Cookies** - Authentication cookies
4. **IndexedDB** - Stream offline data

---

## Advanced Debugging

### Enable Stream Debug Mode

```typescript
import { StreamChat } from "stream-chat";

const client = StreamChat.getInstance(apiKey, {
  enableInsights: true,
  logLevel: "debug",
});
```

### Monitor Connection State

```typescript
function ConnectionMonitor() {
  const { client } = useChatContext();

  useEffect(() => {
    if (!client) return;

    const handleConnectionChange = (event: any) => {
      console.log("Connection changed:", event);
    };

    client.on("connection.changed", handleConnectionChange);
    client.on("connection.recovered", () => {
      console.log("Connection recovered");
    });

    return () => {
      client.off("connection.changed", handleConnectionChange);
    };
  }, [client]);

  return null;
}
```

### Track All Events

```typescript
function EventLogger() {
  const { client } = useChatContext();

  useEffect(() => {
    if (!client) return;

    // Log all events
    const unsubscribe = client.on((event) => {
      console.log("Stream event:", event.type, event);
    });

    return unsubscribe;
  }, [client]);

  return null;
}
```

---

## Getting Help

If you're still experiencing issues:

1. **Review Error Handling**: See [Error Handling](./12-error-handling.md)
2. **Consult Stream Docs**: https://getstream.io/chat/docs/
3. **Contact Support**: support@getstream.io
4. **Check Status Page**: https://status.stream-io-api.com/

---

## Next Steps

- Review [Error Handling](./12-error-handling.md)
- Learn about [Hooks & Utilities](./11-hooks-utilities.md)
- Check [Recording & Webhooks](./13-recording-webhooks.md)
- Return to [Architecture](./01-architecture.md)

---

**Last Updated:** 2025-01-22
