# Tour-Prompt Template — Generator for `prompts/tours/<subsystem>-grand-tour.md`

> Use me to scaffold a tour-guide-style walkthrough for any subsystem in
> the familiarise_web codebase. Tests prove correctness; tours teach.
> The output of this meta-prompt is a single Markdown file that an AI
> agent can run end-to-end with a human at its side, pausing to explain
> at every step.

---

## What this is

A meta-prompt. Feed me into an LLM along with the placeholder values
listed below, and the LLM emits a fully-formed tour prompt at
`prompts/tours/<SUBSYSTEM>-grand-tour.md`. The generated tour follows
five standing rules and one opinionated coverage rule that this file
prescribes — no exceptions.

This template does NOT generate test prompts. Tests live under
`prompts/<subsystem>-tests/`; their job is exhaustive 4xx coverage,
ledger reconciliation, snapshot stability, fix-on-sight bug discipline.
Tours are pedagogical: they pause, they explain, they offer the user
the choice between automation and manual driving, they fix bugs in
flight when they encounter them, they re-test the failed scenario
before continuing.

If you're scaffolding a test prompt, use one of the feature files in
`prompts/enterprise-tests/` as your reference instead (e.g.
`prompts/enterprise-tests/3-billing-wallet-invoices/ui-wallet-and-invoice-pay.md`)
and pair with `prompts/enterprise-tests/_shared/case-template.md`.

---

## Placeholders the user must supply

The generator should refuse to emit anything until ALL of these are
filled in. Reject with `error: missing placeholder <NAME>` and a
one-line description of what was expected.

| Placeholder | Type | Example |
|---|---|---|
| `<SUBSYSTEM>` | kebab-case identifier | `enterprise`, `booking`, `onboarding`, `payouts` |
| `<SUBSYSTEM_DISPLAY_NAME>` | human prose | `"Enterprise (Architecture-4)"`, `"Booking algorithm"` |
| `<KEY_MODELS>` | array of Prisma model names | `[Organization, BillingAccount, Contract, Program, ProgramAssignment]` |
| `<KEY_ROUTES>` | array of API route prefixes | `[/api/organizations, /api/auth/sso/domain-check, /api/admin/reconcile-ledgers]` |
| `<KEY_DASHBOARD_PAGES>` | array of UI page paths | `[/dashboard/organization/[orgId], /dashboard/organization/[orgId]/audit]` |
| `<ROLE_LIST>` | array of role lenses | `[OWNER, MAINTAINER, MANAGER, EXPERT, LEARNER, SUPPORT]` |
| `<ENUM_MATRIX>` | the central permutation table | `FundingSource × ProgramType` (2D grid the user supplies inline) |
| `<CROSS_CUTTING_INTEGRATIONS>` | bulleted list | `[Audit log, DNS verification, SSO, Invoice PDF, Razorpay top-up, Reconcile cron, Novu notifications, Anti-lockout]` |
| `<MOCK_SLUG_PREFIX>` | string for tour-only data | `tour-{YYYY-MM-DD}-` |
| `<SUPABASE_PROJECT_ID>` | the project's MCP id | `pzmbxqdgibfkhjwzeprf` |
| `<DEV_SERVER_URL>` | base URL the tour drives | `http://localhost:3000` |
| `<MCP_PROHIBITIONS>` | tools the tour MUST NOT call | `[evaluate_script]` (always include this default) |
| `<READ_FIRST_LINK>` | optional: pointer to a glossary | `prompts/<SUBSYSTEM>-tests/e2e-<subsystem>-shared-setup.md` |

---

## Five standing rules — MANDATORY in every generated tour

The generated tour MUST include a "Standing Rules" section near the top
that quotes these five rules verbatim, with the substituted placeholders.
Do not paraphrase. Do not drop any rule. Do not reorder.

### 1. Pause at every T.x boundary

> Each tour stop is numbered T.1, T.2, … At the start of every stop the
> agent narrates: (a) what we're about to do, (b) why it matters in the
> context of `<SUBSYSTEM_DISPLAY_NAME>`, (c) what the user should
> watch for in the snapshot or the database. Then the agent waits for
> one of these explicit replies:
>
> - `next` — proceed with this stop's actions
> - `rewind` — re-narrate the previous stop (no DB changes)
> - `skip` — mark this stop as skipped and jump to the next stop
> - `stop` — exit the tour, leaving in-flight tour data in place

### 2. Two-flavor offer at every interactive step

> Before any UI input or DB mutation, the agent offers TWO ways to
> proceed and waits for the user to pick one:
>
> - `auto` — the agent drives the input via Chrome DevTools MCP
>   (`fill_form`, `select_option`, `click`, `upload_file`) and narrates
>   each call as it makes it.
> - `manual` — the user drives the input in their own browser tab; the
>   agent narrates what to expect and waits for the user to type
>   `done` before continuing.
>
> Both flavors end at the same observable state. The agent verifies
> that state via Supabase MCP `execute_sql` against
> `<SUPABASE_PROJECT_ID>` before declaring the stop complete.

