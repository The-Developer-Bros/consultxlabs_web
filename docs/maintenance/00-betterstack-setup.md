# BetterStack Setup Guide

> **Start here.** This is the first thing a new developer should set up. Without BetterStack configured, the maintenance system cannot auto-create or resolve incidents, and `/api/health` will return `betterstack.configured: false`.

This guide walks through setting up BetterStack from scratch for the Familiarise platform — creating an account, configuring monitors, building the status page, generating an API token, and adding it to the environment. Every step is described at the level of detail needed for someone who has never touched BetterStack before.

---

## What BetterStack Does for Familiarise

BetterStack provides two things:

1. **Uptime monitoring**: Checks `familiarisenow.com` and `familiarisenow.com/api/health` every 3 minutes from multiple global regions. Sends email alerts if either goes down.
2. **Incident management**: When the platform enters OFFLINE maintenance mode, `lib/betterstack.ts` automatically creates a BetterStack incident. When maintenance ends, it auto-resolves the incident. This keeps the public status page in sync with actual platform state.

**Free plan limitations** (important to know):

- Minimum check frequency: 3 minutes (paid plans go down to 30 seconds)
- Alert methods: email only (push/SMS/call require paid plan at $29/month)
- Escalation policies: paid only
- Status pages: 1 free, additional are billable

---

## Account Setup

### Step 1: Create an account

