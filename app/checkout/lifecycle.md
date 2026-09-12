# Checkout UI — Back button + Mock Pay on previews

Change bundle for the checkout surfaces:

- A shared smart Back button on every checkout page (plan pages, trial) that
  survives the "empty history" edge (deep link, or first-time sign-in ->
  onboarding redirect where `router.replace` leaves nothing to go back to).
- A shared mock-payment gate so the Mock Pay button works on local dev AND on
  Netlify preview builds (`deploy-preview` / `branch-deploy`) — never on
  production — both for the server route and the client button.

This file is the design record; the lifecycle matrix at the bottom is
inventory + intended design (no new check-in/check-out/lookup UI shipped).

## Back button

`app/checkout/components/CheckoutBackButton.tsx` — client component:

```
on click:
  window.history.length > 1 ? router.back() : router.replace(sourceHref)
```

- `sourceHref` is per-family:
  - consultation -> `/explore/experts/{consultantProfile.id}` (expert profile)
  - subscription -> `/explore/programs/plans/subscriptions/{planId}`
  - webinar -> `/explore/programs/plans/webinars/{planId}`
  - class -> `/explore/programs/plans/classes/{planId}`
  - trial -> `/dashboard` (linked from paid-trial widgets / appointment sheet)
- If history is non-empty we go back; if not we REPLACE to the source so a
  later "Back" never lands back on checkout.
- The onboarding-wizard edge self-heals downstream: an onboarded user who ends
  up back on `/form/onboarding` is bounced to `/dashboard` by
  `requireNotOnboarded` (auth-guard.ts) — we never re-loop them into the
  wizard, and `requireOnboarded` (checkout layout) handles the forward path.
- Error-state "Go back" now uses the same component (was `window.history.back()`).

## Mock pay gating

One source of truth: `shouldEnableMockPayments()` in
`lib/payments/operations/mock.ts`, re-exported as `isMockPayEnabled()` by
`app/checkout/plans/mockPay.ts`:

```
NODE_ENV === "development"                  -> true   (local)
CONTEXT === "deploy-preview" | "branch-deploy" -> true (server-side only)
ENABLE_MOCK_PAYMENTS === "true"                 -> true (ops escape hatch)
NEXT_PUBLIC_MOCK_PAYMENTS_ENABLED === "true"    -> true (inlined client-side)
```

- The server route (`app/api/checkout/route.ts`) gates on `isMockPayEnabled()`
  so a preview build accepts `isMockPayment`. Production (`CONTEXT=production`)
  never does.
- The client button gates on the same util. `CONTEXT` is not inlined into
  client bundles, so `netlify.toml` exports
  `NEXT_PUBLIC_MOCK_PAYMENTS_ENABLED=true` under `[context.deploy-preview]`
  and `[context.branch-deploy]`. Preview checkouts are still auth + rate-limited.
- The same check powers `createPaymentIntent`'s mock branch
  (`lib/payments/index.ts` → `shouldEnableMockPayments()`). Without it, a
  preview would accept `isMockPayment: true` at the route and then fall through
  to a REAL gateway call — the mocked path must stay in lockstep with the
  route gate.
- Scope on previews is Mock Pay ONLY. Simulating Razorpay/Stripe webhooks on a
  preview (to exercise post-capture flows) is a follow-up, described below.

## What we deliberately did NOT change

- The 4 plan checkout pages stay client components (interactive discount /
  referral / org-payer / tax + gateway modal UI). No server actions on this
  money path — `POST /api/checkout` route stays.
- Success / failure pages unchanged (success already redirects to dashboard;
  failure has its own back + support CTA).
- No server-component data-fetching refactor here (see follow-ups).

## Follow-ups (inventory, not shipped)

1. **Data fetching**: the plan pages read plan/slot/credits via `useEffect` +
   `fetch` client-side. Next 16 guidance is server-first: static-ish reads
   (plan, reviews, slot) are candidate server fetches passed to client leaves;
   personalized reads (credits, tax context, discount validation) and all
   mutations stay on the API. Convert carefully, separately, with mock-dev
   verification — this is a money path.
2. **Preview webhook simulation**: Razorpay/Stripe capture webhooks are not
   simulated on previews, so a Mock Pay on the preview never exercises
   webhook-driven post-capture state. Ships only after previews are password /
   ACL protected (see next item), otherwise it is an open paid-for-booking
   minting surface.
3. **Preview access control**: no preview password/ACL today. Add that before
   exposing anything more than the (auth + rate-limited, developer-gated) Mock
   Pay button.

## Lifecycle matrix (status -> dominant action today)

Design intent for check-in / check-out / lookup: presence is auto-captured by
Stream webhooks into `MeetingAttendance` (`firstJoinedAt`, `lastLeftAt`,
`joinCount`) which feeds no-show detection. No explicit check-in/out UI is
needed — a learner "checking in" IS joining the call, which is recorded. The
dominant surfacing is the dashboard's action item + appointments list, not a
dedicated check-in/out/lookup page.

`AppointmentStatus` (Booking -> Appointment):

| Status                     | Consultee sees / does                          | Consultant sees / does      |
| -------------------------- | ---------------------------------------------- | --------------------------- |
| PENDING                    | "Awaiting consultant" ; no pay, no join        | Allocate slot (#bookings)   |
| APPROVED / APPROVED_PENDING_PAYMENT | Pay CTA while unpaid (checkout / pending-payments widget); slot held | Approved; holds slot |
| SCHEDULED                  | Join CTA in join window (10 min pre-start)     | Join CTA (15 min pre-start) |
| COMPLETED                  | Review/feedback; recording                       | Summary / earnings           |
| REJECTED / CANCELLED / EXPIRED | Refund / re-book affordances, no Join      | Slot released back to grid  |

`TrialSessionStatus`:

| Status           | Consultee sees / does                       | Notes                          |
| ---------------- | ------------------------------------------- | ------------------------------ |
| PENDING          | Waiting on consultant                       |                                |
| AWAITING_PAYMENT | Trial checkout (this PR's trial page)       | pay-link; `paymentDueAt` window |
| SCHEDULED        | Join CTA in join window                     | trial slot confirmed           |
| COMPLETED        | Convert CTA (subscribe) or finish           |                                |
| CONVERTED        | Active subscription                         |                                |
| CANCELLED / REJECTED | Re-request, no Join                      | expired unpaid lapses here     |

`MeetingAttendance` is written by `lib/stream/session-handlers.ts` from Stream
webhooks; no user-facing check-in/out/lookup page or API is added in this PR.