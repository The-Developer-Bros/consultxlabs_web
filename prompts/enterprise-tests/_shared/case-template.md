# Case template

> Every feature-folder case file follows this skeleton. Cite this file
> by section anchor — don't copy-paste the rules block into each case.
> Pair with [`shared-setup.md`](./shared-setup.md) and
> [`mcp-recipes.md`](./mcp-recipes.md).

---

## Skeleton

```markdown
# <Folder> — <Concern>

> Cite [`_shared/shared-setup.md`](../_shared/shared-setup.md) for the
> seed cohort, mock-data strategy, and Round-3 invariants.
> Cite [`_shared/mcp-recipes.md`](../_shared/mcp-recipes.md) for the
> Supabase + Chrome DevTools idioms.
> Apply [`_shared/case-template.md#fix-and-retest-gate`](../_shared/case-template.md#fix-and-retest-gate)
> when a case fails.

**Surface(s) under test:**
- `<file:line-range>` — what it does
- `<file:line-range>` — etc.

**Invariant(s) tested (see shared-setup §4):**
- <one-liner from the Round-3 invariants table, if applicable>

---

## Case <ID>: <one-line scope>

### Preconditions
<Supabase MCP SELECTs that confirm the starting state, OR an INSERT
sequence that seeds a fresh test org. Cite the seed cohort by slug.>

### Steps
1. <Chrome DevTools MCP step OR Supabase MCP write>
2. <…>
3. <take_snapshot at boundary>

### Assertions
- **DB** — <Supabase SELECT, expected shape>
- **Audit log** — <expected `OrgAuditLog` row(s)>
- **Ledger** — <expected `Usage / Funding / Settlement` row(s), if any>
- **Console** — `list_console_messages()` produces no Prisma / hydration / audit-emit errors
- **Network** — `list_network_requests()` shows no unexpected 4xx / 5xx
- **UI** — <visible-text or state, captured via take_snapshot>

### Cleanup (only if the case spawned a fresh org)
<DELETE FROM ... WHERE slug LIKE 'test-2026-%' ...>

### Done when
- [ ] All assertions pass
- [ ] No console / network surprises
- [ ] (if cleanup) Fresh-org rows removed

---

## Case <ID+1>: <…>

(same shape)

```

---

## Fix-and-retest gate

When a case fails, classify the fix **before** applying it.

### Trivial fix (auto-apply, then retest)
- ≤5 lines of changed code
- Restricted to: UI labels, prop wiring, error-copy strings, dead-code
  removal, comment tweaks, missing null-check that doesn't change
  branching, missing `await`, typo
- **No** schema, migration, cron schedule, payment gateway, auth,
  compliance helper, or money-math edits
- **No** new DB query, no new index, no N+1 risk introduced

→ Apply the fix, retest the failing case from the closest stable
navigation point (usually the start of the case's Steps section),
confirm green before continuing. No backlog.

### Non-trivial fix (STOP and ASK)
- More than 5 lines changed
- Touches any of:
  - `prisma/schema.prisma`, `prisma/migrations/`
  - `.github/workflows/`
  - `jobs/**`, `scripts/**`
  - `lib/payments/**`, `lib/compliance/**`
  - `lib/auth.ts`, `app/api/auth/**`, `middleware.ts`
  - anything under `lib/api/organizations/`
- Adds or removes a Prisma model, column, index, or `@@unique`
- Changes a cron schedule, idempotency key, or webhook handler
- Touches money math (paise arithmetic, BPS, currency conversion)
- Touches India compliance (TDS, GST, MSME, IRP, DPDP)
- Affects auth or session shape

→ STOP. Output a one-paragraph diagnosis with `file:line-range` for the
proposed change. **Pause and ASK** before applying. After approval,
apply + retest from the start of the case.

### Never
- Accumulate a "fix later" backlog. Decide each bug in the moment.
- Comment out failing assertions to "move on." Either fix or escalate.
- Mark a case green when an assertion silently passed because a row
  doesn't exist (e.g. `COUNT(*) = 0` when 0 also matches "didn't write").
  Assert positively whenever possible.

---

## Authoring guidance

- **Length:** 200-600 lines per file. Bigger files split by sub-concern.
- **Cases per file:** 3-8. More than 8 → likely two concerns; split.
- **Step granularity:** one MCP call per numbered step. Don't fuse a
  Chrome click and a Supabase SELECT into one step.
- **Surface citations:** every case names the `file:line-range` it
  exercises. If the case finds a bug, the `file:line-range` in the
  fix proposal must match (or include) what the case cites.
- **Negative tests:** every file should have at least one 4xx / guard
  path case. UI-only files exercise the user-visible guard (button
  disabled / toast surfaced); API-only files exercise the wire-level
  status code + error body.
- **Idempotency:** any case that writes state must be safe to re-run.
  Either spawn a fresh org or assert "exists OR matches" rather than
  "newly created."
- **Time:** never `setTimeout` / `sleep` to wait for a webhook. Use
  bounded polling (`mcp__chrome-devtools__wait_for`) against a UI
  state, or run the cron synchronously and assert its output.

---

## File header (paste-in template)

```markdown
# <Folder name> — <Concern>

> **Required reading:** [`_shared/shared-setup.md`](../_shared/shared-setup.md),
> [`_shared/mcp-recipes.md`](../_shared/mcp-recipes.md),
> [`_shared/case-template.md`](../_shared/case-template.md).
> Apply the **fix-and-retest gate** when any case fails.

**Surface(s) under test:**
- `<file:line>` — <role>
- …

**Round-3 invariant(s) — see shared-setup §4:**
- <name> — <invariant phrasing>

**Case roster:**
1. <ID> — <case scope>
2. <ID> — <…>

---
```
