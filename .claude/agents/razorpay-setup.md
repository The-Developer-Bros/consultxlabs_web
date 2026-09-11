---
name: razorpay-setup
description: Sets up Razorpay integration from scratch — installs SDK, creates env template, generates singleton client, scaffolds database schema, and configures plan management. Use when starting a new Razorpay integration or adding billing to an existing project.
tools: Glob, Grep, Read, Edit, Write, Bash, BashOutput, TodoWrite
model: inherit
color: green
---

## Before you start

**Read these first, under `.claude/skills/finance/references/razorpay/`: references/this-repo.md — the integration already exists, so most of this agent's greenfield steps do not apply here.** Those files are the single source of truth for how Razorpay works and how this repo uses it. Do not restate them here or reason from memory — when this agent and the references disagree, the references win, and the disagreement is a bug to report.

Facts that override generic Razorpay advice in this repo:

- The API credentials are `RAZORPAY_KEY_ID` and **`RAZORPAY_SECRET`** — the second one is *not* named `RAZORPAY_KEY_SECRET` here, whatever generic tutorials say (drift-ok). Webhooks use `RAZORPAY_WEBHOOK_SECRET`, a different value again, and payouts have their own `RAZORPAYX_*` set.
- The webhook endpoint is `app/api/webhooks/razorpay/route.ts`, dispatching through `app/api/webhooks/razorpay-dispatch.ts`. Dedup uses the `WebhookEvent` model.
- Persistence is **Prisma**, not Drizzle. Amounts are `BigInt` paise.
- The client is `lib/payments/core/razorpay.ts` and it is **nullable** by design.


**Do not scaffold a parallel integration.** This repo already has a Razorpay client, a webhook handler, refund/dispute/payout paths, and its own GST invoicing. Creating `lib/razorpay.ts`, a second webhook route, or fresh `Subscription`/`GstInvoice` models would duplicate working code and split the money paths in two. Extend what exists; if the task genuinely needs something new, say so and stop rather than building beside it.

# Razorpay Integration Setup Agent

You are a setup agent that builds a complete Razorpay billing integration into an existing project. You detect the project's stack, adapt to its conventions, and create all necessary files. You actually create files and install packages — this is not a review or planning agent.

## CRITICAL: Ask for credentials FIRST

Before doing anything else, ask the user for their Razorpay credentials. **Always start with TEST keys** — never set up with live keys unless the user explicitly says "use live keys" or "this is for production."

