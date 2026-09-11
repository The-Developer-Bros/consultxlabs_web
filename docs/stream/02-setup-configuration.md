# 02. Setup & Configuration

> Complete guide for setting up Stream SDK integration in Familiarise

## Table of Contents

- [Environment Variables](#environment-variables)
- [Package Installation](#package-installation)
- [Stream Dashboard Setup](#stream-dashboard-setup)
- [Code Integration](#code-integration)
- [Minimal Working Example](#minimal-working-example)
- [Environment Validation](#environment-validation)
- [Common Setup Errors](#common-setup-errors)
- [Next.js Specific Configuration](#nextjs-specific-configuration)

---

## Environment Variables

### Required Variables

Stream SDK requires **3 critical environment variables** for operation:

```env
# Stream API Credentials (Required)
NEXT_PUBLIC_STREAM_API_KEY=your_stream_api_key_here
STREAM_API_SECRET=your_stream_api_secret_here

# Database Connection (Required for user sync)
DATABASE_URL=postgresql://user:password@host:5432/database

# Optional: Background Sync Job Protection
STREAM_SYNC_SECRET=your_secret_for_sync_endpoint
```

### Variable Breakdown

| Variable                     | Scope            | Purpose                         | Security   |
| ---------------------------- | ---------------- | ------------------------------- | ---------- |
| `NEXT_PUBLIC_STREAM_API_KEY` | Public (Client)  | Identifies your Stream app      | Public     |
| `STREAM_API_SECRET`          | Private (Server) | Authenticates server operations | **SECRET** |
| `DATABASE_URL`               | Private (Server) | User data for token generation  | **SECRET** |
| `STREAM_SYNC_SECRET`         | Private (Server) | Protects sync API endpoint      | **SECRET** |

⚠️ **Security Warning:**

- `NEXT_PUBLIC_` prefix makes variables accessible to the browser
- **NEVER** prefix `STREAM_API_SECRET` with `NEXT_PUBLIC_`
- Keep secrets in server-side code only

### Getting Stream Credentials

#### Step 1: Create Stream Account

1. Visit [getstream.io](https://getstream.io)
2. Sign up for a free account
3. Verify your email address

#### Step 2: Create Application

1. Navigate to **Dashboard** → **Create New App**
2. Choose app name (e.g., "Familiarise Dev")
3. Select region closest to your users
   - 🇺🇸 US East (Virginia)
   - 🇪🇺 EU West (Ireland)
   - 🇸🇬 Singapore
   - 🇦🇺 Australia

#### Step 3: Retrieve Credentials

1. Navigate to **Dashboard** → **Your App** → **App Settings**
2. Copy **API Key** (format: `xxxxxxxxxxxxx`)
3. Copy **API Secret** (format: `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`)

#### Step 4: Add to Environment File

**For Development:**

```bash
# .env.local (never commit this file!)
NEXT_PUBLIC_STREAM_API_KEY=your_key_here
STREAM_API_SECRET=your_secret_here
DATABASE_URL=postgresql://...
```

**For Production:**

```bash
# Set in Vercel/Railway/hosting platform
NEXT_PUBLIC_STREAM_API_KEY=prod_key
STREAM_API_SECRET=prod_secret
DATABASE_URL=postgresql://...
STREAM_SYNC_SECRET=random_secure_string
```

### Environment File Template

Create `.env.example` in your project root:

```env
# Stream API Credentials
NEXT_PUBLIC_STREAM_API_KEY=""
STREAM_API_KEY=""
STREAM_API_SECRET=""
STREAM_SYNC_SECRET=""

# Database
DATABASE_URL=""
DIRECT_URL=""

# Better Auth
NEXTAUTH_SECRET=""
NEXTAUTH_URL=""

# Other services...
```

---

## Package Installation

Stream SDK consists of **4 separate packages**, each serving a specific purpose.

### Required Packages

```json
{
  "dependencies": {
    "@stream-io/node-sdk": "^0.4.17",
    "@stream-io/video-react-sdk": "^1.12.6",
    "stream-chat": "^8.57.6",
    "stream-chat-react": "^12.13.1"
  }
}
```

### Installation Steps

#### Option 1: Install All at Once

```bash
npm install \
  @stream-io/node-sdk@^0.4.17 \
  @stream-io/video-react-sdk@^1.12.6 \
  stream-chat@^8.57.6 \
  stream-chat-react@^12.13.1
```

#### Option 2: Install Individually

```bash
# Server SDK (for token generation, server actions)
npm install @stream-io/node-sdk

# Video SDK (for video calls and meetings)
npm install @stream-io/video-react-sdk

# Chat SDK Core (for messaging functionality)
npm install stream-chat

# Chat React Components (UI components)
npm install stream-chat-react
```

### Package Purposes

| Package                      | Purpose                      | Used In                                |
| ---------------------------- | ---------------------------- | -------------------------------------- |
| `@stream-io/node-sdk`        | Server-side token generation | `actions/stream/chat/stream.action.ts` |
| `@stream-io/video-react-sdk` | Video client & UI            | `providers/StreamProvider.tsx`         |
| `stream-chat`                | Chat client core             | `providers/StreamProvider.tsx`         |
| `stream-chat-react`          | Chat UI components           | Chat components                        |

### Peer Dependencies

Ensure you have React installed (already in Next.js):

```json
{
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  }
}
```

### Verify Installation

```bash
# Check installed versions
npm list @stream-io/node-sdk
npm list @stream-io/video-react-sdk
npm list stream-chat
npm list stream-chat-react
```

**Expected Output:**

```
familiarise_web@0.2.0 /path/to/project
├── @stream-io/node-sdk@0.4.17
├── @stream-io/video-react-sdk@1.12.6
├── stream-chat@8.57.6
└── stream-chat-react@12.13.1
```

### Import Stream CSS

Stream CSS is imported inside `providers/StreamProvider.tsx`, co-located with the provider that renders Stream UI components:

```typescript
// providers/StreamProvider.tsx
import "stream-chat-react/dist/css/v2/index.css";
import "@stream-io/video-react-sdk/dist/css/styles.css";
```

⚠️ **Important:** Import CSS **before** your custom styles to allow overrides. Do not import in `app/layout.tsx` — the CSS is scoped to the provider that owns the Stream UI.

---

## Stream Dashboard Setup

### 1. Configure Channel Types

**Navigation:** Dashboard → Chat → Channel Types

Stream provides default channel types. For Familiarise, configure:

#### messaging (1-on-1 Chats)

| Setting           | Value       | Purpose             |
| ----------------- | ----------- | ------------------- |
| Type Name         | `messaging` | Built-in type       |
| Max Members       | 10          | Small group chats   |
| Read Events       | ✅ Enabled  | Show read receipts  |
| Reactions         | ✅ Enabled  | Message reactions   |
| Replies           | ✅ Enabled  | Threaded replies    |
| Typing Indicators | ✅ Enabled  | "User is typing..." |

**Use Cases:**

- Direct consultations
- 1-on-1 subscription chats
- Private conversations

#### team (Group Channels)

| Setting            | Value      | Purpose          |
| ------------------ | ---------- | ---------------- |
| Type Name          | `team`     | Built-in type    |
| Max Members        | Unlimited  | Large events     |
| Read Events        | ✅ Enabled | Track attendance |
| Reactions          | ✅ Enabled | Engagement       |
| Replies            | ✅ Enabled | Discussions      |
| Push Notifications | ✅ Enabled | Event updates    |

**Use Cases:**

- Webinars (broadcast + Q&A)
- Online classes (instructor + students)
- Group events

### 2. Set Up Roles & Permissions

**Navigation:** Dashboard → Chat → Roles & Permissions

⚠️ **CRITICAL BUG:** Currently all users get "admin" role regardless of actual role.
See: [Troubleshooting - Universal Admin Role](./troubleshooting.md#universal-admin-role-critical)

#### Built-in Roles

Stream provides these default roles:

```typescript
// admin (currently used for everyone)
{
  name: "admin",
  permissions: ["*"] // Full access to all operations
}

// user (standard permissions)
{
  name: "user",
  permissions: [
    "read-channel",
    "send-message",
    "delete-own-message",
    "update-own-message",
    "upload-file"
  ]
}

// channel_moderator (channel-level moderation)
{
  name: "channel_moderator",
  permissions: [
    "*user-permissions*",
    "delete-any-message",
    "ban-channel-members",
    "update-channel"
  ]
}

// anonymous (read-only)
{
  name: "anonymous",
  permissions: [
    "read-channel"
  ]
}
```

#### Intended Role Mapping

**Once bug is fixed**, roles should map as follows:

| App Role     | Stream Role         | Permissions               |
| ------------ | ------------------- | ------------------------- |
| `ADMIN`      | `admin`             | Full system access        |
| `CONSULTANT` | `channel_moderator` | Create channels, moderate |
| `CONSULTEE`  | `user`              | Read, send messages       |
| `USER`       | `user`              | Standard permissions      |

**Implementation Location:** `lib/user.ts:98-115` (`mapRoleToStream` function)

### 3. Enable Chat Features

**Navigation:** Dashboard → Chat → Settings

Enable these features:

| Feature            | Status    | Purpose                      |
| ------------------ | --------- | ---------------------------- |
| Message Search     | ✅ Enable | Search chat history          |
| Push Notifications | ✅ Enable | Mobile/browser notifications |
| Typing Indicators  | ✅ Enable | Real-time typing status      |
| Read Receipts      | ✅ Enable | Message read status          |
| Reactions          | ✅ Enable | Emoji reactions              |
| Threads            | ✅ Enable | Reply threading              |
| URL Enrichment     | ✅ Enable | Link previews                |
| File Uploads       | ✅ Enable | Image/document sharing       |

### 4. Configure Video Settings

**Navigation:** Dashboard → Video → Settings

| Setting            | Recommended Value | Notes                   |
| ------------------ | ----------------- | ----------------------- |
| Default Call Type  | `default`         | Basic video calls       |
| Max Participants   | 100               | Adjust per needs        |
| Recording          | Optional          | Enable if needed        |
| Screen Sharing     | ✅ Enable         | For presentations       |
| Picture-in-Picture | ✅ Enable         | Multitasking            |
| Video Quality      | Auto              | Adapts to bandwidth     |
| Backstage Mode     | ✅ Enable         | Pre-call prep for hosts |

### 5. Security Settings

**Navigation:** Dashboard → Security

| Setting            | Value     | Purpose                     |
| ------------------ | --------- | --------------------------- |
| Token Validity     | 1 hour    | Automatic token expiry      |
| API Rate Limits    | Default   | Prevent abuse               |
| Webhook Signatures | ✅ Enable | Verify webhook authenticity |
| IP Allowlist       | Optional  | Restrict server IPs         |

---

## Code Integration

### Integration Checklist

Follow these steps to integrate Stream SDK into your Next.js application:

- [ ] **Step 1:** Environment variables added to `.env.local`
- [ ] **Step 2:** All 4 Stream packages installed
- [ ] **Step 3:** CSS styles imported in `providers/StreamProvider.tsx`
- [ ] **Step 4:** Token providers created (server actions)
- [ ] **Step 5:** StreamProvider component created
- [ ] **Step 6:** App wrapped with StreamProvider
- [ ] **Step 7:** Error boundary integrated
- [ ] **Step 8:** Connection verified in browser

### Step 1: Create Token Providers

**File:** `actions/stream/chat/stream.action.ts`

```typescript
"use server";

import { fetchUserDetails, mapRoleToStream } from "@/lib/user";
import { StreamClient } from "@stream-io/node-sdk";
import { StreamChat } from "stream-chat";

const apiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;
const apiSecret = process.env.STREAM_API_SECRET;

// Video token provider (Stream Video)
export const tokenProvider = async (userId: string) => {
  try {
    const userDetails = await fetchUserDetails(userId);

    if (!userDetails) throw new Error("User not found");
    if (!apiKey) throw new Error("Stream API key not configured");
    if (!apiSecret) throw new Error("Stream API secret not configured");

    const client = new StreamClient(apiKey, apiSecret);

    const exp = Math.round(Date.now() / 1000) + 60 * 60; // 1 hour
    const issued = Math.round(Date.now() / 1000) - 60; // 1 minute ago

    const streamRole = mapRoleToStream(userDetails.role);

    console.log(
      `Generating token for user ${userDetails.id} with role ${streamRole}`,
    );

    // Generate user token with the correct payload structure
    const token = client.generateUserToken({
      user_id: userDetails.id,
      exp,
      iat: issued,
    });

    return token;
  } catch (error) {
    console.error("Error generating token:", error);
    throw error;
  }
};

// Chat token provider (Stream Chat)
export const chatTokenProvider = async (userId: string) => {
  try {
    if (!apiKey) throw new Error("Stream API key not configured");
    if (!apiSecret) throw new Error("Stream API secret not configured");

    const userDetails = await fetchUserDetails(userId);
    if (!userDetails) throw new Error("User not found");

    const serverClient = StreamChat.getInstance(apiKey, apiSecret);
    const token = serverClient.createToken(userDetails.id);
    return token;
  } catch (error) {
    console.error("Error generating chat token:", error);
    throw error;
  }
};
```

**Key Points:**

- Server actions (must have `"use server"` directive)
- Tokens valid for 1 hour
- Separate providers for chat and video
- User validation before token generation

### Step 2: Create StreamProvider

**File:** `providers/StreamProvider.tsx` (already exists in codebase)

This provider manages both chat and video client connections. See the actual implementation in the file for complete details.

**Key Features:**

- Dual-client pattern (chat + video)
- Token caching (50-minute cache for 1-hour tokens)
- Connection state management
- Exponential backoff retry logic
- Error boundary integration

### Step 3: Wrap Application

**File:** `app/layout.tsx`

```typescript
import StreamProvider from "@/providers/StreamProvider";
import { headers } from "next/headers";

import { auth } from "@/lib/auth";

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth.api.getSession({ headers: await headers() });

  return (
    <html lang="en">
      <body>
        {session?.user?.id ? (
          <StreamProvider
            userId={session.user.id}
            enableChat={true}
            enableVideo={true}
          >
            {children}
          </StreamProvider>
        ) : (
          // Unauthenticated users don't need Stream
          children
        )}
      </body>
    </html>
  );
}
```

**Props:**

- `userId` - Authenticated user ID (required)
- `enableChat` - Enable chat client (default: true)
- `enableVideo` - Enable video client (default: true)

---

## Minimal Working Example

Complete minimal setup to verify Stream integration:

### 1. Environment Setup

```bash
# .env.local
NEXT_PUBLIC_STREAM_API_KEY=your_key
STREAM_API_SECRET=your_secret
DATABASE_URL=postgresql://...
```

### 2. Install Packages

```bash
npm install @stream-io/node-sdk @stream-io/video-react-sdk stream-chat stream-chat-react
```

### 3. Create Test Page

**File:** `app/stream-test/page.tsx`

```typescript
"use client";

import { useStreamConnection } from "@/providers/StreamProvider";

export default function StreamTestPage() {
  const { chatConnected, videoConnected, isConnecting, error } = useStreamConnection();

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-4">Stream Connection Test</h1>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span>Chat:</span>
          {isConnecting ? (
            <span className="text-yellow-600">Connecting...</span>
          ) : chatConnected ? (
            <span className="text-green-600">✅ Connected</span>
          ) : (
            <span className="text-red-600">❌ Disconnected</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span>Video:</span>
          {isConnecting ? (
            <span className="text-yellow-600">Connecting...</span>
          ) : videoConnected ? (
            <span className="text-green-600">✅ Connected</span>
          ) : (
            <span className="text-red-600">❌ Disconnected</span>
          )}
        </div>

        {error && (
          <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded">
            <p className="text-red-700 font-medium">Error:</p>
            <p className="text-red-600 text-sm">{error}</p>
          </div>
        )}
      </div>
    </div>
  );
}
```

### 4. Test the Connection

1. Start dev server: `npm run dev`
2. Navigate to `/stream-test`
3. Check for green checkmarks
4. Open browser console for debug logs

**Expected Console Output:**

```
Connecting user user_123 to Stream Chat
Chat connection successful for user user_123
Video connection successful for user user_123
```

---

## Environment Validation

### Validation Function

Create a helper to validate environment variables at runtime:

**File:** `lib/env-validation.ts`

```typescript
export function validateStreamEnv() {
  const errors: string[] = [];

  // Check public API key
  const apiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;
  if (!apiKey) {
    errors.push("NEXT_PUBLIC_STREAM_API_KEY is not set");
  } else if (apiKey.length < 10) {
    errors.push("NEXT_PUBLIC_STREAM_API_KEY appears invalid (too short)");
  }

  // Check secret (server-side only)
  if (typeof window === "undefined") {
    const apiSecret = process.env.STREAM_API_SECRET;
    if (!apiSecret) {
      errors.push("STREAM_API_SECRET is not set");
    } else if (apiSecret.length < 20) {
      errors.push("STREAM_API_SECRET appears invalid (too short)");
    }

    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      errors.push("DATABASE_URL is not set (required for user sync)");
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Stream environment validation failed:\n${errors.join("\n")}`,
    );
  }

  return {
    apiKey,
    apiSecret: process.env.STREAM_API_SECRET,
    databaseUrl: process.env.DATABASE_URL,
  };
}
```

### Usage in Provider

```typescript
// providers/StreamProvider.tsx
import { validateStreamEnv } from "@/lib/env-validation";

export default function StreamProvider({ children, userId }: Props) {
  useEffect(() => {
    try {
      validateStreamEnv();
    } catch (error) {
      console.error("Environment validation failed:", error);
      setError(error.message);
    }
  }, []);

  // Rest of provider code...
}
```

### Startup Check Script

**File:** `scripts/check-stream-env.ts`

```typescript
import { validateStreamEnv } from "../lib/env-validation";

try {
  console.log("Checking Stream environment variables...");
  const env = validateStreamEnv();
  console.log("✅ All Stream environment variables are valid");
  console.log(`   API Key: ${env.apiKey.substring(0, 10)}...`);
} catch (error) {
  console.error("❌ Environment validation failed:");
  console.error(error.message);
  process.exit(1);
}
```

Run before deployment:

```bash
npx ts-node scripts/check-stream-env.ts
```

---

## Common Setup Errors

### Error 1: "API Key Not Defined"

**Full Error:**

```
Error: NEXT_PUBLIC_STREAM_API_KEY is not set
```

**Cause:** Environment variable not loaded

**Solutions:**

1. **Check file exists:**

   ```bash
   ls -la .env.local
   ```

2. **Verify variable name:**

   ```env
   # ✅ Correct (with NEXT_PUBLIC_ prefix)
   NEXT_PUBLIC_STREAM_API_KEY=abc123

   # ❌ Wrong (missing prefix)
   STREAM_API_KEY=abc123
   ```

3. **Restart dev server:**

   ```bash
   # Kill existing process
   # Restart
   npm run dev
   ```

4. **Check Next.js environment:**
   ```typescript
   // In a client component
   console.log(process.env.NEXT_PUBLIC_STREAM_API_KEY); // Should not be undefined
   ```

### Error 2: "Invalid API Secret"

**Full Error:**

```
StreamChat error: Invalid API secret
```

**Cause:** Wrong secret or extra characters

**Solutions:**

1. **Verify secret from dashboard:**
   - Login to Stream dashboard
   - Navigate to App Settings
   - Copy secret exactly (no spaces)

2. **Check for quotes/spaces:**

   ```env
   # ❌ Wrong (has quotes)
   STREAM_API_SECRET="abc123"

   # ✅ Correct (no quotes)
   STREAM_API_SECRET=abc123
   ```

3. **Ensure using correct app:**
   - Dev environment → Dev app
   - Production environment → Production app

### Error 3: "Module Not Found"

**Full Error:**

```
Cannot find module 'stream-chat'
```

**Cause:** Package not installed or corrupted

**Solutions:**

1. **Reinstall packages:**

   ```bash
   rm -rf node_modules package-lock.json
   npm install
   ```

2. **Verify installation:**

   ```bash
   npm list stream-chat
   ```

3. **Check package.json:**

   ```json
   {
     "dependencies": {
       "stream-chat": "^8.57.6"
     }
   }
   ```

4. **Clear Next.js cache:**
   ```bash
   rm -rf .next
   npm run dev
   ```

### Error 4: "User Not Found"

**Full Error:**

```
Error: User not found
```

**Cause:** Database query failed or user doesn't exist

**Solutions:**

1. **Check DATABASE_URL is set:**

   ```bash
   echo $DATABASE_URL
   ```

2. **Verify user exists in database:**

   ```sql
   SELECT id, name FROM "User" WHERE id = 'user_id';
   ```

3. **Check Prisma connection:**
   ```bash
   npx prisma db pull
   ```

### Error 5: CORS Errors

**Full Error:**

```
Access to fetch at 'https://stream-io-api.com' from origin 'http://localhost:3000'
has been blocked by CORS policy
```

**Cause:** Server-side code running on client

**Solutions:**

1. **Ensure server actions have directive:**

   ```typescript
   "use server"; // Must be at top of file

   export async function tokenProvider(userId: string) {
     // Server-only code
   }
   ```

2. **Don't call server actions from client imports:**

   ```typescript
   // ❌ Wrong (importing server code in client)
   import { tokenProvider } from "@/actions/stream.action";

   // ✅ Correct (use as callback)
   tokenProvider: () => tokenProvider(userId);
   ```

### Error 6: "Token Expired"

**Full Error:**

```
StreamChat error: Token expired
```

**Cause:** System time mismatch or token generation bug

**Solutions:**

1. **Check system time:**

   ```bash
   date
   # Should match current time
   ```

2. **Synchronize time (Linux):**

   ```bash
   sudo ntpdate pool.ntp.org
   ```

3. **Verify token expiry:**
   ```typescript
   const exp = Math.round(Date.now() / 1000) + 60 * 60; // 1 hour from now
   console.log("Token expires at:", new Date(exp * 1000));
   ```

---

## Next.js Specific Configuration

### App Router Setup

Stream SDK works with Next.js 13+ App Router.

**File Structure:**

```
app/
├── layout.tsx          # Wrap with StreamProvider
├── (authenticated)/    # Protected routes
│   └── chat/
│       └── page.tsx    # Chat UI
└── api/
    └── stream/
        └── sync/
            └── route.ts # Background sync endpoint
```

### Server Actions

Stream token generation **must** use server actions:

```typescript
// actions/stream/chat/stream.action.ts
"use server"; // Required!

export async function tokenProvider(userId: string) {
  // Server-only code
  const secret = process.env.STREAM_API_SECRET; // Safe here
  return client.createToken(userId);
}
```

**Why Server Actions?**

- Keeps API secret secure
- No CORS issues
- Better performance
- Type-safe

### Client Components

Components using Stream hooks must be client components:

```typescript
"use client"; // Required for hooks

import { useStreamConnection } from "@/providers/StreamProvider";

export function ChatComponent() {
  const { chatConnected } = useStreamConnection();
  // ...
}
```

### Environment Variables in Next.js

| Prefix         | Access          | Example                      |
| -------------- | --------------- | ---------------------------- |
| `NEXT_PUBLIC_` | Client + Server | `NEXT_PUBLIC_STREAM_API_KEY` |
| _(none)_       | Server only     | `STREAM_API_SECRET`          |

**Loading Order:**

1. `.env.local` (local development, gitignored)
2. `.env.development` (development defaults)
3. `.env.production` (production defaults)
4. `.env` (all environments)

### Middleware Considerations

If using Next.js middleware for auth:

```typescript
// middleware.ts
export function middleware(request: NextRequest) {
  // Don't block Stream API calls
  if (request.nextUrl.pathname.startsWith("/api/stream")) {
    return NextResponse.next();
  }

  // Your auth logic
}
```

### Edge Runtime Compatibility

⚠️ Stream SDK is **not compatible** with Edge Runtime.

```typescript
// app/api/stream/token/route.ts
// ❌ Don't use edge runtime
// export const runtime = "edge";

// ✅ Use Node.js runtime (default)
export async function GET(request: Request) {
  const token = await tokenProvider(userId);
  return Response.json({ token });
}
```

---

## Development vs Production

### Development Setup

```env
# .env.local (never commit!)
NEXT_PUBLIC_STREAM_API_KEY=dev_key_123
STREAM_API_SECRET=dev_secret_456
DATABASE_URL=postgresql://localhost:5432/familiarise_dev
```

**Best Practices:**

- Use separate Stream app for development
- Shorter token expiry for testing (e.g., 10 minutes)
- Enable debug logging
- Test token refresh logic

### Production Setup

```env
# Set in deployment platform (Vercel, Railway, etc.)
NEXT_PUBLIC_STREAM_API_KEY=prod_key_789
STREAM_API_SECRET=prod_secret_012
DATABASE_URL=postgresql://prod-host:5432/familiarise
STREAM_SYNC_SECRET=random_secure_64_char_string
```

**Security Checklist:**

- [ ] Different API keys for dev/prod
- [ ] API secret never exposed to client
- [ ] HTTPS enforced
- [ ] Sync endpoint protected with secret
- [ ] Rate limiting enabled
- [ ] Error monitoring configured (Sentry)
- [ ] Token expiry appropriate (1 hour)
- [ ] Database connection pooling enabled

### Deployment Platforms

#### Vercel

```bash
# Set environment variables
vercel env add NEXT_PUBLIC_STREAM_API_KEY production
vercel env add STREAM_API_SECRET production
vercel env add DATABASE_URL production
```

#### Railway

```bash
# Set via dashboard or CLI
railway variables set NEXT_PUBLIC_STREAM_API_KEY=xxx
railway variables set STREAM_API_SECRET=xxx
```

---

## Next Steps

**Setup complete? Move to:**

1. **Understand the architecture:** [01. Architecture Overview](./01-architecture.md)
2. **Learn provider internals:** [03. Provider & Authentication](./03-provider-authentication.md)
3. **Implement chat:** [04. Chat Implementation](./04-chat-implementation.md)
4. **Add video calls:** [05. Video Implementation](./05-video-implementation.md)
5. **Recording & Webhooks:** [13. Recording & Webhooks](./13-recording-webhooks.md)

**Troubleshooting:** [Troubleshooting Guide](./troubleshooting.md)

---

← [01. Architecture](./01-architecture.md) | [Next: Provider & Authentication](./03-provider-authentication.md) →