### 3. Bug-fix in flight

> If a stop's expected outcome doesn't match reality (a 500, a console
> error, a database row that disagrees with the UI), the agent:
>
> 1. Reads `list_console_messages` and `list_network_requests` to
>    locate the failing call.
> 2. Opens the relevant source file (the agent already knows the
>    `<KEY_ROUTES>` and `<KEY_MODELS>` from this template).
> 3. Proposes a one-paragraph fix with the file path + line range.
> 4. Asks the user `fix it` (apply now) or `note it` (skip and log)
>    or `skip` (move on without logging).
> 5. If `fix it`, applies the fix, then proceeds to Rule #4.
>
> The agent never accumulates a bug list. Either fix it now, log it
> with a follow-up issue stub, or explicitly skip.

### 4. Re-test on fail

> After any fix in Rule #3, the agent re-runs the failed scenario from
> the closest stable navigation point (usually the start of the
> current stop). The agent confirms a green outcome before declaring
> the stop complete and pausing for `next`.

### 5. Mock-data scope

> All tour-created records use the slug / name prefix
> `<MOCK_SLUG_PREFIX>` so they are trivially identifiable and
> deletable. The tour MUST NOT modify any record that doesn't carry
> this prefix.
>
> Exception: the agent MAY read non-prefixed records via Supabase MCP
> for orientation (e.g. "here's what the seed cohort looks like"), but
> writes to non-prefixed records require explicit user authorization
> via the message `override scope` followed by a description of which
> record will be touched.

---

## Coverage exhaustiveness rule — OPINIONATED

The generated tour MUST visit every nook and corner of
`<SUBSYSTEM_DISPLAY_NAME>`. Specifically:

- **Every enum value** in the subsystem's primary domain enums must be
  hit by at least one stop. List the enums (and their values) in the
  tour's "Coverage matrix" section near the top. Mark any value that
  the tour deliberately skips (e.g. v2-reserved values) and explain
  why.
- **Every meaningful combination** in `<ENUM_MATRIX>` must be hit. The
  matrix is a 2D grid; the tour must walk each cell that the docs
  declare as supported. Cells marked v2-reserved are observed (the
  agent confirms the API rejects the v2 value with a clean 400) but
  not exercised end-to-end.
- **Every role lens** in `<ROLE_LIST>` gets its own stop in
  Chapter 3. The agent logs in as that role (creating the user via
  Supabase MCP if it doesn't exist), navigates the dashboard, and
  documents what the role can see vs. what's hidden.
- **Every cross-cutting integration** in `<CROSS_CUTTING_INTEGRATIONS>`
  gets its own stop in Chapter 4.

If the user supplies a placeholder value that omits an enum / role /
integration the generator considers material to the subsystem, the
generator should flag it with a warning at the top of the output:
`> WARNING: <ENUM>.<VALUE> is in the schema but missing from the tour.
> Add a stop for it or document why it's skipped.`

---

## Required structural sections of the generated tour

Every generated tour MUST contain these sections, in this order. The
generator that emits the tour file is allowed to add sub-sections but
not to drop or reorder these top-level sections.

1. **Title** — `# <SUBSYSTEM_DISPLAY_NAME> Grand Tour`
2. **Read-first banner** — link to `<READ_FIRST_LINK>` if provided.
3. **Mode of operation** — single paragraph stating: tour-guide
   walkthrough, paused at every stop, NOT a test, two-flavor input.
4. **MCP toolkit** — explicit list of permitted MCP tools (Chrome
   DevTools functions allowed; Supabase MCP `execute_sql` allowed)
   and the prohibited list `<MCP_PROHIBITIONS>`.
5. **Standing rules** — verbatim from this template, placeholders
   substituted.
6. **Coverage matrix** — table that shows every enum value × every
   role × every integration is hit by a numbered stop.
7. **Pre-flight** — list dependencies (dev server up, DB migrated,
   `<SUPABASE_PROJECT_ID>` accessible). Quote the exact command the
   user runs to verify each. NEVER auto-reset the DB; the tour creates
   scoped data, it doesn't nuke state.
8. **Chapters and stops** — numbered T.1, T.2, … grouped into
   chapters. Format below.
9. **Cleanup chapter** — final chapter that deletes every record
   carrying `<MOCK_SLUG_PREFIX>` and verifies the seed cohort is
   untouched.
10. **Wrap-up** — agent gives a one-screen recap, lists every file the
    tour visited, and offers to file follow-up issues for any bugs
    fixed in flight.

---

## Stop format

Each numbered stop must follow this exact shape (the generator should
template each stop from this skeleton):

```
### T.<N> — <one-line title>

**What we're about to do.** <2-3 sentence narration in plain English.
Talk to the user as if they're a new dev exploring the codebase for
the first time.>

**Why it matters.** <1-2 sentences linking this stop to a real
business or technical concern. Cite the doc / model / route by path.>

**Coverage.** <Which enum value(s), role lens(es), or integration(s)
this stop is responsible for. Reference the Coverage matrix.>

**Drive.** [Two-flavor offer. The agent emits the literal text below.]

> Pick one:
> - `auto` — I'll drive via Chrome DevTools `<TOOL>(<args>)`. Then I'll
>   narrate the snapshot.
> - `manual` — Open `<URL>` in your browser, do <thing>, type `done`
>   when finished.

**Verify.** <Exact Supabase MCP query the agent runs to confirm the
expected DB state. Always include the SQL.>

**Watch for.** <One sentence: what's worth pointing out about the
output (a column the user might miss, a console message, a network
call worth opening).>

---

```

The trailing `---` separates stops visually. After the last stop in a
chapter, insert a chapter-divider line with the chapter's name.

---

## Output contract

The generator MUST emit the tour file at:

```
prompts/tours/<SUBSYSTEM>-grand-tour.md
```

Single file. No companion files. No preamble outside the tour itself.
If the user asks for splits (e.g. one file per chapter), refuse —
tours are designed to be opened once and read top-to-bottom.

The first line of the emitted file MUST be the `# <Title>` heading.
The last line MUST be the wrap-up's closing sentence (no trailing HTML
comments, no agent-self-narration, no AI generation footers).

