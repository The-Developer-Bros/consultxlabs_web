# Prisma 7 Migration Guide

A comprehensive guide documenting all issues encountered during the Prisma 6 to Prisma 7 migration and their solutions.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture Changes](#architecture-changes)
3. [Migration Timeline](#migration-timeline)
4. [Issues Encountered](#issues-encountered)
   - [Issue 1: CI/CD Environment Variable Error](#issue-1-cicd-environment-variable-error)
   - [Issue 2: Module Not Found (fs, dns, net, tls)](#issue-2-module-not-found-fs-dns-net-tls)
   - [Issue 3: node:process Scheme Not Handled](#issue-3-nodeprocess-scheme-not-handled)
   - [Issue 4: PrismaClient Requires Adapter](#issue-4-prismaclient-requires-adapter)
   - [Issue 5: engineType = "library" Doesn't Work](#issue-5-enginetype--library-doesnt-work)
   - [Issue 6: engine: "classic" Property Doesn't Exist](#issue-6-engine-classic-property-doesnt-exist)
   - [Issue 7: Multiple PrismaClient Instances](#issue-7-multiple-prismaclient-instances)
   - [Issue 8: Client/Server Code Mixing](#issue-8-clientserver-code-mixing)
5. [Final Working Configuration](#final-working-configuration)
6. [Migration Checklist](#migration-checklist)
7. [Troubleshooting Guide](#troubleshooting-guide)
8. [Resources](#resources)

---

## Overview

### What Changed in Prisma 7

Prisma 7 introduces a fundamental architectural shift from Rust-based query engines to a TypeScript-based query compiler. This is a **breaking change** that affects how PrismaClient is instantiated.

| Feature         | Prisma 6                        | Prisma 7                             |
| --------------- | ------------------------------- | ------------------------------------ |
| Default Engine  | Rust binary (`library`)         | TypeScript compiler (`client`)       |
| Driver Adapters | Optional                        | **Required** (for default engine)    |
| Config Location | `schema.prisma` only            | `schema.prisma` + `prisma.config.ts` |
| Database URL    | In `schema.prisma` datasource   | In `prisma.config.ts`                |
| Bundle Size     | Larger (includes Rust binaries) | Smaller (no Rust binaries)           |

### Why This Migration is Complex

```mermaid
flowchart TD
    A[Prisma 6 Project] --> B{Upgrade to Prisma 7}
    B --> C[Default Engine Changed]
    C --> D[client engine requires adapter]
    D --> E{Choose Path}
    E --> F[Use Driver Adapter]
    E --> G[Use Legacy Engine]
    G --> H[engineType = library]
    H --> I[❌ Still requires adapter in v7]
    G --> J[engine: classic]
    J --> K[❌ Property removed in v7]
    F --> L[✅ Only working solution]
    L --> M[But introduces new issues...]
    M --> N[Node.js modules in client bundle]
    M --> O[Multiple PrismaClient instances]
    M --> P[Client/Server code mixing]
```

---

## Architecture Changes

### Prisma 6 Architecture

```mermaid
flowchart LR
    subgraph "Application"
        A[Your Code] --> B[PrismaClient]
    end
    subgraph "Prisma Engine"
        B --> C[Rust Query Engine]
        C --> D[Database Driver]
    end
    D --> E[(PostgreSQL)]
```

### Prisma 7 Architecture (Default)

```mermaid
flowchart LR
    subgraph "Application"
        A[Your Code] --> B[PrismaClient]
    end
    subgraph "Driver Adapter"
        B --> C[TypeScript Query Compiler]
        C --> D[@prisma/adapter-pg]
        D --> E[pg node-postgres]
    end
    E --> F[(PostgreSQL)]
```

### Key Difference

In Prisma 7, the **driver adapter** (e.g., `@prisma/adapter-pg`) directly interfaces with the database driver (`pg`), removing the Rust binary layer. This has implications:

1. **Smaller bundle size** - No Rust binaries to ship
2. **Faster cold starts** - No binary initialization
3. **New dependencies** - `pg` and `@prisma/adapter-pg` are now required
4. **Node.js modules** - `pg` uses Node.js built-ins (`fs`, `dns`, `net`, `tls`)

---

## Migration Timeline

```mermaid
gantt
    title Prisma 7 Migration Timeline
    dateFormat  YYYY-MM-DD
    section Discovery
    Initial upgrade attempt           :a1, 2026-01-15, 1d
    CI/CD failure (DIRECT_URL)        :a2, after a1, 1d
    section Build Errors
    Module not found errors           :b1, after a2, 1d
    node:process scheme error         :b2, after b1, 1d
    Adapter requirement error         :b3, after b2, 1d
    section Investigation
    Tried engineType = library        :c1, after b3, 1d
    Tried engine: classic             :c2, after c1, 1d
    Research & documentation          :c3, after c2, 1d
    section Resolution
    Implemented driver adapter        :d1, after c3, 1d
    Split client/server code          :d2, after d1, 1d
    Fixed all PrismaClient instances  :d3, after d2, 1d
    Build successful                  :milestone, after d3, 0d
```

---

## Issues Encountered

### Issue 1: CI/CD Environment Variable Error

#### Error Message

```
PrismaConfigEnvError: Cannot resolve environment variable: DIRECT_URL.
```

#### When It Occurs

- During `npm ci` or `npm install` when `postinstall` runs `prisma generate`
- In CI/CD pipelines (GitHub Actions, Vercel, etc.)
- Any environment without database credentials

#### Impact

- **Severity:** High
- **Affected:** All CI/CD pipelines, fresh installs
- **Symptom:** Build fails immediately during dependency installation

#### Root Cause

Prisma 7's `prisma.config.ts` requires the `DIRECT_URL` environment variable to be present at build time, even when not actually connecting to the database.

```typescript
// This fails if DIRECT_URL is not set
datasource: {
  url: env("DIRECT_URL"),  // ❌ Throws error
}
```

#### Solution

```typescript
// prisma.config.ts
import "dotenv/config";
import { defineConfig } from "prisma/config";

// Use fallback for CI environments where no DB connection is needed
const databaseUrl =
  process.env.DIRECT_URL ||
  "postgresql://placeholder:placeholder@localhost:5432/placeholder";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: databaseUrl, // ✅ Works with fallback
  },
});
```

#### Verification

```bash
# Test without DIRECT_URL
unset DIRECT_URL
npx prisma generate  # Should succeed with fallback
```

---

### Issue 2: Module Not Found (fs, dns, net, tls)

#### Error Message

```
Module not found: Can't resolve 'fs'
Module not found: Can't resolve 'dns'
Module not found: Can't resolve 'net'
Module not found: Can't resolve 'tls'

Import trace for requested module:
./node_modules/pg-connection-string/index.js
./node_modules/pg/lib/connection-parameters.js
./node_modules/pg/lib/client.js
./node_modules/pg/lib/index.js
./node_modules/@prisma/adapter-pg/dist/index.mjs
./lib/prisma.ts
./utils/onboarding.ts
./app/form/onboarding/page.tsx
```

#### When It Occurs

- During `npm run build`
- When client-side code imports a file that transitively imports Prisma

#### Impact

- **Severity:** Critical
- **Affected:** Production builds, any client component importing Prisma-dependent code
- **Symptom:** Build fails during webpack compilation

#### Root Cause Diagram

```mermaid
flowchart TD
    subgraph "Client Component"
        A["app/form/onboarding/page.tsx<br/>'use client'"]
    end

    subgraph "Shared Utility"
        B["utils/onboarding.ts<br/>(schemas + DB operations)"]
    end

    subgraph "Server Code"
        C["lib/prisma.ts"]
        D["@prisma/adapter-pg"]
        E["pg (node-postgres)"]
    end

    subgraph "Node.js Built-ins"
        F["fs, dns, net, tls"]
    end

    A -->|imports| B
    B -->|dynamic import| C
    C -->|imports| D
    D -->|imports| E
    E -->|requires| F

    F -->|"❌ Not available<br/>in browser"| G[Build Error]

    style A fill:#ff9999
    style F fill:#ff9999
    style G fill:#ff0000,color:#fff
```

#### Why This Happens

1. Client component (`"use client"`) imports `utils/onboarding.ts`
2. `utils/onboarding.ts` has dynamic imports to `lib/prisma.ts`
3. Webpack analyzes ALL code paths, including dynamic imports
4. `lib/prisma.ts` → `@prisma/adapter-pg` → `pg` → Node.js built-ins
5. Webpack tries to bundle Node.js built-ins for browser
6. Build fails because `fs`, `dns`, `net`, `tls` don't exist in browser

#### Attempted Solutions (That Didn't Work)

**Attempt 1: Webpack Fallbacks**

```javascript
// next.config.mjs
webpack: (config, { isServer }) => {
  if (!isServer) {
    config.resolve.fallback = {
      fs: false,
      dns: false,
      net: false,
      tls: false,
    };
  }
  return config;
},
```

**Result:** Partial fix, but caused other errors

**Attempt 2: Server External Packages**

```javascript
serverExternalPackages: ["pg", "@prisma/adapter-pg", "pg-connection-string"],
```

**Result:** Didn't prevent client-side bundling

#### Working Solution

Split client-safe code from server-only code (see [Issue 8](#issue-8-clientserver-code-mixing))

---

### Issue 3: node:process Scheme Not Handled

#### Error Message

```
UnhandledSchemeError: Reading from "node:process" is not handled by plugins (Unhandled scheme).
Webpack supports "data:" and "file:" URIs by default.
```

#### When It Occurs

- After applying webpack fallbacks for Issue 2
- When `pg` package uses Node.js protocol imports

#### Impact

- **Severity:** High
- **Affected:** Production builds
- **Symptom:** Build fails with webpack scheme error

#### Root Cause

The `pg` package uses Node.js `node:` prefixed imports:

```javascript
// Inside pg package
import process from "node:process";
import fs from "node:fs";
```

Webpack doesn't handle `node:` URIs for client-side bundles.

#### Solution

This is a symptom of the same underlying issue as Issue 2. The real solution is to prevent `pg` from being included in the client bundle at all (see [Issue 8](#issue-8-clientserver-code-mixing)).

---

### Issue 4: PrismaClient Requires Adapter

#### Error Message

```
PrismaClientConstructorValidationError: Using engine type "client" requires either "adapter" or "accelerateUrl" to be provided to PrismaClient constructor.
Read more at https://pris.ly/d/client-constructor
```

#### When It Occurs

- At runtime when PrismaClient is instantiated
- During `npm run build` at page data collection phase

#### Impact

- **Severity:** Critical
- **Affected:** All Prisma operations
- **Symptom:** Application crashes immediately

#### Root Cause

Prisma 7's default engine type is `client`, which requires:

1. A driver adapter (e.g., `@prisma/adapter-pg`), OR
2. A Prisma Accelerate URL

```mermaid
flowchart TD
    A[new PrismaClient] --> B{Check engine type}
    B -->|"engineType = 'client'<br/>(default in v7)"| C{Has adapter or accelerateUrl?}
    C -->|No| D["❌ PrismaClientConstructorValidationError"]
    C -->|Yes| E["✅ Initialize client"]
    B -->|"engineType = 'library'<br/>or 'binary'"| F{Rust engine available?}
    F -->|Yes| E
    F -->|"No (Prisma 7 doesn't ship it by default)"| D
```

#### Solution

```typescript
// lib/prisma.ts
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

const prisma = new PrismaClient({
  adapter, // ✅ Provide the adapter
  log:
    process.env.NODE_ENV === "development"
      ? ["query", "error", "warn"]
      : ["error"],
});

export default prisma;
```

---

### Issue 5: engineType = "library" Doesn't Work

#### What We Tried

```prisma
// schema.prisma
generator client {
  provider   = "prisma-client-js"
  engineType = "library"  // Attempt to use Rust engine
}
```

#### Expected Behavior

Using the Rust-based query engine (like Prisma 6), which doesn't require a driver adapter.

#### Actual Behavior

Still received the error:

```
PrismaClientConstructorValidationError: Using engine type "client" requires either "adapter" or "accelerateUrl"
```

#### Why It Didn't Work

```mermaid
flowchart TD
    A["schema.prisma<br/>engineType = 'library'"] --> B["prisma generate"]
    B --> C["Generated client code"]
    C --> D{"Check generated index.js"}
    D --> E["Still imports from<br/>@prisma/client/runtime/client.js"]
    E --> F["client.js validates:<br/>adapter OR accelerateUrl required"]
    F --> G["❌ Error thrown"]

    style G fill:#ff0000,color:#fff
```

In Prisma 7, the generated client code uses the same runtime regardless of `engineType` setting. The validation for adapter requirement happens in the runtime, not based on schema settings.

#### Investigation Evidence

```bash
# Generated client still uses client runtime
grep "runtime/client" node_modules/.prisma/client/index.js
# Output: } = require('@prisma/client/runtime/client.js')
```

---

### Issue 6: engine: "classic" Property Doesn't Exist

#### What We Tried

```typescript
// prisma.config.ts
export default defineConfig({
  engine: "classic", // Attempt to use classic Rust engine
  // ...
});
```

#### Error Message

```
Type error: Object literal may only specify known properties, and 'engine' does not exist in type 'PrismaConfig'.
```

#### Why It Doesn't Exist

According to the official Prisma documentation:

> The `engine` property was **removed in Prisma ORM v7**.

This property previously accepted `"classic"` or `"js"` values but is no longer available.

```mermaid
flowchart LR
    subgraph "Prisma 6"
        A["prisma.config.ts<br/>engine: 'classic'"]
        B["prisma.config.ts<br/>engine: 'js'"]
    end

    subgraph "Prisma 7"
        C["❌ Property removed"]
    end

    A --> C
    B --> C
```

---

### Issue 7: Multiple PrismaClient Instances

#### Error Message

```
PrismaClientInitializationError: `PrismaClient` needs to be constructed with a non-empty, valid `PrismaClientOptions`
```

#### When It Occurs

- During build when importing script files
- At runtime when scripts are executed

#### Impact

- **Severity:** High
- **Affected:** Scripts, background jobs, any file creating its own PrismaClient
- **Symptom:** Build fails or runtime errors

#### Root Cause

Many script files were creating their own PrismaClient instances:

```typescript
// scripts/payments/cleanup-abandoned-payments.ts (BEFORE)
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient(); // ❌ No adapter!
```

These instances don't have the adapter configured, causing the error.

#### Files That Needed Updating

| File                                                   | Purpose                       |
| ------------------------------------------------------ | ----------------------------- |
| `scripts/payments/cleanup-abandoned-payments.ts`       | Cleanup abandoned payments    |
| `scripts/appointments/cleanup-invalid-appointments.ts` | Cleanup invalid appointments  |
| `scripts/earnings/release-earnings.ts`                 | Release consultant earnings   |
| `scripts/payouts/create-payout-batch.ts`               | Create payout batches         |
| `jobs/payouts/process-payouts.ts` (was `scripts/payouts/…`, #850) | Process approved payouts |
| `utils/appointmentUtils.ts`                            | Appointment utility functions |

#### Solution

Change all files to use the shared Prisma instance:

```typescript
// BEFORE (❌ Wrong)
import { PrismaClient, PaymentStatus } from "@prisma/client";
const prisma = new PrismaClient();

// AFTER (✅ Correct)
import { PaymentStatus } from "@prisma/client";
import prisma from "@/lib/prisma";
```

---

### Issue 8: Client/Server Code Mixing

#### The Problem

```mermaid
flowchart TD
    subgraph "Client Side (Browser)"
        A["app/form/onboarding/page.tsx<br/>'use client'"]
    end

    subgraph "Mixed File (Problem!)"
        B["utils/onboarding.ts"]
        B1["Zod schemas ✅"]
        B2["Type definitions ✅"]
        B3["Validation functions ✅"]
        B4["processOnboardingData() ❌<br/>(uses Prisma)"]
    end

    subgraph "Server Side"
        C["lib/prisma.ts"]
        D["@prisma/adapter-pg"]
        E["pg (node-postgres)"]
    end

    A -->|imports| B
    B --> B1
    B --> B2
    B --> B3
    B --> B4
    B4 -->|"dynamic import"| C
    C --> D
    D --> E

    E -->|"❌ Node.js modules<br/>bundled for client"| F[Build Error]

    style B fill:#ffcc00
    style B4 fill:#ff9999
    style F fill:#ff0000,color:#fff
```

#### Impact

- **Severity:** Critical
- **Affected:** Any client component importing utility files with database operations
- **Symptom:** Build fails with module not found errors

#### Why Dynamic Imports Don't Help

```typescript
// utils/onboarding.ts
export async function processOnboardingData(userId: string, body: any) {
  // Even though this is a dynamic import...
  const { default: prisma } = await import("@/lib/prisma");

  // Webpack STILL analyzes this path during build
  // and tries to include lib/prisma.ts in the client bundle
}
```

Webpack performs static analysis of all import paths, including dynamic imports, to determine what modules might be needed.

#### Solution: Split Client and Server Code

```mermaid
flowchart TD
    subgraph "Client Side (Browser)"
        A["app/form/onboarding/page.tsx<br/>'use client'"]
    end

    subgraph "Client-Safe File"
        B["utils/onboarding.ts"]
        B1["Zod schemas ✅"]
        B2["Type definitions ✅"]
        B3["Validation functions ✅"]
    end

    subgraph "Server-Only File"
        C["utils/onboarding-server.ts<br/>import 'server-only'"]
        C1["processOnboardingData()"]
    end

    subgraph "Server Side"
        D["lib/prisma.ts"]
        E["@prisma/adapter-pg"]
    end

    subgraph "Server Actions/API Routes"
        F["actions/forms/onboarding.action.ts"]
        G["app/api/form/onboarding/route.ts"]
    end

    A -->|imports schemas/types| B
    F -->|imports| C
    G -->|imports| C
    C -->|imports| D
    D --> E

    style B fill:#90EE90
    style C fill:#90EE90
    style D fill:#90EE90
```

#### Implementation

**Step 1: Create server-only file**

```typescript
// utils/onboarding-server.ts
import "server-only"; // Enforces server-only usage at build time
import prisma from "@/lib/prisma";
import type { OnboardingData } from "./onboarding";

export async function processOnboardingData(
  userId: string,
  body: any,
): Promise<{ success: boolean; user?: any; error?: string }> {
  // All database operations here
  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: {
      /* ... */
    },
  });
  return { success: true, user: updatedUser };
}
```

**Step 2: Keep client-safe code in original file**

```typescript
// utils/onboarding.ts
import { z } from "zod";
import { UserRole, Gender } from "@prisma/client"; // Only types/enums

// Schemas, types, and validation - NO database operations
export const OnboardingFormDataSchema = z.object({
  name: z.string().min(1),
  // ...
});

export type OnboardingData = z.infer<typeof OnboardingFormDataSchema>;

// Note: Database operations moved to utils/onboarding-server.ts
```

**Step 3: Update imports in server-side code**

```typescript
// actions/forms/onboarding.action.ts
"use server";

// Import from server-only file
import { processOnboardingData } from "@/utils/onboarding-server";

export async function updateOnboardingInformationAction(
  userId: string,
  body: any,
) {
  return processOnboardingData(userId, body);
}
```

**Step 4: Install server-only package**

```bash
npm install server-only
```

---

## Final Working Configuration

### File Structure

```
project/
├── prisma/
│   └── schema.prisma           # Generator and datasource config
├── prisma.config.ts            # Prisma 7 config file
├── lib/
│   └── prisma.ts               # Shared PrismaClient with adapter
├── utils/
│   ├── onboarding.ts           # Client-safe schemas and types
│   └── onboarding-server.ts    # Server-only database operations
├── actions/
│   └── forms/
│       └── onboarding.action.ts # Server actions
├── scripts/
│   └── *.ts                    # All use shared prisma instance
└── next.config.mjs             # Server external packages config
```

### Configuration Files

#### prisma.config.ts

```typescript
import "dotenv/config";
import { defineConfig } from "prisma/config";

const databaseUrl =
  process.env.DIRECT_URL ||
  "postgresql://placeholder:placeholder@localhost:5432/placeholder";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: databaseUrl,
  },
});
```

#### schema.prisma

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  // Database URLs configured in prisma.config.ts (Prisma 7)
}

// ... models
```

#### lib/prisma.ts

```typescript
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

export default prisma;

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
```

#### next.config.mjs

```javascript
const nextConfig = {
  // ... other config

  // Prevent pg modules from being bundled into client-side code
  serverExternalPackages: [
    "pg",
    "@prisma/adapter-pg",
    "pg-pool",
    "pg-connection-string",
  ],
};

export default nextConfig;
```

### Required Dependencies

```json
{
  "dependencies": {
    "@prisma/client": "^7.2.0",
    "@prisma/adapter-pg": "^7.2.0",
    "pg": "^8.16.3",
    "server-only": "^0.0.1"
  },
  "devDependencies": {
    "prisma": "^7.2.0"
  }
}
```

---

## Migration Checklist

Use this checklist when migrating from Prisma 6 to Prisma 7:

### Pre-Migration

- [ ] Back up your database
- [ ] Ensure all tests pass on Prisma 6
- [ ] Document current Prisma configuration

### Dependencies

- [ ] Update `prisma` to `^7.2.0`
- [ ] Update `@prisma/client` to `^7.2.0`
- [ ] Install `@prisma/adapter-pg` (or appropriate adapter)
- [ ] Install `pg` (or appropriate driver)
- [ ] Install `server-only`

### Configuration

- [ ] Create `prisma.config.ts` at project root
- [ ] Add database URL fallback for CI
- [ ] Remove `url` from `datasource` block in schema.prisma
- [ ] Update `next.config.mjs` with `serverExternalPackages`

### Code Changes

- [ ] Update `lib/prisma.ts` to use driver adapter
- [ ] Find all `new PrismaClient()` instances
- [ ] Update all script files to use shared Prisma instance
- [ ] Identify mixed client/server utility files
- [ ] Split database operations into `*-server.ts` files
- [ ] Update imports in server actions and API routes

### Testing

- [ ] Run `npx prisma generate`
- [ ] Run `npm run build`
- [ ] Test all database operations locally
- [ ] Test in staging environment
- [ ] Verify CI/CD pipeline passes

### Post-Migration

- [ ] Update documentation
- [ ] Inform team of new patterns
- [ ] Monitor for runtime errors

---

## Troubleshooting Guide

### Error: "Cannot resolve environment variable: DIRECT_URL"

**Cause:** `prisma.config.ts` uses `env("DIRECT_URL")` without fallback

**Solution:** Add fallback in `prisma.config.ts`:

```typescript
const databaseUrl = process.env.DIRECT_URL || "postgresql://placeholder:...";
```

### Error: "Module not found: Can't resolve 'fs'"

**Cause:** Client component imports file that transitively imports Prisma

**Solution:**

1. Check import trace in error message
2. Identify which client component is importing server code
3. Split the utility file into client-safe and server-only versions
4. Use `import "server-only"` in server files

### Error: "Using engine type 'client' requires adapter"

**Cause:** PrismaClient instantiated without adapter

**Solution:**

1. Ensure `lib/prisma.ts` has adapter configured
2. Find all `new PrismaClient()` calls and replace with shared instance
3. Search: `grep -r "new PrismaClient" --include="*.ts"`

### Error: "'engine' does not exist in type 'PrismaConfig'"

**Cause:** Using removed configuration property

**Solution:** Remove `engine: "classic"` from `prisma.config.ts`. Use driver adapter instead.

### Build passes but runtime error

**Cause:** Scripts or server code creating PrismaClient without adapter

**Solution:**

1. Search all files: `grep -rn "new PrismaClient" --include="*.ts"`
2. Replace all instances with `import prisma from "@/lib/prisma"`

### Dynamic imports still cause bundling issues

**Cause:** Webpack analyzes dynamic imports statically

**Solution:** Move database operations to separate file with `import "server-only"`

---

## Resources

### Official Documentation

- [Upgrade to Prisma 7](https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-versions/upgrading-to-prisma-7)
- [Prisma Config Reference](https://www.prisma.io/docs/orm/reference/prisma-config-reference)
- [Database Drivers](https://www.prisma.io/docs/orm/overview/databases/database-drivers)
- [Use Prisma ORM without Rust engines](https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/no-rust-engine)

### GitHub Issues

- [Breaking changes to Prisma config #28573](https://github.com/prisma/prisma/issues/28573)
- [MySQL adapter breaking changes #28665](https://github.com/prisma/prisma/issues/28665)
- [ESM environment issues #28670](https://github.com/prisma/prisma/issues/28670)

### Next.js Documentation

- [Server External Packages](https://nextjs.org/docs/app/api-reference/next-config-js/serverExternalPackages)
- [Module Not Found](https://nextjs.org/docs/messages/module-not-found)

---

## Summary

### Key Learnings

1. **Driver adapters are mandatory in Prisma 7** - There's no way to use the old Rust engine
2. **`engineType` settings don't help** - The generated client always validates for adapter
3. **`engine: "classic"` was removed** - This property no longer exists
4. **Code splitting is essential** - Server-only code must be isolated from client imports
5. **One Prisma instance** - Never create multiple `new PrismaClient()` instances
6. **`server-only` package** - Provides build-time enforcement for server code

### Migration Effort

| Aspect        | Effort Level | Notes                               |
| ------------- | ------------ | ----------------------------------- |
| Dependencies  | Low          | Just update/add packages            |
| Configuration | Medium       | New config file + changes           |
| Code Changes  | High         | May require significant refactoring |
| Testing       | Medium       | Test all database operations        |

---

_Document Version: 1.0_
_Last Updated: January 2026_
_Migration Completed: Successfully_
