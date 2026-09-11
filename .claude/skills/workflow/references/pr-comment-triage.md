---
name: pr-comment-triage
description: Triage every review comment on a pull request into legit / BS / already-fixed / partly-fixed / incorrectly-fixed by checking each claim against the CURRENT code, then plan and apply fixes for the legit-pending ones, validate them against a running dev server with MOCK data (never the shared/real DB), pause for the user to review, and on approval commit, push, and resolve the bot review threads (without replying) in a background agent. Use when the user says "triage the PR comments", "are these review comments legit", "go through the PR feedback", "address the Gemini/CodeRabbit comments", or "fix the actionable review comments on PR #N".
argument-hint: "[PR number — defaults to the PR for the current branch]"
---

# PR Comment Triage → Fix → Validate → Resolve

Turn a pile of automated/human PR review comments into a clean, verified result. The flow has a hard **pause for user approval** before anything is committed or pushed, and resolves bot threads **without replying**.

Resolve the target PR number from `$ARGUMENTS`; if empty, use the PR for the current branch (`gh pr view --json number`).

---

## Guardrails (read first)

- **Never invent a comment's verdict.** Classify each comment only after opening the CURRENT code at the file/line it references — line numbers in old comments drift, so locate by surrounding code, not the stale line number.
- **Mock data only.** Validation runs against the project's test harness (jest + mocked Prisma) and/or the dev `mock-webhook` route. Do **not** create real payments/refunds/orgs in a shared or remote database. Many of this repo's money paths are internal (cascades, ledger postings, crons) and aren't cleanly HTTP-callable — the faithful before/after is the real function under a mocked Prisma `$transaction`, which is what the route would call anyway.
- **Pause before push.** After fixes are applied and validated, STOP and present the diff + the before/after evidence. Do not commit or push until the user explicitly approves.
- **Resolve, don't reply.** Bot threads (Gemini Code Assist, CodeRabbit) get _resolved_ via GraphQL, with no reply comment, and only after the work is merged/pushed. Do this in a background agent.

---

## Step 1 — Fetch every comment

Pull all three comment surfaces (they're distinct on GitHub):

```bash
PR=<number>; REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
# inline (file/line) review comments — the actionable ones
gh api "repos/$REPO/pulls/$PR/comments" -q '.[] | "FILE \(.path):\(.line // .original_line)\nID \(.id)\n\(.body)\n---"'
# review summaries (one per reviewer)
gh pr view $PR --json reviews -q '.reviews[] | "[\(.author.login)/\(.state)] \(.body)"'
# issue-level comments (often the bot "review skipped"/summary boilerplate)
gh pr view $PR --json comments -q '.comments[] | "[\(.author.login)] \(.body)"'
```

Note the reviewers. In this repo, **CodeRabbit auto-skips** PRs whose base is not the default branch (its comment is boilerplate — ignore), and **Gemini Code Assist** leaves the inline comments worth triaging.

## Step 2 — Classify each comment

For every inline comment, open the referenced code as it is NOW and assign exactly one verdict:

| Verdict               | Meaning                                     | How to decide                                                                                                      |
| --------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **legit-pending**     | A real issue, not yet addressed             | The code still has the problem the comment describes                                                               |
| **BS**                | Wrong, irrelevant, or boilerplate           | The claim is false, or it's a bot "skipped/sunset" notice, or it contradicts a deliberate design (cite the design) |
| **already-fixed**     | Real, but the current diff already fixes it | The branch's code no longer has the issue (the comment predates the fix)                                           |
| **partly-fixed**      | Addressed in part                           | Some of the comment's points are handled, others remain — list which                                               |
| **incorrectly-fixed** | An attempt exists but is wrong              | A change was made that doesn't actually resolve it or introduces a new bug                                         |

Watch for the trap where two bots give **contradictory** suggestions (e.g. anchor-slug fixes) — when that happens, sidestep the ambiguity with a robust third option rather than picking one.

Output a triage table: `#`, file:line, reviewer, one-line summary, **verdict**, and a one-line justification grounded in the current code.

## Step 3 — Plan the fixes

List only **legit-pending** and **incorrectly-fixed** items. For each: the exact file:line, the concrete fix (approach, not just "fix it"), and whether it's a code change or a test/doc change. Keep BS / already-fixed / partly-fixed items in the table with their justification so the user can see they were considered, not skipped. Present the plan and proceed.

If a "fix" touches money/ledger/compliance and the correct behaviour is genuinely ambiguous (e.g. an accounting reclassification, a TDS figure), **do not guess** — mark it as needs-decision and surface it to the user instead of shipping an unverified change.

## Step 4 — Apply the fixes

Make the edits. Reuse existing helpers/patterns; match the surrounding code's style. Re-run `npx tsc --noEmit`, `npx eslint <changed files>`, and the relevant test suites as you go. Remember the build trap: `next build` treats ESLint errors as blocking even though the lint CI job is `continue-on-error`, so a `no-fallthrough` / `no-conditional-expect` will fail the build — lint the changed files explicitly.

## Step 5 — Validate against a running server with MOCK data

1. Start the dev server in the background: `npm run dev` (it boots against the configured DB; only use it for routes that are safe to call).
2. For each fix, produce **before/after** evidence using the real function the API/route calls, under a mocked Prisma `$transaction` (mirror `__tests__/enterprise/*` mock patterns) — capture the wrong result on the old code path and the correct result after. This is the faithful "before/after" for internal money paths without touching shared data.
3. Where a route is genuinely safe + HTTP-exercisable, hit it (e.g. `app/api/dev/mock-webhook` for a disposable record). Never seed real payments/refunds into a shared DB.
4. Run the full affected suites green; if any change touches the ledger, run the invariant/property tests.

## Step 6 — PAUSE for the user

Stop. Present: the triage table, what was fixed, the before/after evidence, anything deferred/needs-decision, and the verification status (tsc / eslint / tests / build). **Do not commit or push.** Wait for explicit approval.

## Step 7 — Commit & push (after approval)

Commit with a clear message linking the PR/issue (`Part of #N`, not `Closes` unless it truly closes it), then push to the PR's branch. Keep this skill's own files out of an unrelated fix commit.

## Step 8 — Resolve the bot threads (background agent, no replies)

Once pushed, resolve every addressed thread **without posting a reply**, in a background agent. Use GraphQL with a variable (string interpolation of the node id malforms the query) and throttle to avoid the secondary-mutation rate limit:

```bash
# list unresolved thread ids
gh api graphql -f query='query($pr: Int!){ repository(owner:"OWNER", name:"REPO"){ pullRequest(number: $pr){
  reviewThreads(first: 100){ nodes { id isResolved } } } } }' -F pr="$PR" \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false) | .id'
# resolve each (variable form, ~1s apart)
gh api graphql -f query='mutation($id: ID!){ resolveReviewThread(input:{threadId:$id}){ thread { isResolved } } }' -F id="$THREAD_ID"
```

Only resolve threads whose comment was actually handled (legit-fixed, already-fixed, or BS-with-justification). Leave anything deferred/needs-decision unresolved so it stays visible. Do **not** add reply comments — resolution is the signal.

---

## One-shot driver (optional)

When the user wants the whole flow run end-to-end on a PR, execute Steps 1→6 autonomously, pause at Step 6, and only run Steps 7→8 after approval. Track progress with the task tools so the user can see each phase.