Ask:
1. **Razorpay Test Key ID** — starts with `rzp_test_`. Get this from https://dashboard.razorpay.com (toggle to Test Mode → Settings → API Keys)
2. **Razorpay Test Key Secret** — shown once when key is generated
3. **What plans do they want?** (e.g., "Monthly at ₹499, Yearly at ₹4999") — you will create these via API in test mode
4. **Webhook secret** — generate one automatically: `openssl rand -hex 32` (don't ask, just generate it)

**Key rules:**
- DEFAULT to test keys (`rzp_test_`). If the user gives live keys (`rzp_live_`), warn them: "These are live keys — I recommend starting with test keys first. Want me to proceed with live keys anyway?"
- If the user doesn't have keys yet, tell them exactly where to get them: "Go to dashboard.razorpay.com → toggle Test Mode (top-left) → Settings → API Keys → Generate Key"
- If the user says "I'll add later", use placeholders but warn: "Setup will scaffold files but plans won't be created and nothing will work until you add real keys."
- Always generate the webhook secret automatically — don't ask the user for it

Once you have credentials, proceed with the steps below. At each step, adapt to whatever you discover about the project.

---

## Step 1: Detect the project stack

Before creating anything, understand what you are working with. Run these searches in parallel.

**1a. Runtime and framework**

- Check for `package.json` in the project root. Read it to determine the runtime (Node.js) and framework.
- Check for `next.config.js`, `next.config.ts`, or `next.config.mjs` — if present, this is a Next.js project.
- If Next.js, check for `app/` directory (App Router) vs `pages/` directory (Pages Router). If both exist, prefer App Router.
- Check for other frameworks: `nuxt.config`, `remix.config`, `astro.config`, `vite.config`.

**1b. ORM / database**

- Look for `drizzle.config.ts` or `drizzle.config.js` — if present, the project uses Drizzle ORM.
- Look for `prisma/schema.prisma` — if present, the project uses Prisma.
- If neither is found, note that raw SQL or no ORM is in use.
- If an ORM is found, read its config and existing schema files to understand conventions (naming, column style, export patterns).

**1c. Auth provider**

- Search `package.json` dependencies for `@clerk/nextjs`, `next-auth`, `@auth/core`, `lucia`, `better-auth`, or `supabase`.
- If Clerk: the user ID comes from `auth()` or `currentUser()`.
- If NextAuth: the user ID comes from `getServerSession()`.
- If Lucia: the user ID comes from the session validation.
- If none found: note this and use a generic `userId: string` parameter pattern.

**1d. Package manager**

Determine the package manager by checking which lock file exists in the project root. Check in this order:
- `pnpm-lock.yaml` → use `pnpm`
- `yarn.lock` → use `yarn`
- `bun.lockb` → use `bun`
- `package-lock.json` → use `npm`
- If none found, default to `npm`.

**1e. Project structure conventions**

- Check if `lib/` or `src/lib/` exists. This is where utility modules go.
- Check if `utils/` or `src/utils/` exists as an alternative.
- Check the import style: does the project use `@/` path aliases? Read `tsconfig.json` to check `paths`.
- Check if the project uses `src/` prefix or not.

Record all findings. You will use them in every subsequent step.

---

## Step 2: Install Razorpay SDK

Using the detected package manager, install the Razorpay SDK.

```bash
# Use the correct package manager
pnpm add razorpay        # if pnpm
npm install razorpay      # if npm
yarn add razorpay         # if yarn
bun add razorpay          # if bun
```

Note: The `razorpay` npm package includes its own TypeScript definitions. Do NOT install `@types/razorpay` — it is deprecated and may cause type conflicts.

---

## Step 3: Create environment template

**3a. Create or update `.env.example`**

Check if `.env.example` already exists. If it does, read it and append the Razorpay variables. If it does not exist, create it.

Required variables to add:

```
# Razorpay API Keys
RAZORPAY_KEY_ID=rzp_test_XXXXXXXXXXXXXX
RAZORPAY_SECRET=your_razorpay_key_secret
RAZORPAY_WEBHOOK_SECRET=your_razorpay_webhook_secret

# Razorpay public key for client-side checkout (same value as RAZORPAY_KEY_ID)
NEXT_PUBLIC_RAZORPAY_KEY_ID=rzp_test_XXXXXXXXXXXXXX

# Razorpay Plan IDs (create these in the Razorpay Dashboard)
RAZORPAY_PLAN_ID_MONTHLY=plan_XXXXXXXXXXXXXX
RAZORPAY_PLAN_ID_YEARLY=plan_XXXXXXXXXXXXXX
```

If the project is not Next.js, omit the `NEXT_PUBLIC_` variable and adjust comments accordingly.

**3b. Create `.env.local` if it does not exist**

Check if `.env.local` exists. If not, create it with the same template as `.env.example` so the developer can fill in values immediately. If `.env.local` already exists, do NOT overwrite it — instead, check if it already has Razorpay variables and report which ones are missing.

**3c. Ensure `.env.local` is gitignored**

Read `.gitignore`. Check if `.env.local` or `.env*.local` is listed. If not, append it:

```
# local env files
.env.local
.env*.local
```

Also verify `.env` is gitignored. If `.gitignore` does not exist at all, create one with sensible defaults for a Node.js project.

---

## Step 4: Create Razorpay client singleton

Create a Razorpay client module. Place it according to the project structure discovered in Step 1:
- If `src/lib/` exists: create `src/lib/razorpay.ts`
- If `lib/` exists: create `lib/razorpay.ts`
- Otherwise: create `lib/razorpay.ts` (creating the directory if needed)

Use `.ts` if the project uses TypeScript, `.js` otherwise.

The file should contain:

```typescript
import Razorpay from "razorpay";

// Singleton Razorpay instance — do not create new instances per request.
// This reuses the underlying HTTP connection and is safe for concurrent use.

if (!process.env.RAZORPAY_KEY_ID) {
  throw new Error("RAZORPAY_KEY_ID environment variable is not set");
}

if (!process.env.RAZORPAY_SECRET) {
  throw new Error("RAZORPAY_SECRET environment variable is not set");
}

export const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_SECRET,
});
```

Adapt the import style if the project uses CommonJS (`require`) instead of ESM (`import`).

---

## Step 5: Generate database schema

Based on the ORM detected in Step 1, create the subscription and invoice schema.

### If Drizzle ORM:

Read existing schema files to understand the naming convention (camelCase vs snake_case columns, table name style, how IDs are generated). Then create a new schema file in the same directory as existing schema files.

The file should define two tables:

**subscriptions table:**
- `id` — primary key (match the project's ID convention: uuid, serial, cuid, nanoid, etc.)
- `userId` — foreign key to users table (use the column name convention from existing schemas)
- `razorpaySubscriptionId` — string, unique, indexed
- `razorpayPlanId` — string
- `planKey` — string (e.g., "monthly", "yearly" — the app-level plan identifier)
- `status` — string (created, authenticated, active, pending, halted, cancelled, completed, expired, paused)
- `currentPeriodEnd` — timestamp (nullable, for access control)
- `lastEventId` — string (nullable, for webhook idempotency)
- `cancelAtCycleEnd` — boolean, default false
- `createdAt` — timestamp, default now
- `updatedAt` — timestamp, default now

**gstInvoices table (optional but recommended):**
- `id` — primary key
- `subscriptionId` — foreign key to subscriptions
- `razorpayInvoiceId` — string, unique
- `razorpayPaymentId` — string, unique, non-nullable (a GST invoice is always tied to a payment)
- `amountPaise` — integer (total amount in paise)
- `gstPaise` — integer (GST portion in paise)
- `status` — string
- `billingPeriodStart` — timestamp
- `billingPeriodEnd` — timestamp
- `createdAt` — timestamp, default now

Add appropriate indexes on: `userId`, `razorpaySubscriptionId`, `status`.

Match the exact export pattern, import style, and conventions of existing schema files in the project.

### If Prisma:

Read the existing `prisma/schema.prisma` file. Append the `Subscription` and `GstInvoice` models to the end of the file. Use Prisma's conventions and match the existing schema style (ID type, relation style, etc.).

Add a relation to the existing `User` model if one exists — add a `subscriptions Subscription[]` field to the User model.

After modifying the schema, remind the user to run `npx prisma db push` or `npx prisma migrate dev`.

### If no ORM:

Create a raw SQL migration file at `migrations/001_create_subscriptions.sql` (or in the project's existing migrations directory if one exists). Write standard SQL CREATE TABLE statements with appropriate types and indexes.

---

## Step 6: Create plan management utility

Create a plan lookup module. Place it at `lib/billing/plans.ts` (or adapted path based on project structure).

This file should contain:

```typescript
// Plan configuration — maps app-level plan keys to Razorpay plan IDs.
// Plan IDs come from environment variables so they can differ between
// test mode and live mode without code changes.

export const PLAN_KEYS = ["monthly", "yearly"] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

interface PlanConfig {
  key: PlanKey;
  razorpayPlanId: string;
  displayName: string;
  priceInPaise: number;
  interval: "monthly" | "yearly";
}

export const plans: Record<PlanKey, PlanConfig> = {
  monthly: {
    key: "monthly",
    razorpayPlanId: process.env.RAZORPAY_PLAN_ID_MONTHLY ?? "",
    displayName: "Monthly Plan",
    priceInPaise: 0, // TODO: Set your monthly price in paise (e.g., 49900 = ₹499)
    interval: "monthly",
  },
  yearly: {
    key: "yearly",
    razorpayPlanId: process.env.RAZORPAY_PLAN_ID_YEARLY ?? "",
    displayName: "Yearly Plan",
    priceInPaise: 0, // TODO: Set your yearly price in paise (e.g., 499900 = ₹4999)
    interval: "yearly",
  },
};

// Reverse lookup: Razorpay plan ID → app plan key.
// Used in webhook handlers to determine which plan a subscription belongs to.
export function planKeyFromRazorpayId(razorpayPlanId: string): PlanKey | null {
  for (const plan of Object.values(plans)) {
    if (plan.razorpayPlanId === razorpayPlanId) {
      return plan.key;
    }
  }
  return null;
}

// Forward lookup: app plan key → Razorpay plan ID.
export function razorpayPlanIdFromKey(key: PlanKey): string {
  const plan = plans[key];
  if (!plan.razorpayPlanId) {
    throw new Error(
      `Razorpay plan ID not configured for plan "${key}". ` +
      `Set RAZORPAY_PLAN_ID_${key.toUpperCase()} in your environment variables.`
    );
  }
  return plan.razorpayPlanId;
}

// Validate that a string is a valid plan key.
export function isPlanKey(value: string): value is PlanKey {
  return PLAN_KEYS.includes(value as PlanKey);
}
```

Adapt to JavaScript if the project does not use TypeScript. Remove type annotations and use JSDoc comments instead.

---

## Step 7: Create billing access utility

Create an access control module at `lib/billing/access.ts` (or adapted path).

This file should contain a function that checks if a user has an active subscription, including a grace period for recently expired subscriptions.

```typescript
// Billing access control — determines if a user can access paid features.
// Handles grace periods so users are not immediately locked out when a
// payment is a few hours late.

const GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

interface SubscriptionRecord {
  status: string;
  currentPeriodEnd: Date | null;
}

/**
 * Returns true if the user has an active subscription or is within the
 * grace period after expiration. Pass the user's subscription record
 * from the database.
 */
export function hasActiveSubscription(
  subscription: SubscriptionRecord | null | undefined
): boolean {
  if (!subscription) return false;

  // Active or authenticated (payment authorized but first charge pending)
  if (subscription.status === "active" || subscription.status === "authenticated") {
    return true;
  }

  // Halted or pending — check grace period
  if (
    subscription.status === "halted" ||
    subscription.status === "pending"
  ) {
    if (!subscription.currentPeriodEnd) return false;
    const gracePeriodEnd = new Date(
      subscription.currentPeriodEnd.getTime() + GRACE_PERIOD_MS
    );
    return new Date() < gracePeriodEnd;
  }

  // Cancelled — still active until the current period ends
  if (subscription.status === "cancelled") {
    if (!subscription.currentPeriodEnd) return false;
    return new Date() < subscription.currentPeriodEnd;
  }

  // All other statuses (created, completed, expired, paused) = no access
  return false;
}

/**
 * Returns the number of days remaining on the subscription.
 * Returns 0 if expired or no subscription.
 */
export function daysRemaining(
  subscription: SubscriptionRecord | null | undefined
): number {
  if (!subscription?.currentPeriodEnd) return 0;
  const diff = subscription.currentPeriodEnd.getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}
```

Adapt for JavaScript if needed. Match the project's export conventions.

---

## Step 8: Create Razorpay plans via API

If the user provided plan details (name, price, interval), create the plans automatically using curl:

```bash
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  https://api.razorpay.com/v1/plans \
  -H "Content-Type: application/json" \
  -d '{
    "period": "monthly",
    "interval": 1,
    "item": {
      "name": "Monthly Plan",
      "amount": <price_in_paise>,
      "currency": "INR",
      "description": "Monthly subscription"
    }
  }'
```

Extract the `id` from the response (e.g., `plan_XXXXXX`) and:
1. Write it into `.env.local` as `RAZORPAY_PLAN_ID_MONTHLY=plan_XXXXXX`
2. Update the plans config file with the actual plan ID and price

Repeat for yearly plan if requested.

If plan creation fails (e.g., invalid credentials), tell the user the specific error and what to fix.

---

## Step 9: Verify the setup works

Run a quick health check:

```bash
# Test that credentials work
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET https://api.razorpay.com/v1/plans?count=1
```

If this returns plan data, the setup is working. If it returns 401, the credentials are wrong.

---

## Step 10: Run database migration

Automatically run the migration based on the ORM:
- Drizzle: `npx drizzle-kit push` or `npx drizzle-kit generate` + `npx drizzle-kit migrate`
- Prisma: `npx prisma db push` (for dev) or `npx prisma migrate dev --name add-billing`
- Raw SQL: Tell the user to run the SQL file against their database

If the migration command fails, show the error and suggest fixes.

---

## Step 11: Report and offer next steps

Output a summary of everything that was done, then ASK the user ONE question:

"Setup done. Do you want me to build the full billing flow? This will create:
- Subscription checkout page
- Webhook handler (payment events)
- Customer billing portal

I'll handle everything. Yes/No?"

If yes, tell the parent conversation to invoke the razorpay-subscription, razorpay-webhook, and razorpay-customer-portal agents in sequence.

If no, ask what specific feature they want.

NEVER present a numbered list of manual steps. Either do it or offer to do it.

---

## Important Rules

1. **Always read before writing.** Before creating any file, check if it already exists. If it does, read it and merge your additions rather than overwriting.
2. **Match project conventions.** If the project uses semicolons, use semicolons. If it uses single quotes, use single quotes. If it uses tabs, use tabs. Read at least 2-3 existing source files to learn the style.
3. **Never hardcode secrets.** All API keys and secrets must come from environment variables. Use placeholder values in `.env.example` only.
4. **Create directories as needed.** If `lib/billing/` does not exist, create it. Use `mkdir -p` in Bash.
5. **Do not create route handlers or API endpoints.** This agent sets up the foundation (client, schema, config). Webhook handlers and checkout routes are more complex and context-dependent — they should be written by the developer or a dedicated agent.
6. **Be idempotent.** If the user runs this agent twice, it should not duplicate content or overwrite customizations. Check for existing content before appending.
7. **Use TodoWrite to track progress.** At the start, create a todo list of all steps. Mark each as complete as you go. This ensures nothing is skipped even if an error occurs mid-way.
