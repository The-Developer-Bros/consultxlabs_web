---
title: Load gate runbook — chaos scenarios 6, 14c and 17
band: 50-operations
audience: sde3
status: built-not-executed
last-reviewed: 2026-09-03
---

# Load gate runbook

This runbook covers the k6 harness under `load-tests/booking/`, which is the
exit gate for the B2C hardening train (#837) and the booking-journey train
(#1169), tracked on #874. The chaos test runbook
(`07-chaos-test-runbook.md`) lists seventeen scenarios and records three of
them as never having been executed: scenario 6, the load ramp to twice the
expected peak; scenario 14c, the enterprise allocation races; and scenario 17,
the flash-sale hot-slot and hot-event storm. This harness exists to run those
three.

The harness is built and has not been executed. Every number in the result
table below is blank on purpose, and the first person to dispatch the workflow
fills them in.

## The warning that comes before everything else

**One Supabase project serves both the development and the production
deployment.** There are no database branches. A deploy preview and the
production site read and write the same rows. Every appointment this harness
creates is a real appointment on a real consultant's calendar, every event
seat it takes is a real seat, and — because a mock purchase commits as
`SUCCEEDED` inside the request rather than waiting for a webhook — every mock
consultation also writes a real `ConsultantEarnings` row.

Three consequences follow, and none of them is optional.

The first is that the run must use fixtures nobody minds being disturbed: a
seeded consultant, a seeded event, seeded buyer accounts. Pointing the harness
at a real consultant's calendar is a customer incident.

The second is that cleanup is part of the run, not a courtesy afterwards. The
workflow runs it on every path, including after a failed storm, and treats its
failure as a workflow failure.

The third is that the run should be scheduled for a quiet window. The load is
real load against real infrastructure, and the Netlify function concurrency
budget, the Supavisor pooler and the Upstash quota are shared with whoever is
using the site at that moment.

## Prerequisites

### k6

Version 0.52 or newer. The scripts use optional chaining and nullish
coalescing, and the workflow's `grafana/setup-k6-action` installs a current
build. Locally, `brew install k6`.

### A target

A Netlify deploy preview URL. The workflow validates `base_url` before it does
anything else, and it validates by allowlist rather than by denylist. The host
must be `https://`, it must carry the `<context>--<site>.netlify.app` double
dash that a deploy preview or a branch deploy has and the bare production alias
does not, and it must not end in the production hostname. The reason the
allowlist is not merely a refusal of the production name is that every request
this harness sends carries a pre-minted production session cookie, so any host
the input names can collect those cookies. A typo is the ordinary failure this
guard catches; a deliberately hostile target is the one it is shaped for.
Widening the allowlist is therefore a deliberate edit to the workflow, not a
dispatch-time choice — although, as the warning above says, the database is
shared either way.

`peak_vus` is validated in the same step and must be digits only. It is
evaluated arithmetically when the job writes its summary, and bash arithmetic
re-expands its operands, so a non-numeric value is a command-execution path
rather than a bad number.

There is a second, subtler consideration in choosing the target, and it decides
what the run is actually measuring.

### The mock-payment flag, and why a deploy preview changes the run

`POST /api/checkout` honours `isMockPayment` only when the server is running
with `NODE_ENV=development`:

```ts
const isMockPayment =
  body.isMockPayment === true && process.env.NODE_ENV === "development";
```

A Netlify deploy preview is a production build, so on a preview the flag is
silently ignored. No error is raised; the checkout simply proceeds as a real
gateway order. `ENABLE_MOCK_PAYMENTS` does not rescue this, because the
route-level gate has already zeroed the flag before the operation that consults
that variable is reached.

The two targets therefore measure different things, and the runbook records
both because both are legitimate.

Against a **development-mode server** the flag is honoured, and one
`POST /api/checkout` is the entire purchase: the slots are written with
`isTentative: false`, the payment is written `SUCCEEDED` with a null
`expiresAt`, the participant rows are `CONFIRMED`, and the earnings are created
in the same request. No webhook, no verify call. This is the configuration that
exercises the full confirm path, and it is what scenario 17's "exactly one
confirmed consultation slot" invariant literally means. Note that the mock
gateway sleeps 500 ms on purpose, so subtract that from every checkout latency
figure before comparing against the budgets below.

Against a **deploy preview** the checkout stops at a tentative hold: a real
gateway order, a `PENDING` payment with a thirty-minute `expiresAt`, and slots
written `isTentative: true`. The concurrency guards under test — the event
mutex, the consultee lock, the tentative-inclusive capacity recount, the
Serializable transaction — all run identically, because they run before the
payment resolves. What is _not_ exercised is the confirm-time recheck. A
preview run is a valid measurement of the lock and capacity stack and an
invalid measurement of the confirmation stack. Say which one was run when the
numbers are recorded.

### Seed users

The seed suite's password is `SeedPass123!`. The harness needs three kinds of
credential:

- **Buyers.** The accounts that check out, cancel and reschedule. More is
  better, for a reason given under "the limiters" below.
- **Org admins.** For scenario 14c, the accounts that race each other to
  allocate. One admin retrying ten times is not the race; ten admins racing
  once is.
- **A verifier.** The consultant who owns the fixtures, or an `ADMIN`/`STAFF`
  account. Both integrity oracles are self-scoped routes and will answer 403 to
  anyone else.

### The auth method, and why it is a cookie

The harness reuses the race-condition suite's approach — a Better Auth session
cookie from `POST /api/auth/sign-in/email`, replayed on every subsequent
request. This is not a preference. The codebase has no machine-token rail:
`requireApiAuth` and `getSession` both read the Better Auth session, so a
session cookie is the only credential the write routes accept. There is no API
key to issue.

Two things about that cookie decide how the run is set up.

**Origin.** Better Auth validates the request `Origin` against
`BETTER_AUTH_TRUSTED_ORIGINS`, and that variable holds the production URL in
every Netlify context. A sign-in against a deploy preview that sends the
preview's own origin is answered 403 `INVALID_ORIGIN`. The harness therefore
sends `AUTH_ORIGIN` — the trusted production URL — while the requests
themselves go to `BASE_URL`. Set `LOAD_GATE_AUTH_ORIGIN` to the production URL
whenever the target is a preview.

**The sign-in limiter.** It is ten requests per fifteen minutes per IP,
enforced in the edge middleware because Better Auth's own limiter is
per-process and useless on serverless. A k6 run comes from one runner address,
so the whole run may sign in at most ten times — and a failed run cannot be
retried inside the same window. The harness therefore signs in only inside
`setup()`, caps itself at four buyers and four org admins to leave headroom,
and prefers **pre-minted session cookies** supplied through
`LOAD_GATE_AUTH_TOKEN`. For any serious run, mint the cookies out of band and
pass them in; signing in from the harness is the convenience path for a small
local run, not the gate path.

### Fixtures

The identifiers below are repository variables rather than secrets, because an
id is not a secret and hiding it makes the run log unreadable. Each one is
listed with what it must point at.

| Variable                                    | What it is                                                                                                                                                                                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOAD_GATE_CONSULTANT_IDS`                  | `consultantProfile` ids the browse mix reads availability for.                                                                                                                                                                                       |
| `LOAD_GATE_CONSULTANT_PROFILE_IDS`          | The profiles the integrity check sweeps for double-booked minutes.                                                                                                                                                                                   |
| `LOAD_GATE_PLAN_IDS`                        | `ConsultationPlan` ids, positionally paired with the consultant ids.                                                                                                                                                                                 |
| `LOAD_GATE_SLOT_AVAILABILITY_WEEKLY_ID`     | A published weekly availability row for the target consultant. Exactly one of this and the custom id may be set.                                                                                                                                     |
| `LOAD_GATE_SLOT_AVAILABILITY_CUSTOM_ID`     | The custom-schedule alternative.                                                                                                                                                                                                                     |
| `LOAD_GATE_EVENT_ID`                        | The webinar or class instance the hot-event storm attacks.                                                                                                                                                                                           |
| `LOAD_GATE_EVENT_PLAN_ID`                   | Its plan.                                                                                                                                                                                                                                            |
| `LOAD_GATE_EVENT_TYPE`                      | `WEBINAR` or `CLASS`.                                                                                                                                                                                                                                |
| `LOAD_GATE_EVENT_CAPACITY`                  | The effective seat count — the instance's `maxParticipants` when it overrides, otherwise the plan's.                                                                                                                                                 |
| `LOAD_GATE_EVENT_EXCLUDE_USER_IDS`          | The host's user id. See "what the API cannot tell you".                                                                                                                                                                                              |
| `LOAD_GATE_HOT_PLAN_ID`                     | The plan for the single contested consultant-minute.                                                                                                                                                                                                 |
| `LOAD_GATE_HOT_SLOT_STARTS_AT` / `_ENDS_AT` | That minute, as ISO-8601 instants exactly thirty minutes apart.                                                                                                                                                                                      |
| `LOAD_GATE_ALLOCATE_EVENT_IDS`              | Consultation, subscription, webinar or class ids for the allocation race. The first is the one every racer targets.                                                                                                                                  |
| `LOAD_GATE_ALLOCATE_EVENT_KIND`             | The route family: `consultations`, `subscriptions`, `webinars` or `classes`.                                                                                                                                                                         |
| `LOAD_GATE_CANCEL_APPOINTMENT_IDS`          | Cancellable appointments the buyer pool owns. A run consumes them.                                                                                                                                                                                   |
| `LOAD_GATE_RESCHEDULE_APPOINTMENT_IDS`      | Reschedulable appointments the buyer pool owns, and whose consultant is in the `LOAD_GATE_CONSULTANT_TOKEN` pool — the respond leg answers the counterparty only, so a consultant who does not own the appointment is refused 404 and the run fails. |
| `LOAD_GATE_CONSULTEE_PROFILE_IDS`           | Optional, positionally paired with the buyer credentials; only cleanup's third pass uses them.                                                                                                                                                       |
| `LOAD_GATE_WINDOW_START`                    | Optional. The start of the marked booking window. When it is unset the workflow resolves 04:00 UTC tomorrow ONCE and hands the same instant to all three k6 processes; set it here rather than through `fixture_overrides`.                          |

The slot times must sit inside the consultant's published availability. Since
#1320 checkout validates the booking window as interval containment against the
union of the consultant's published rows, and the named availability row only
proves ownership — but a window the consultant does not publish is still
refused, with a 400 rather than the 409 a lost race earns.

### Secrets

These must exist as repository secrets before the workflow can run.

| Secret                       | Required                         | What it holds                                                                                                                                                   |
| ---------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOAD_GATE_AUTH_TOKEN`       | Yes (or the e-mail pair)         | Pre-minted buyer session cookies, `\|`-separated. Each entry is a full cookie header value, e.g. `better-auth.session_token=...; better-auth.session_data=...`. |
| `LOAD_GATE_VERIFY_TOKEN`     | Yes                              | One pre-minted cookie for the consultant who owns the fixtures, or an `ADMIN`/`STAFF` account. Both integrity oracles are self-scoped.                          |
| `LOAD_GATE_ORG_ADMIN_TOKEN`  | For scenario 14c                 | Pre-minted org-admin cookies, same format.                                                                                                                      |
| `LOAD_GATE_CONSULTANT_TOKEN` | For the reschedule respond leg   | Pre-minted cookies for the consultants that own the reschedule fixtures, same format. The respond route answers the counterparty only.                          |
| `LOAD_GATE_AUTH_ORIGIN`      | Yes when the target is a preview | The production URL, which is what `BETTER_AUTH_TRUSTED_ORIGINS` contains.                                                                                       |
| `LOAD_GATE_BUYER_EMAILS`     | Fallback                         | Comma-separated seed e-mails, used only when no cookies are supplied.                                                                                           |
| `LOAD_GATE_ORG_ADMIN_EMAILS` | Fallback                         | The same for org admins.                                                                                                                                        |
| `LOAD_GATE_BUYER_PASSWORD`   | Fallback                         | Defaults to `SeedPass123!` when unset.                                                                                                                          |

## How to dispatch

Actions → **Load Gate (chaos 6 / 14c / 17)** → Run workflow. The inputs are the
deploy preview URL, the expected peak concurrency, the plateau duration, and
which scenario to run.

`peak_vus` is the **expected** peak, not the ceiling. Scenario 6 ramps to twice
it, which is what the chaos runbook asks for; entering the ceiling there halves
the test.

`skip_cleanup` leaves the rows this run created in the shared production
database, and the workflow therefore **fails on purpose** when it is used. That
is not a bug to be worked around: the red X is the record that a human still
owes the database a manual cleanup. Use it only to debug a cleanup that is
itself broken, and run `load-tests/booking/cleanup.js` by hand afterwards.

Naming one scenario is a claim about what the run measured, so a scenario
dispatched without its full fixture set fails at init with the list of missing
variables rather than running a subset. `SCENARIO=all` is the survey and skips
what it cannot execute — scenario 14c without an org-admin credential, the
hot-event storm without `LOAD_GATE_EVENT_ID`, the mutation ramp without
appointment ids.

The three scenarios can also be run locally, which is the right way to shake
out a fixture problem before spending a gate run:

```bash
k6 run \
  --summary-trend-stats "avg,med,p(95),p(99),max" \
  --env BASE_URL=http://localhost:3000 \
  --env SCENARIO=17 \
  --env BUYER_COOKIES='better-auth.session_token=...|better-auth.session_token=...' \
  --env PLAN_IDS=... --env EVENT_ID=... --env EVENT_PLAN_ID=... \
  load-tests/booking/scenarios.js
```

The `--summary-trend-stats` flag is what puts the p99 column in the report; k6
does not compute it by default, and without the flag that column reads as a
dash.

Each write path also has its own runnable script — `checkout-consultation.js`,
`checkout-event.js`, `allocate.js`, `cancel.js` and `reschedule.js` — for
isolating one path when a composed run points at it.

## What "pass" means

Every criterion below is encoded as a k6 threshold in
`load-tests/booking/lib/thresholds.js`, so the run's exit code is the verdict
rather than a human reading a report. The table records where each number comes
from: a platform _ceiling_, a criterion already _published_ in the chaos
runbook, or a _budget_ this harness sets for the first run and which should be
revisited once #874 has a real measurement.

| Threshold                               | Value                                  | Source           |
| --------------------------------------- | -------------------------------------- | ---------------- |
| `booking_gateway_timeouts_504`          | `count == 0`                           | published (17)   |
| `booking_timeout_rate`                  | `rate == 0`                            | published (17)   |
| `booking_server_errors_5xx`             | `count == 0`                           | published (17)   |
| `booking_server_error_rate`             | `rate < 0.05`                          | published (6)    |
| `booking_lock_unavailable_503`          | `count == 0`                           | budget           |
| `booking_winners{path_group:hot_slot}`  | `count <= 1`                           | published (17)   |
| `booking_winners{path_group:hot_event}` | `count <= EVENT_CAPACITY`              | published (17)   |
| `path_read_duration`                    | `p(95) < 2000 ms`                      | published (6)    |
| `path_checkout_duration`                | `p(95) < 8000 ms`, `max < 26000 ms`    | budget + ceiling |
| `path_allocate_duration`                | `p(95) < 10000 ms`, `p(95) < 26000 ms` | budget + ceiling |
| `path_cancel_duration`                  | `p(95) < 8000 ms`                      | budget           |
| `path_reschedule_duration`              | `p(95) < 6000 ms`                      | budget           |
| `path_respond_duration`                 | `p(95) < 6000 ms`                      | budget           |
| `http_req_duration`                     | `p(99) < 26000 ms`                     | ceiling          |
| `checks`                                | `rate > 0.99`                          | budget           |
| `integrity_violations`                  | `count == 0`                           | published (17)   |

The twenty-six second figure is the Netlify function ceiling. Anything at or
past it is a 504 to the buyer regardless of what the application intended.

### How a losing racer is graded

This is the point most easily got wrong. In a hot-slot storm, fifty of the
fifty-one requests are _supposed_ to fail — only one buyer may hold a
consultant-minute. Counting those as errors would make a correct system look
broken. What the gate grades is _how_ a loser is turned away.

A structured 409 is a pass: the guard did its job and said so. That covers
`EVENT_CHECKOUT_BUSY` and `CONSULTEE_BOOKING_BUSY`, which carry a `retryAfter`
and are the client's cue to auto-retry once, and `SERIALIZATION_CONFLICT`,
which is an exhausted P2034 retry meaning the transaction never committed and
nothing was charged. A sold-out 4xx is a pass: the optimistic capacity
pre-check answered before the mutex was even requested, which is the cheapest
possible refusal. A 400 from the slot validator is a pass for a consultation
racer, because "time slot is already booked" is a true and useful answer.

A 401, 403, 404, 405 or 422 is a failure, and it is a different kind of failure
from the ones above: it means the request never reached the guard under test at
all. The credential was wrong, the fixture does not exist for that caller, or
the body was the wrong shape. These are counted in `booking_unexpected_4xx` and
they fail the `checks` threshold, because a run in which every request was
answered 401 would otherwise read as a clean sweep of honest refusals and pass
a gate that measured nothing.

A 502 or a 504 is a failure, and it is the single most important line in the
gate. It means a lock, or a lock's retry budget, outlived the function ceiling —
exactly the class of defect #1328 fixed and exactly what this gate exists to
catch a regression of. Any other 5xx is a failure: an unhandled path.

A typed 503 is counted separately, in its own metric with its own threshold.
Both lock rails fail _closed_ with a 503 when Redis is unreachable. That is the
designed answer rather than a crash, so it does not contaminate the 5xx rate —
but it does mean the run measured Upstash rather than the booking path, so the
gate fails on it all the same.

### Per scenario

**Scenario 6 passes** when the 5xx rate stays under five percent, the browse
read p95 stays under two seconds, no request approaches the function ceiling,
and the run completes without pool exhaustion. Two of the runbook's four gauges
are read directly from the summary — function duration and the
serializable-retry exhaustion rate, which appears as `p2034Conflicts`. The
other two are watched live while the run is in flight: `pg_stat_activity`
against the pooler limit in the Supabase dashboard, and the lock-acquisition
retry rate in Upstash. Record all four.

The serializable-retry exhaustion rate is the launch metric. PostgreSQL's SSI
predicts a five to twenty percent conflict rate under contention, so conflicts
themselves are expected; what matters is how often `withSerializableRetry`
gives up, because that is a booking a buyer did not get.

**Scenario 14c passes** when the concurrent allocations produce no 5xx, no
timeouts, and no over-allocation. The CAS guards shipped with #825 and #826 and
are exercised at the service level; this is the first time they are exercised
through the API.

**Scenario 17 passes** when exactly one buyer holds the contested
consultant-minute, the event holds no more registrations than it has seats,
there are no raw 502 or 504 responses, and every non-winner received either an
honest sold-out or busy 4xx or a successful auto-retry. The storm's own
thresholds assert the first two from the request side; `verify-integrity.js`
asserts them again from the database side, because a 2xx is a claim and a
confirmed slot is a fact, and the two have diverged before — the #827
confirm-time recheck exists precisely because they did.

## What the API cannot tell you

The integrity check reads through public routes rather than the database, which
is the right constraint and also a real limitation. Three gaps are worth
knowing before reading its output.

**There is no capacity endpoint.** `readEventCapacity` is module-private to the
checkout operation, and `getWebinarCapacity` and `getClassCapacity` are
server-only. Nothing over HTTP returns `{max, registered, remaining, isFull}`.
The verifier therefore re-derives the registered count by de-duplicating
participant ids from `GET /api/participants/{webinar,class}/[id]`, and takes
the ceiling from `EVENT_CAPACITY` unless the roster response carries the
instance or plan `maxParticipants`. That roster does _not_ exclude the host,
while the server's own capacity arithmetic does, so the host's user id must be
listed in `LOAD_GATE_EVENT_EXCLUDE_USER_IDS` or the event will read as one seat
over-booked.

**The public availability route reports only free slots.** A booked minute
simply vanishes from `GET /api/slots/availability/[consultantId]`; there is no
field distinguishing free from tentative from confirmed, and the response is
CDN-cached for fifteen seconds. It is useless as a double-booking oracle. The
verifier uses `GET /api/slots/appointments` instead, which returns full slot
scalars including `isTentative`, `completionStatus` and `deletedAt` — and which
answers 403 to anyone not filtering by their own profile, which is why
`LOAD_GATE_VERIFY_TOKEN` must belong to the consultant or to `ADMIN`/`STAFF`.

**Every seat counts, including unpaid holds.** A user connected to a slot
occupies a seat whether or not their payment has landed. So the capacity
assertion is `registered <= max` _including_ live tentative holds, which is the
correct invariant, but it means a preview run's number includes buyers who
never paid.

## The limiters, and what they do to a run

Every limiter below is Upstash-backed and **fails open** on a Redis error, so
an unreachable Redis silently disables all of them. These are the numbers that
decide how a run must be shaped.

| Limiter           | Budget      | Keyed on | Effect on the run                                                                                                                                                                                    |
| ----------------- | ----------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sign-in           | 10 / 15 min | IP       | The whole run may sign in ten times. Pre-mint cookies.                                                                                                                                               |
| availability read | 30 / min    | IP       | About 0.5 requests per second of browse from one runner. The browse mix runs on its own arrival-rate executor below this ceiling; raising `BROWSE_RPM` without raising the limiter measures Upstash. |
| consultant search | 60 / min    | IP       | Same shape, twice the room.                                                                                                                                                                          |
| checkout          | 5 / min     | user     | N distinct buyers is a ceiling of 5N checkouts per minute _sustained_. An instantaneous burst of two hundred is fine; two hundred sustained needs forty accounts.                                    |
| event mutation    | 10 / min    | user     | Caps cancels and reschedules, and therefore caps cleanup.                                                                                                                                            |
| cancel pending    | 10 / min    | user     | Caps cleanup's optional third pass.                                                                                                                                                                  |
| participant read  | 30 / min    | user     | Caps the integrity check's roster reads.                                                                                                                                                             |

The practical reading: this harness measures the _write_ paths honestly and the
_read_ paths only up to the limiter. A genuine browse-capacity measurement
needs either a raised limiter or a distributed run across several egress
addresses, and that is a known limitation of running the gate from one GitHub
runner.

## Cleanup

The workflow runs `cleanup.js` on every path, including after a failed storm,
and its failure fails the workflow. Run it manually if a local run is
interrupted:

```bash
k6 run --env BASE_URL=... --env BUYER_COOKIES=... load-tests/booking/cleanup.js
```

Discovery is by window rather than by id. The checkout response carries neither
an appointment id nor a payment id — only the gateway order id — and no route
lists a user's payments by order id. So the harness books every consultation
into one declared window and cleanup cancels anything of the buyer pool's that
starts inside it. Do not change `WINDOW_START` between a run and its cleanup.

The storm, the integrity check and the cleanup are three separate k6 processes,
so each of them would derive its own "04:00 UTC tomorrow" if left to. A run that
crossed midnight UTC would then book into one day's window and clean the next
one, leaving production rows behind. The workflow resolves the window once,
before k6 is even installed, and passes that instant to all three steps. A
standalone run must set `WINDOW_START` explicitly for the same reason.

Discovery is also bounded, and the bound is a failure rather than a ceiling.
Cleanup reads at most five pages of a hundred appointments per credential and
cancels at most `CLEANUP_MAX_PER_USER` of them; reaching either limit records a
cleanup failure, so the verdict reads `NEEDS ATTENTION` instead of `CLEAN`.
Raise `CLEANUP_MAX_PER_USER` and run the script again until it comes back clean.

Three passes run in order. The first cancels the consultations and
subscriptions in the window through `POST /api/appointments/[id]/cancel`; the
CAS refuses a second cancel, so re-running the script is safe. The second
releases event seats through `DELETE /api/participants/{webinar,class}/[id]`,
which is idempotent and answers 200 with `removed: false` when the seat is
already gone. The third, which only matters for a preview run, cancels the
pending gateway holds through `DELETE /api/checkout/pending/[paymentId]`; it
needs `CONSULTEE_PROFILE_IDS` and is safe to skip, because those holds carry a
thirty-minute `expiresAt` and the abandoned-payment sweep expires them anyway.

That third route is useless against a development-mode run, and knowing why
saves a confused half-hour: a mock purchase commits as `SUCCEEDED`, never
`PENDING`, so the route answers 409 for it permanently. Mock purchases are
undone by cancelling the appointment, which is what the first pass does.

Cleanup is slow on purpose. The event-mutation limiter is ten per minute per
user, so the script pauses six and a half seconds between cancels for each
credential. A loop that does not pause measures the limiter and leaves
production rows behind.

## Recording the result on #874

Paste this table into #874 with the numbers filled in, one block per scenario
run. The artifacts — `load-gate-summary.json`, `load-gate-summary.html`,
`integrity-result.json` and `cleanup-result.json` — are attached to the
workflow run and retained for ninety days; link the run alongside the table.

```markdown
### Load gate — scenario <6 | 14c | 17> — <YYYY-MM-DD>

|               |                                                                                |
| ------------- | ------------------------------------------------------------------------------ |
| Target        | <deploy preview URL>                                                           |
| Target mode   | <development (mock payments honoured) / production build (real gateway holds)> |
| Expected peak | <PEAK_VUS> VUs (ramped to <2x>)                                                |
| Plateau       | <DURATION>                                                                     |
| Workflow run  | <link>                                                                         |

| Path               |   n | p50 | p95 | p99 | max |
| ------------------ | --: | --: | --: | --: | --: |
| checkout           |     |     |     |     |     |
| allocate           |     |     |     |     |     |
| cancel             |     |     |     |     |     |
| reschedule         |     |     |     |     |     |
| reschedule/respond |     |     |     |     |     |
| reads (browse)     |     |     |     |     |     |

| Outcome                         | Count |
| ------------------------------- | ----: |
| winners (2xx)                   |       |
| conflicts (409)                 |       |
| busy (409 + retryAfter)         |       |
| serialization conflicts (P2034) |       |
| sold out                        |       |
| rate limited (429)              |       |
| lock unavailable (503)          |       |
| timeouts (502/504)              |       |
| server errors (other 5xx)       |       |

| Gauge                                           | Value                   |
| ----------------------------------------------- | ----------------------- |
| 409 rate (conflicts / total writes)             |                         |
| P2034 retry-exhaustion count                    |                         |
| 504 count                                       |                         |
| Pooler connections at peak (`pg_stat_activity`) |                         |
| Redis lock-acquisition retries at peak          |                         |
| Integrity check                                 | PASS / FAIL             |
| Cleanup                                         | CLEAN / NEEDS ATTENTION |
| Thresholds breached                             |                         |

Verdict: PASS / FAIL. Notes:
```

## Status

Built, not executed. Nothing in this document has been measured; the harness
has never been pointed at any environment. The budget thresholds are first
guesses and should be tightened once there is a real distribution to tighten
them against.
