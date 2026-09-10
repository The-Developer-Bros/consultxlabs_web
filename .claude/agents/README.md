# Subagents in this repo

`.claude/agents/` is flat — Claude Code does not support nesting agent definitions the way project skills nest under a domain folder. This page is the index: the tier table an orchestrator uses to pick a model and effort level, the role agents that carry those tiers, the Razorpay vendor pack, and the dispatch rule that ties them together.

## The tier table

The full rationale — session-budget economics, the resume-from-worktree pattern, and the worked example that motivated the split — lives in `.claude/skills/workflow/references/model-orchestration.md`. The summary:

| Role                                            | Model                                  | Effort                                                      | Why                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | -------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Advisor (judgment, not keystrokes)              | Fable                                  | max (audit/design day) or high (orchestration day)          | Owns architecture and doctrine decisions, money-path review, adversarial verification of other agents' claims. Costs roughly 2× Opus per token, so it should write specs an executor can run without judgment calls rather than execute breadth work itself. |
| Teacher (executes complex, well-specified work) | Opus                                   | high (build a PR) or medium (triage)                        | Multi-file coherence in money code, and claim-vs-code verification on review threads.                                                                                                                                                                        |
| Student (mechanical breadth)                    | Sonnet, or Haiku for the smallest jobs | medium (doc regen, enumeration) or low (rename, lint sweep) | Regenerates a reference doc, sweeps unused imports, applies an already-decided change across many files.                                                                                                                                                     |

## The role agents

| Agent           | Model  | Effort | Role                                                                                                                                                                                        |
| --------------- | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pr-builder.md` | opus   | high   | Builds or resumes one PR from a numbered spec inside a dedicated worktree. The multi-file-coherence executor for money code.                                                                |
| `pr-triager.md` | opus   | medium | Review-comment triage on a non-money PR (docs, cron plumbing, UI, config), checking each claim against current code. Money-semantics threads are reported as needs-decision, never changed. |
| `sweeper.md`    | sonnet | medium | Mechanical breadth work with some judgment — E2E scenarios, docs regeneration, cron plumbing, a small Netlify function.                                                                     |
| `mechanic.md`   | sonnet | low    | Purely mechanical breadth work — relabels, formatting, YAML sweeps, rename/lint passes, doc regeneration from an already-written verdict.                                                   |

## The `razorpay-*` pack

Nine vendor-specific agents scaffold and audit the Razorpay integration directly: `razorpay-setup`, `razorpay-one-time-payment`, `razorpay-subscription`, `razorpay-webhook`, `razorpay-test-webhook`, `razorpay-invoice`, `razorpay-db-schema`, `razorpay-diagnostics`, and `razorpay-code-audit`. They are narrower and more mechanical than the role agents above, are scoped to Razorpay integration code specifically, and are documented in full at `.claude/skills/finance/references/razorpay/README.md`.

## Dispatch rule

Money code goes to `pr-builder` at opus/high. Money review triage also goes to `pr-builder`, because verifying a reviewer's claim against money-path code needs the same multi-file coherence as building the code did. Non-money triage goes to `pr-triager`. E2E and docs work goes to `sweeper`. Purely mechanical work goes to `mechanic`.