---

## Self-applied quality gates

Before returning the generated tour, the LLM must check:

- [ ] Every stop offers the two-flavor option (`auto` / `manual`).
- [ ] Every interactive stop names the exact Chrome DevTools or
      Supabase MCP function call (no vague "use the MCP to do X").
- [ ] Every stop has a `Verify.` section with executable SQL.
- [ ] The Coverage matrix lists every enum value × every role × every
      cross-cutting integration the user supplied. No `<VALUE>` is
      both unmarked and unused.
- [ ] The Cleanup chapter has a `DELETE` that targets
      `<MOCK_SLUG_PREFIX>%` and a follow-up `SELECT` that proves the
      delete worked.
- [ ] The verb `evaluate_script` does NOT appear anywhere in the body
      (case-insensitive). If it does, the generator must abort with
      `error: prohibited tool reference at line N`.
- [ ] No stop assumes data created by a later stop. Stops are
      sequentially walkable.
- [ ] Every chapter has at least one stop.
- [ ] No stop body exceeds 80 lines (if it would, split into
      sub-stops T.<N>.a, T.<N>.b).

If any gate fails, the generator must NOT emit the file. Instead it
returns a single line: `error: gate <N> failed — <one-line reason>`
and stops.

---

## Worked example invocation

```
Generate a tour for SUBSYSTEM=onboarding using this template.

Placeholders:
  SUBSYSTEM = onboarding
  SUBSYSTEM_DISPLAY_NAME = "User Onboarding (signup → role pick → profile)"
  KEY_MODELS = [User, ConsulteeProfile, ConsultantProfile, OnboardingState]
  KEY_ROUTES = [/api/auth/signup, /api/auth/onboarding/*, /api/users/me/role]
  KEY_DASHBOARD_PAGES = [/onboarding, /dashboard]
  ROLE_LIST = [CONSULTEE, CONSULTANT, ADMIN, STAFF]
  ENUM_MATRIX = "OnboardingStep × UserRole" — 6×4 grid in the tour body
  CROSS_CUTTING_INTEGRATIONS = [BetterAuth session, Email verification, Stream user upsert, Razorpay customer create, Novu subscriber create]
  MOCK_SLUG_PREFIX = "tour-onboarding-2026-04-25-"
  SUPABASE_PROJECT_ID = pzmbxqdgibfkhjwzeprf
  DEV_SERVER_URL = http://localhost:3000
  MCP_PROHIBITIONS = [evaluate_script]
  READ_FIRST_LINK = prompts/onboarding-algorithm-tests/<shared-setup if present>
```

The generator runs every quality gate, then emits
`prompts/tours/onboarding-grand-tour.md` containing ~30 stops with
the structure prescribed here.

---

## Anti-patterns the generator must avoid

- **Don't** add a `npx prisma db push --force-reset` step anywhere.
  Tours coexist with the user's in-progress dev work.
- **Don't** use `evaluate_script`. The whole point of the tour is to
  drive the app like a real user.
- **Don't** describe enum values in prose without showing the actual
  schema definition. Cite `prisma/schema.prisma:NNN` for every enum.
- **Don't** copy entire files into the tour body. Quote the relevant
  lines and link to the source path.
- **Don't** generate API tests inside the tour. If the user wants
  exhaustive 4xx coverage, point them at the test suite under
  `prompts/<SUBSYSTEM>-tests/`.
- **Don't** assume the user knows the prior conversation. Each stop
  must be readable cold.
- **Don't** add commentary about the generation process. The tour is
  a final artifact, not a meta-document.

---

## Versioning

The generated tour file's first commit message must be:
`docs(tours): add <SUBSYSTEM> grand tour (template v1)`

If the template itself changes in a way that affects the generated
shape (e.g. a new mandatory rule), bump the version in the commit
message: `template v2`, etc. The user can grep
`prompts/tours/*.md` for `template v` to know which tours need
regeneration.
