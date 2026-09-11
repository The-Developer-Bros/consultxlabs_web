# Next.js on Netlify: what only breaks on the deployed build

Each item is a verified failure from a production-grade money subsystem (Next 15, Prisma 7, Supabase, Netlify, React 18 userland with Next's vendored React 19 canary), with the fix that held.

## 1. `@react-pdf/renderer` throws React error #31 only on Netlify

**Symptom:** `Minified React error #31 … object with keys {$$typeof, type, key, ref, props}` from `renderToBuffer`, while Jest and local dev pass.
**Cause:** `@react-pdf/renderer` is in Next's BUILT-IN `serverExternalPackages` list, so the function `require`s it (and `@react-pdf/reconciler`) through Node's resolver. The reconciler picks its React reconciler by `React.version` → userland React (18). App Router route code compiles in the `rsc` layer against Next's vendored React (19 canary) whose `jsx-runtime` emits `react.transitional.element`. Two Reacts meet at the reconciler; it rejects the elements.
**Fix that held:** compile the PDF components against the SAME React the reconciler loads. Add `lib/pdf/react-runtime/{jsx-runtime,jsx-dev-runtime,node-require}.ts` where `nodeRequire = typeof __non_webpack_require__ === "function" ? __non_webpack_require__ : module.require.bind(module)` and the runtime files re-export `jsx/jsxs/jsxDEV/Fragment` from `nodeRequire("react/jsx-runtime")`; put `/** @jsxImportSource @/lib/pdf/react-runtime */` at the top of each PDF component file. Pin with a test that both sides resolve to one React. Adding more packages to `serverExternalPackages` is a no-op (already external); `transpilePackages` hands the reconciler the `react-server` build (worse); an npm `overrides` pin silently left a hoisted duplicate.
**Also:** name `react` (and any font dir the renderer reads at runtime) in `outputFileTracingIncludes` for each PDF route — the tracer cannot see a `require` that goes through `nodeRequire`.

## 2. `PG_POOL_MAX=1` deadlocks any global-client read inside `$transaction`

With one connection per function instance, a `prisma.x.find…` on the GLOBAL client while a `prisma.$transaction` holds the connection waits forever and surfaces as `timeout exceeded when trying to connect`. Only a deploy preview reveals it (local pools are 10). Rule: everything inside a transaction reads through `tx`; helpers take `db: Tx | typeof prisma = prisma`. Work that must run after commit (notifications, side effects) runs post-commit, and any `.catch` that writes a system event must run OUTSIDE the transaction.

## 3. `after()` is best-effort; a sweep is the truth

Phase-2 work inside `after()` (earnings, channel creation, notifications) shares the instance and the single connection with the next request; it can be starved or dropped. Bound it (5 s deadlines, SDK `timeoutMs`), never put money truth there, and keep an idempotent sweep (cron/ticker) that heals what `after()` missed.

## 4. Netlify facts

- Scheduled functions run only on the PUBLISHED deploy, never on previews; env changes need a redeploy; `CONTEXT` is not visible at function runtime (use an explicit env flag per context).
- Deploy previews are the right place for logged-in money E2E (local `next dev` can exhaust RAM); commit STATUS (not check-runs) carries the preview state: `gh api repos/O/R/commits/<sha>/status`.
- Function logs: `netlify logs --since …` with the DEPLOY PERMALINK, not the preview URL.
- A new instance's first ~25 s can stall the event loop; a 30 s hard ceiling means any lock retry budget must fit under ~26 s.

## 5. CodeRabbit mechanics (1 review/hour org-wide)

Every push or `@coderabbitai review` competes for the slot; retry a throttled trigger every ~15 min. A review with 0 actionable comments posts NO review object — it rewrites its walkthrough comment in place ("Currently processing…" → "Actionable comments posted: N") and edits the trigger ack from "Review triggered" to "Review finished". The ack text contains "already reviewed commits", so never grep new comments for finished-phrases; detect landing via new inline comments, a bot review object, or the walkthrough/ack updated after the trigger without "Currently processing". Bot login is `coderabbitai[bot]`.

## 6. Strict branch protection turns a PR train into a chain

With "require branches to be up to date", every merge makes the others BEHIND. Merge serially: `gh pr update-branch <n>` (API merge commit, no worktree), wait for CI, squash-merge, next. Combine each PR's triage fixes and its dev merge into ONE push to save review slots.

## 7. Orchestration hygiene that saved the campaign

Executors on cheaper models than the orchestrator (Opus high for money code, Sonnet for E2E/docs/mechanical); one worktree per PR under a sibling path with `node_modules`/`.env` symlinked; every long agent prompt carries "if you approach a session limit: commit what is consistent, push, report"; resume dead agents from their worktree; keep a resume queue (plan file §) updated after every event; monitors emit one terminal line.