1. Go to [https://uptime.betterstack.com/users/sign-up](https://uptime.betterstack.com/users/sign-up)
2. Enter your email address — BetterStack uses **magic links**, not passwords
3. Click **"Send magic link"**
4. Open your email inbox and click the magic link — it signs you in directly
5. Complete any onboarding prompts (team name, etc.)

> **Existing account**: The Familiarise account is under `teetangh@gmail.com`. To regain access, go to the sign-in page and request a new magic link to that email.

---

## Phase 1: Create Monitors

Monitors check your URLs on a schedule and alert you when they go down.

### Step 2: Create the Website monitor

1. In the left sidebar, click **"Monitors"**
2. Click **"Create monitor"** (top right)
3. Fill in the form:
   - **URL to monitor**: `https://familiarisenow.com`
   - **Monitor type**: HTTP (default)
   - **Check frequency**: `3 minutes` (lowest on free plan)
   - **Confirmation period**: `30 seconds` (waits 30s before alerting, reduces false positives)
   - **Alert via**: Email — select the team email
   - **Regions**: Leave at default (all available regions)
4. Scroll down and click **"Create monitor"**
5. You'll see "Monitor was successfully created" and the monitor will show status **"Pending"** while the first check runs

### Step 3: Create the API Health monitor

1. Click **"Create monitor"** again
2. Fill in the form:
   - **URL to monitor**: `https://familiarisenow.com/api/health`
   - **Monitor type**: HTTP
   - **Check frequency**: `3 minutes`
   - **Request timeout**: `60 seconds` (Advanced settings — NOT the 30s default)
   - **Confirmation period**: `1 minute` (Advanced settings — NOT the 30s default)
   - **Alert via**: Email
3. Click **"Create monitor"**

> **Why 60s / 1 minute on this monitor (#1557).** This route runs in the
> Next.js server handler, and a brand-new instance of that handler blocks its
> event loop for 24–39 s before doing any work (#1124, platform-side, open).
> At the 30 s default, ~8 checks a day landed on such an instance, timed out,
> and the confirmation re-checks from two more regions — arriving concurrently
> a few seconds later — each spawned another stalled instance and confirmed a
> "down" that never was: 100 false incidents in the 30 days to 2026-09-11,
> every one on the public status page. A 60 s timeout lets the stall pass; a
> real outage still pages within ~2 minutes. The stall itself stays visible in
> the response-time graph and in the payload's `platform.eventLoopStallMs`.

After a few minutes, both monitors should show **"Up"** status. The monitors page will show:

```
familiarisenow.com/api/health    Up · 3m
familiarisenow.com               Up · 3m  · Used on 1 status page
```

---

## Phase 2: Create Status Page

The status page at `familiarise.betteruptime.com` is a public page showing system health. It auto-reflects incidents created by the maintenance system.

### Step 4: Navigate to Status Pages

1. In the left sidebar, click **"Status pages"**
2. Click **"Create status page"**

### Step 5: Fill in the status page form

On the **Settings** tab:

- **Company name**: `Familiarise`
- **Subdomain**: `familiarise` → this creates `familiarise.betteruptime.com`
- **What URL should your logo point to?**: `https://familiarisenow.com`
- **Get in touch URL**: `mailto:support@familiarisenow.com`
- **Status page design**: `Modern look` (default)
- **Color theme**: `Light version` (default)

Leave everything else at default. Click **"Save changes"**.

You'll see "Status page was successfully created" and land on the **Structure** tab.

### Step 6: Add monitors to the status page

> **Note**: The BetterStack UI has a known issue where the monitor search dropdown sometimes shows an empty list. The workaround below adds monitors directly via JavaScript form injection.

The status page structure uses a standard HTML form. To add both monitors:

**Add Website monitor (already added by default):**
BetterStack auto-adds the first monitor when creating the status page. You'll see it listed as `familiarisenow.com`.

**Rename it to "Website":**

1. In the structure tab, find the resource card for `familiarisenow.com`
2. Look for a "Public name" field — change it from `familiarisenow.com` to `Website`

**Add API Health monitor (requires form injection if UI dropdown is broken):**

Open your browser developer tools console (F12 → Console) while on the Structure page, and run:

```javascript
const form = document.querySelector('form[id^="edit_status_page"]');
const sectionKey = "1";
const newKey = "new_4093822"; // Use the monitor ID from the monitors page URL
const fields = [
  ["resource_id", "4093822"], // Monitor ID from monitors page URL
  ["resource_type", "Endpoint"],
  ["resource_index", "1"],
  ["_destroy", "0"],
  ["public_name", "API Health"],
  ["explanation", ""],
  ["widget_type", "history"],
  ["mark_as_down_for", "any_incident"],
  ["mark_as_degraded_for", "no_incident"],
];
fields.forEach(([key, value]) => {
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = `status_page[status_page_sections_attributes][${sectionKey}][status_page_resources_attributes][${newKey}][${key}]`;
  input.value = value;
  form.appendChild(input);
});
form.submit();
```

> **How to find the monitor ID**: Go to the Monitors page and click on `familiarisenow.com/api/health`. The URL will be `https://uptime.betterstack.com/team/t332379/monitors/4093822` — the number at the end is the monitor ID.

After submission, the page refreshes and you'll see:

- `Website` — With status history
- `API Health` — With status history

**Current status page**: [https://familiarise.betteruptime.com](https://familiarise.betteruptime.com)

---

## Phase 3: Generate API Token

The API token allows `lib/betterstack.ts` to create and resolve incidents programmatically.

### Step 7: Create the API token

1. Click your avatar/profile icon (top right) → **"Settings"**, or navigate directly to [https://betterstack.com/settings/account](https://betterstack.com/settings/account)
2. In the left sidebar under **Organization**, click **"API tokens"**
3. Under **Global API tokens**, enter a token name: `Familiarise Production`
4. Click **"Create"**
5. The token appears immediately — **copy it now**. It will not be shown again after you navigate away.

> The token is a 24-character string, e.g. `TP1gbvr2sCtjaWWPovb8s2fM`.

---

## Phase 4: Add to Environment

### Step 8: Add to local .env

Add the following line to `.env` in the project root:

```env
# BetterStack uptime monitoring & incident management
BETTERSTACK_API_KEY="<your-token-here>"
```

### Step 9: Add to Netlify (production)

1. Go to your Netlify team dashboard → select the Familiarise site
2. Navigate to **Site configuration → Environment variables**
3. Click **"Add a variable"**
4. Key: `BETTERSTACK_API_KEY`
5. Value: `<your-token>`
6. Scope: All scopes (or at minimum: Production)
7. Click **"Save"**
8. Trigger a redeploy for the variable to take effect

---

## Phase 5: Verify It Works

### Step 10: Test via /api/health

The `/api/health` endpoint calls the BetterStack API and returns monitor statuses:

```bash
curl https://familiarisenow.com/api/health
```

Expected response:

```json
{
  "status": "healthy",
  "database": "connected",
  "platform": {
    "eventLoopStallMs": 1,
    "processUptimeMs": 184203,
    "databaseLatencyMs": 41,
    "databaseProbeRetried": false
  },
  "maintenance": { "phase": "OFF", "reason": null, "estimatedEnd": null },
  "betterstack": {
    "configured": true,
    "reachable": true,
    "monitors": [
      { "name": "https://familiarisenow.com", "status": "up" },
      { "name": "https://familiarisenow.com/api/health", "status": "up" }
    ]
  },
  "timestamp": "2026-02-22T10:00:00.000Z"
}
```

If `betterstack.configured` is `false`, the `BETTERSTACK_API_KEY` env var is missing.
If `betterstack.reachable` is `false`, the API key is wrong or BetterStack is unreachable.

`platform` reports the instance the check landed on, not a dependency, and never
changes `status`. `eventLoopStallMs` is 0–2 on a warm instance and 24 000–39 000
on a brand-new one under concurrent creation (#1124); a value over 1 s is also
logged to Sentry as `Cold-instance event-loop stall`, so the stall's frequency is
queryable. `databaseProbeRetried` is true when the first probe's deadline fired
during such a stall and the route re-probed — the retry is what keeps a cold
instance from reporting the database `unreachable` (#1557).

### Step 11: Test via direct API call

```bash
curl -s "https://uptime.betterstack.com/api/v2/monitors" \
  -H "Authorization: Bearer <your-token>" | \
  python3 -m json.tool | grep -A3 '"url"'
```

Should return both monitors with their status.

### Step 12: Test incident lifecycle (optional but recommended)

This tests the full OFFLINE → incident created → maintenance ended → incident resolved flow:

1. Log into the admin dashboard and activate **OFFLINE** maintenance mode
2. Check `POST /api/admin/maintenance` returns `betterstackIncidentId` in the response
3. Go to [https://uptime.betterstack.com/team/t332379/incidents](https://uptime.betterstack.com/team/t332379/incidents)
4. Verify a new incident was created automatically
5. End maintenance mode via the admin dashboard
6. Return to BetterStack incidents — the incident should show as "Resolved"

---

## Account Details (Current Setup)

| Item                   | Value                                                          |
| ---------------------- | -------------------------------------------------------------- |
| **BetterStack URL**    | https://uptime.betterstack.com/team/t332379                    |
| **Email**              | teetangh@gmail.com                                             |
| **Plan**               | Free                                                           |
| **Monitor 1**          | `https://familiarisenow.com` (public: "Website")               |
| **Monitor 2**          | `https://familiarisenow.com/api/health` (public: "API Health") |
| **Check frequency**    | 3 minutes (free plan minimum)                                  |
| **API Health timeout** | 60 s request timeout, 1 min confirmation (see Step 3, #1557)   |
| **Alert type**         | Email only (push/SMS require paid plan)                        |
| **Status page**        | https://familiarise.betteruptime.com                           |
| **API token name**     | "Familiarise Production"                                       |
| **API base URL**       | `https://uptime.betterstack.com/api/v2`                        |

---

## Code Integration Summary

The BetterStack integration lives in two files:

### `lib/betterstack.ts`

Exports two functions:

- `createIncident(name, summary?)` — Creates a BetterStack incident. Returns the incident ID (`string | null`).
- `resolveIncident(incidentId)` — Resolves an incident by ID. Returns `boolean`.

Both functions fail gracefully: if `BETTERSTACK_API_KEY` is missing or the API call fails, maintenance mode still activates (fail-open design).

### `app/api/admin/maintenance/route.ts`

- **POST** (start maintenance): If phase is `OFFLINE`, calls `createIncident()`. Stores the returned `incidentId` in Redis as part of the maintenance config JSON (`maintenance:config`).
- **DELETE** (end maintenance): Reads `betterstackIncidentId` from the current state and calls `resolveIncident()`.

### `lib/maintenance.ts`

`MaintenanceState` interface includes `betterstackIncidentId: string | null`. The Redis config JSON (`maintenance:config`) includes it:

```json
{
  "reason": "...",
  "estimatedEnd": "...",
  "bypassSecret": "...",
  "betterstackIncidentId": "12345"
}
```

### `app/api/health/route.ts`

Calls `GET https://uptime.betterstack.com/api/v2/monitors` on every health check request (5-second timeout). Returns:

```typescript
{
  configured: boolean,   // BETTERSTACK_API_KEY is set
  reachable: boolean,    // API call succeeded
  monitors: Array<{ name: string, status: string }>
}
```

---

## Troubleshooting

### "betterstack.configured: false" in /api/health

The `BETTERSTACK_API_KEY` env var is not set. Check:

- Local: Is it in `.env`?
- Production: Is it in Netlify environment variables? Was the site redeployed after adding it?

### "betterstack.reachable: false" in /api/health

The API key exists but the call failed. Check:

- Is the token correct? Verify it in BetterStack Settings → API tokens
- Did the token get accidentally deleted? Generate a new one and update `.env` + Netlify.

### Incident not created when entering OFFLINE mode

1. Check server logs for `[BetterStack] API error:` or `[BetterStack] Failed to create incident:`
2. Verify `BETTERSTACK_API_KEY` is set in production
3. Check BetterStack rate limits (unlikely on free plan)
4. The maintenance mode still activates even if incident creation fails — only the BetterStack sync is affected

### Incident not resolved when ending maintenance

1. Check if `betterstackIncidentId` was stored. The POST response to `/api/admin/maintenance` includes it.
2. If null, incident creation failed when maintenance started. Resolve manually in BetterStack.
3. Manual resolution: BetterStack dashboard → Incidents → find the incident → click "Resolve"

### Status page not showing incident

BetterStack incidents automatically appear on the status page linked to your account. No manual configuration needed. If the incident was created but not showing, wait 1-2 minutes for propagation.
