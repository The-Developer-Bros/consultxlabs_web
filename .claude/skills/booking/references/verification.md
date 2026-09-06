---
name: booking-verification
description: How to actually prove a booking change works in this repo — which jest suites cover what, the prisma-mocking patterns the tests use, the shared-node_modules worktree trap, what CI does and does not block on, the seeded dev-server plus mock-payment recipe, the chaos runbook, the race workflow, and the standing prohibition on db push against the shared Supabase project. Load before claiming a booking, slot, allocation, checkout, refund or maintenance change is verified, and when writing or running tests under __tests__/booking-algorithm, __tests__/payments, __tests__/booking, __tests__/maintenance or __tests__/collaborators.
---

# Booking Verification

A booking change is verified when the right jest suite passes, a real request
against a running app produces the right database state, and — for anything
touching a lock or a CAS transition — the chaos scenarios pass too. Unit tests
alone do not settle a concurrency claim.

## 1. Which suite covers what

Five folders carry the booking subsystem, and all five exist today.
`__tests__/booking-algorithm/` is the large one (65 suites on merged wave-5
dev): slot validation, allocation, availability scans, reschedule proposals, the
idempotency key, the initial-allocation guard, trial slot integrity, the
hold-expiry predicate, the slot-completion transitions and the collaborator
availability modes. `__tests__/payments/` (50) covers checkout price parity,
refund-preview parity, refund rails, lock TTLs, capture parity, the earnings
healer, the ledger baseline and disputes. `__tests__/booking/` holds five: the
cancellation policy, the tentative-cleanup guard, the expiry-sweep reschedule
race, the no-show refund front door and the slot/session fix pins.
`__tests__/maintenance/` holds eight — freeze, the cron-lock registry, the
`assertNotInMaintenance` guard, the `cleanupRoute()` factory, the DEGRADED
write block, the abandoned-payments reversal, the `SystemJobExecution` prune and
workflow import-env. `__tests__/collaborators/` holds only `availability.test.ts`
— the wave-5 co-host work landed under `__tests__/booking-algorithm/` instead,
so grep both. Run everything with `npm run test`.

## 2. The mocking patterns these suites actually use

There is no `Pick<Prisma.TransactionClient, …>` anywhere in the test tree, and
that is deliberate: `lib/booking/request-caps.ts` records that comparing the
extended client against `PrismaClient` blows tsc's stack, so shared helpers take
inline structural types instead. What the transition helpers _do_ take is
`Pick<Tx, "consultation">` and friends, where `Tx` comes from `@/lib/prisma` —
which is precisely what lets a test hand them a plain object of `jest.fn()`s.

The prevailing shape is four steps. Import `./setup` first, which polyfills
`TextEncoder`/`TextDecoder` for Prisma under jsdom and mocks `lib/novu` (the
Novu client pulls undici's `Request` at import time, which the Jest environment
lacks). Then `jest.mock` the modules — **with relative paths, because `@/`
aliases fail inside `jest.mock`** — including `utils/appointmentlock`, to avoid
the `@upstash/redis` ESM import. Then build a `makeMockTx()` factory returning
one group of `jest.fn()`s per model; `updateMany` resolving `{ count: 1 }`
simulates a successful CAS transition, and `{ count: 0 }` exercises the loser
branch. Finally narrow with `const mockPrisma = prisma as unknown as { … }`.

## 3. The worktree trap: shared `node_modules` and the generated client

Every `fw-*` worktree symlinks both `node_modules` and `.env` into the primary
checkout at `~/Desktop/familiarise_web`. Because `package.json` has
`"postinstall": "prisma generate"` and `"build": "npm run db:generate && next
build"`, running `prisma generate`, `npm run build` or `npm ci` from **any**
worktree rewrites the one shared generated client — clobbering whatever the
other worktrees and the primary checkout were compiling against. This bites
hardest against a branch that changes the schema. Chain the generate with the
check that depends on it (`npx prisma generate && npx tsc --noEmit`) and expect
to regenerate again before switching worktrees. This hazard is documented
nowhere else in the repo; treat this paragraph as the reference.

A related, opposite trap: `jest.config.ts` ignores `/\.claude/worktrees/`, which
covers agent checkouts nested under `.claude/` but **not** the `~/Desktop/fw-*`
worktrees, so jest runs their tests normally and needs no override.
(`.claude/skills/finance/references/razorpay/references/this-repo.md` claims
otherwise.)

A warm incremental `tsc` can also hide type errors here: clear the
`.tsbuildinfo` cache before trusting a clean local run, or trust CI.

## 4. What CI blocks on, and what it merely reports

The only workflow that runs unconditionally on every pull request is
`.github/workflows/ci.yaml` (`pull_request` against `dev`, `staging`, `prod`).
Three others carry a `pull_request` trigger but are conditional and never gate a
booking change: `stream-webhook-drift.yml` fires only on a `paths:` filter over
three `lib/stream/` files, `claude-code-review.yml` only on a `labeled` event,
and `claude.yml` only when a comment or review body contains `@claude`.

