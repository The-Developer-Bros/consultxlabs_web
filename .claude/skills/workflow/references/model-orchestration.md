---
name: model-orchestration
description: Choose which Claude tier runs which part of a large multi-agent effort — the advisor/teacher/student split, per-role effort levels, session-budget economics, and the resume-from-worktree pattern for surviving usage limits. Load when planning any fleet of subagents, when a session keeps hitting usage walls, or when deciding between Fable/Opus/Sonnet/Haiku for a task.
---

# Model orchestration: advisor, teacher, student

One model tier does not fit a whole engineering campaign. The teams that keep
both quality and cost sane split the work by the kind of thinking it needs,
not by who happened to start the session. This skill encodes the split that
shipped the #1169 booking/maintenance train (10 PRs, 9 issues, one night) and
the failure modes it hit on the way.

## The three roles

**Advisor (Mythos-class: Fable).** Owns judgment, not keystrokes. Audit
synthesis across dozens of sources; architecture and doctrine decisions
(lock-namespace design, refund front-door rules); money-path code review;
adversarial verification of other agents' claims; anything where a wrong call
loses money or ships a subtle race. The advisor writes SPECS so complete that
a cheaper model can execute them without judgment calls — that spec-writing is
the highest-leverage thing the advisor does. Fable costs ~2× Opus per token
($10/$50 vs $5/$25 per M), so every Fable-token spent re-reading files an
executor could read is waste.

**Teacher (Opus).** Executes complex, well-specified work and TEACHES the
codebase back: builds a whole PR from a numbered spec, runs review-comment
triage where each claim must be verified against current code, writes tests
that pin semantics. Opus is Anthropic's own recommended tier for complex
agentic coding; reserve the advisor for the frontier slice above it.

**Student (Sonnet, Haiku for the smallest jobs).** Mechanical breadth:
regenerate a reference doc from 61 workflow files, sweep unused imports,
enumerate a fleet, apply a rename, format tables. Sonnet at $2/$10 (rising to
$3/$15) does this reliably; Haiku ($1/$5) handles classification/routing.

Escalate on evidence, not vibes: when a student/teacher report contains a
claim that contradicts the spec, the ADVISOR re-verifies it personally before
acting (this train caught several — a "stale twins" premise that was actually
wrapper→core, a reviewer claim disproven at line level).

## Effort levels per role

Effort (`low | medium | high | xhigh | max`) is a second, independent lever —
often bigger than the model choice. Frontmatter `effort:` on a subagent
overrides the session level downward or upward while that agent runs.

| Role | Model | Effort | Why |
|---|---|---|---|
| Advisor session (audit/design day) | fable | max | Long-horizon synthesis; the one place max earns its tokens |
| Advisor session (orchestration day) | fable | high | Dispatch + spot-checks don't need max |
| Teacher: build a PR from spec | opus | high | Multi-file coherence, test writing |
| Teacher: triage review comments | opus | high | Claim-vs-code verification needs care |
| Student: doc regen / enumeration | sonnet | medium | Breadth over depth |
| Student: rename / lint sweep | sonnet or haiku | low | Mechanical |

Choose the lowest effort that passes your checks; it is the biggest cost lever
you control.

## Mechanics in this repo

Subagent definitions live in `.claude/agents/*.md`; frontmatter carries the
contract:

```yaml
---
name: pr-builder            # placeholder — name your executor
description: Build one PR from a numbered spec produced by the orchestrator.
model: opus                 # sonnet | opus | haiku | full id | inherit
effort: high                # low | medium | high | xhigh | max
---
```

Ad-hoc dispatch (no definition file): the Agent tool accepts a `model`
override per launch. Forks are the exception — a fork always inherits the
parent model, so an advisor cannot fork itself into a cheaper executor; use a
fresh agent with the spec inline. Workflow scripts take per-call
`{model, effort}` on `agent()`.

## Session-budget economics (the lesson that cost four fleets)

Every subagent draws on the SAME session usage pool, weighted by its model's
cost. A Fable orchestrator that launches six Fable executors in parallel
multiplies its own burn rate ~7× and hits the wall mid-write — this train lost
four full fleets that way, each dying AFTER the expensive read phase and
BEFORE the cheap write phase. Rules that fixed it:

1. **Executors run on cheaper tiers than the orchestrator.** That is the
   whole point of the split.
2. **Serialize when the pool is uncertain.** Two agents that finish beat six
   that die at 80%.
3. **Every long-running agent prompt carries a limit clause**: "if you
   approach a session limit — commit what is consistent, push, open the PR
   marking unfinished items, report." An agent that dies silently strands its
   work in a dirty worktree.
4. **Resume, never restart.** A dead agent's worktree keeps its uncommitted
   edits. The relaunch prompt says: cd into `<worktree path>`, `git status` +
   `git diff`, keep coherent edits, finish incoherent ones — and carries the
   dead agent's last progress note. This converts a lost fleet into a cheap
   completion pass instead of a full re-read.
5. **The orchestrator persists a RESUME QUEUE** (plan file or issue) after
   every fleet event: worktree path, branch, last note, remaining items. Any
   future session — any model — can pick up from it.

## Placeholders to fill for your team

- [ ] `ADVISOR_MODEL`: (default fable) — who owns judgment and money paths
- [ ] `TEACHER_MODEL`: (default opus) — who builds and triages
- [ ] `STUDENT_MODEL`: (default sonnet) — who sweeps and regenerates
- [ ] `SESSION_EFFORT_DEFAULT`: (suggest high; max only for audit/design days)
- [ ] `PARALLEL_EXECUTOR_CAP`: (suggest 2–3 until you've measured your pool)
- [ ] `LIMIT_CLAUSE`: the commit-early sentence pasted into every agent prompt
- [ ] Escalation rule: which findings force advisor re-verification (suggest:
      anything touching payments, locks, auth, or data deletion)

## Worked example: the #1169 train (2026-08-13/14)

Advisor (Fable, max→high): five-lens audit, umbrella #1169 + 8 sub-issues,
lock/freeze/refund doctrine design, PRs #1170/#1172/#1173/#1174/#1176 built
personally because they rewrite money paths; spot-verified four P0 claims
line-by-line before building on them. Teacher (initially Fable — the mistake;
then Opus): PR #1175 org-scoping, PR #1177 lifecycle UI, both triage rounds
(11 threads resolved, 2 reviewer claims disproven, 3 contestable items
correctly left for the human). Student work identified for Sonnet: the 61-row
cron reference regen inside PR 6. Four fleets died to the shared-pool mistake
before the split was enforced; the resume-from-worktree pattern recovered all
of them without re-reading.

Sources: [model config + effort](https://code.claude.com/docs/en/model-config),
[subagent frontmatter](https://code.claude.com/docs/en/sub-agents),
[Fable 5 / Mythos 5 announcement](https://www.anthropic.com/news/claude-fable-5-mythos-5),
[current tier pricing](https://claudefa.st/blog/models).
