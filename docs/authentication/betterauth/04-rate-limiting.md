# Rate Limiting

| Field | Value |
|---|---|
| Status | Stable |
| Audience | All engineers |
| Last reviewed | 2026-04-26 |
| Source files | `lib/rate-limit.ts`, `lib/redis-edge.ts`, `middleware.ts` |

## 1. Background

Rate limiting prevents brute-force attacks, scraping, spam, and cost amplification under DDoS. All limiters use [Upstash Redis](https://upstash.com/) sliding windows via `@upstash/ratelimit`.

Two categories of limiters exist:

- **Edge limiters** — applied in `middleware.ts`, run before any serverless function. IP-keyed. Prevents cost amplification.
- **Handler limiters** — applied inside API route handlers. User-keyed or route-scoped. Provides per-user fairness.

## 2. Design

### 2.1 Fail-Open Posture

```typescript
try {
  const { success } = await limiter.limit(identifier);
  if (!success) return NextResponse.json(..., { status: 429 });
  return null;
} catch {
  return null; // Redis down — fail open
}
```

> [!IMPORTANT]
> If Upstash Redis is unreachable, **all rate limits fail open** — requests proceed. This is intentional: shipping a request during a Redis outage beats 429-ing every login. Monitor Upstash uptime in the ops dashboard.

### 2.2 Complete Limiter Table

#### Edge-Applied (middleware.ts)

| Limiter | Endpoint | Key | Limit | Window |
|---|---|---|---|---|
| `authLimiter` | POST `/api/auth/sign-in`, `sign-up`, `forget-password` | IP | 10 | 15 min |
| `searchLimiter` | GET `/api/user/consultants` | IP | 60 | 1 min |
| `eligibilityLimiter` | GET `/api/trials/check-eligibility` | IP | 20 | 1 min |
| `newsletterLimiter` | POST `/api/newsletter/subscribe` | IP | 3 | 1 hr |
| `availabilityLimiter` | GET `/api/slots/availability/` | IP | 30 | 1 min |
| `orgInviteAcceptLimiter` | POST `/api/organizations/invitations/accept` | IP | 30 | 1 hr |
| `ssoDomainCheckLimiter` | GET `/api/auth/sso/domain-check` | IP | 60 | 1 hr |
| `orgWalletTopUpLimiter` | POST `…/billing-account/wallet/top-ups` | `org:<orgId>` | 20 | 1 hr |

#### Handler-Applied (inside route handlers)

| Limiter | Endpoint | Key | Limit | Window |
|---|---|---|---|---|
| `checkoutLimiter` | POST `/api/checkout` | userId | 5 | 1 min |
| `discountLimiter` | POST `/api/payments/discounts/validate` | userId | 10 | 1 min |
| `referralApplyLimiter` | POST `/api/referrals/apply` | userId | 3 | 24 hr |
| `spamLimiter` | support-tickets, feedbacks, reviews, report | `<route>:<userId>` | 5 | 1 hr |
| `waitlistLimiter` | POST `/api/waitlist` | userId | 5 | 1 hr |
| `trialRequestLimiter` | POST `/api/trials` | userId | 3 | 24 hr |
| `requestApprovalLimiter` | POST `/api/slots/request-for-approval` | userId | 10 | 1 hr |

### 2.3 Localhost Bypass

All edge limiters skip `::1`, `127.0.0.1`, and `unknown_ip`:

```typescript
const isLocalhost = clientIp === "::1" || clientIp === "127.0.0.1" || clientIp === "unknown_ip";
```

Enterprise limiters have an additional `if (!isLocalhost)` guard. This ensures dev and test flows aren't throttled by rate limits.

### 2.4 IP Extraction

```typescript
export function getClientIp(req) {
  const ip = req.ip ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return ip || "unknown_ip";
}
```

`req.ip` is Vercel/Netlify-provided. Behind other proxies, `x-forwarded-for` is used. Falls back to `"unknown_ip"` (which is localhost-bypassed).

## 3. How to Add a New Rate Limit

1. **Create the limiter** in `lib/rate-limit.ts`:
   ```typescript
   export const myLimiter = makeLimiter(10, "1 h", "rl:my-route");
   ```

2. **If edge-applied** — add to `middleware.ts` before the route classification section:
   ```typescript
   if (req.method === "POST" && pathname.startsWith("/api/my-route")) {
     const rl = await applyRateLimit(myLimiter, clientIp);
     if (rl) return rl;
   }
   ```

3. **If handler-applied** — call in the API route handler:
   ```typescript
   import { applyRateLimit, myLimiter } from "@/lib/rate-limit";
   const rl = await applyRateLimit(myLimiter, `my-route:${session.user.id}`);
   if (rl) return rl;
   ```

4. **Choose the key:** IP for public endpoints, userId for authenticated endpoints, `org:<orgId>` for org-scoped endpoints. Prefix with a route slug when reusing `spamLimiter` across multiple endpoints.

## 4. Edge Cases & Foot-Guns

1. **Shared NAT.** IP-based limits may block legitimate users behind corporate NATs. The `ssoDomainCheckLimiter` at 60/hr is sized for this.
2. **org-keyed wallet limiter.** The `orgWalletTopUpLimiter` extracts `orgId` from the URL path (`pathname.split("/")[3]`). If the URL structure changes, update the extraction.
3. **Redis prefix collision.** Each limiter has a unique prefix (`rl:auth`, `rl:search`, etc.). Never reuse prefixes.

## 5. Related Docs

- [02-middleware.md](./02-middleware.md) — Where edge limiters are wired
- [docs/infrastructure/](../../infrastructure/) — Upstash Redis setup