CI's `test-and-build` job is the gate: `npx tsc --noEmit`, `npx prisma generate`,
the SSO invariant script, the money-column, workflow-hygiene, DB-sidecar and
DB-drift guards, `npm run test`, and `npm run build`. There is no `typecheck`
script, so type-check locally by typing `npx tsc --noEmit` yourself.

The separate `lint` job is advisory: both the ESLint and Prettier steps carry
`continue-on-error: true`, and the summary prints "non-blocking". There is no
`--max-warnings` anywhere, and the config marks almost everything `warn`; only
`react-hooks/rules-of-hooks` and `no-restricted-imports` are errors. That
layering guard is the one lint rule that catches a bad booking refactor — it
forbids `lib/**`, `components/**`, `hooks/**`, `types/**` and `schemas/**` from
importing anything under `@/app/`. Prettier runs on defaults with no config
file, so run `npx prettier --write` on files you touch and keep formatting-only
churn in its own commit. SonarCloud runs outside CI through Automatic Analysis;
treat its findings as real review feedback anyway.

## 5. Verify against a running app with seeded data

The practical loop is a background dev server plus real HTTP calls, not schema
pushes. Every seeded user shares one password, `SeedPass123!`
(`prisma/seedFiles/1a-create-users.ts`, overridable with `SEED_PASSWORD`), stored
as a bcrypt hash on a BetterAuth `Account` row with `providerId: "credential"`.
The credential roster and the reseed recipe live in
`docs/enterprise/90-audits/03-verification-guide.md` — and the reseed itself is a
write against the shared project, with no production guard anywhere in
`prisma/seed.ts`, so read §7 before running it; the booking- and
money-specific walkthrough is `docs/testing/booking-finance-hardening-test-plan.md`.

Drive checkout with `isMockPayment: true` in the request body. It only works
when `NODE_ENV === "development"`, and it makes the payment succeed immediately,
the slots non-tentative and the gateway call disappear (see
`references/money-boundary.md` §2). That is the cheapest way to produce a real
booking, a real Payment row and real earnings without touching a gateway.

## 6. Concurrency claims need the chaos suite

For anything touching a lock, a CAS transition or an exclusion constraint, run
`npm run test:chaos:api`, which executes the real-API booking and webhook-storm
categories against a seeded database and a running server. The runbook is
`docs/enterprise/50-operations/07-chaos-test-runbook.md`. Its booking scenarios
cover the cancel-versus-reschedule race, the reschedule storm, two concurrent
`DELETE`s on one pending payment (exactly one 200, the loser a 409), the
last-seat storm, and webhook bulk-replay and out-of-order. They restore their
fixtures and move no gateway money, but they are not money-free: the last-seat
storm posts `isMockPayment: true`, which by §5 writes a real `Payment` row and
real earnings, and it then deletes the `Payment`, `PaymentLeg`,
`ConsultantEarnings`, `OrganizationEarnings` and `BookingUtilization` rows again
in a fenced `finally`
(`tests/typescript/race-conditions/scenarios/07-real-api-booking/test-last-seat-storm.ts`)
that logs a warning and leaves them in place when the teardown fails. A local run
against seeded data is sanctioned on that basis, so read the run's output for
that warning afterwards. The money scenarios are not sanctioned, and the runbook
forbids running them against production or the shared development database.
Scenarios that find no reachable server skip rather than fail, so check for SKIP
lines before believing green.

The race workflow `.github/workflows/race-condition-tests.yml` triggers only on
`push` to `dev` and on `workflow_dispatch`. **It has no `pull_request` trigger**,
so it will not run on your PR — dispatch it manually if you want its verdict
before merge.

## 7. Never `db push` against the shared project

One Supabase project serves both development and production, and every `fw-*`
worktree's `.env` symlinks to the same `DATABASE_URL`. `npm run db:push` is
therefore a production operation, as are `--force-reset`, the seed scripts and
the availability coalesce scripts (which is why those default to dry-run and
require `--apply`). The reset itself is a scheduled, owner-approved event with
its own procedure in `docs/prisma/pre-mvp-reset-runbook.md`. If a change needs
new schema, say so and stop; do not push it to prove a test passes.

Since #1322 merged, `db:push` on `dev` is push-then-sidecars-then-assert
(`db:push:schema` = `prisma db push && npm run db:sidecars`, then
`db:assert-sidecars`), so a push can no longer silently leave
`slot_no_confirmed_overlap` and the money CHECK constraints behind. The bare
escape hatch survives as `db:push:no-sidecars-DANGEROUS`. Either way, "Prisma
schema is up to date" says nothing about the sidecars.

## 8. The agent-run E2E corpus

`prompts/booking-algorithm-tests/` holds the numbered end-to-end cases, each a
self-contained QA run that seeds via SQL, exercises the APIs, asserts database
state and cleans up. Conventions (`prompts/README.md`): the database is the
arbiter, each case suffixes its ids and emails with its agent number, and each
carries its rules inline. Add a case when a bug would not have been caught by a
unit test.
