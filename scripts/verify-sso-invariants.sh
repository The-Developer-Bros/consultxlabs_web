#!/usr/bin/env bash
#
# verify-sso-invariants.sh
#
# Fails the build if any of the six regressions fixed in PR #655 (issue #672)
# re-appear. Cheap, static, runs in under a second — intended to live on every
# PR as a tripwire without needing a database, Docker, or a real IdP.
#
# Each check has two parts:
#   WHAT: the pattern we forbid / require.
#   WHY:  the incident or footgun it prevents. If you're here because this
#         script failed, read the WHY before "fixing" the invariant away.
#
# To run locally: `bash scripts/verify-sso-invariants.sh`
# In CI:          see `.github/workflows/ci.yaml` → "Verify SSO invariants".

set -u
# Run from repo root regardless of invocation directory.
cd "$(dirname "$0")/.."

status=0
fail() {
  status=1
  echo "  ❌ $1"
  if [ -n "${2-}" ]; then
    echo "     Why: $2"
  fi
  if [ -n "${3-}" ]; then
    echo "     Offending match:"
    printf '%s\n' "$3" | sed 's/^/       /'
  fi
  echo
}
pass() {
  echo "  ✅ $1"
}

echo "=== SSO invariants check ==="
echo

# ---------------------------------------------------------------------------
# Check 1: No raw fetch() to /api/auth/sign-in/sso from the signin/signup
#          pages. This would bypass the ssoClient plugin and skip OIDC PKCE,
#          re-introducing the silent OIDC failure that commit b75fc96d caused.
# ---------------------------------------------------------------------------
raw_fetch=$(grep -rn --include='*.ts' --include='*.tsx' \
  -E "fetch\(['\"\`]/api/auth/sign-in/sso" app/ 2>/dev/null || true)
if [ -n "$raw_fetch" ]; then
  fail "Raw fetch to /api/auth/sign-in/sso" \
    "Skips OIDC PKCE → Auth0 / Okta OIDC / Azure AD OIDC flows fail. Use authClient.signIn.sso() instead." \
    "$raw_fetch"
else
  pass "No raw fetch to /api/auth/sign-in/sso — PKCE path preserved"
fi

# ---------------------------------------------------------------------------
# Check 2: lib/auth-client.ts must register the ssoClient plugin. Without
#          it, authClient.signIn.sso() doesn't exist and the signin flow
#          falls through to raw fetch.
# ---------------------------------------------------------------------------
if ! grep -q "ssoClient()" lib/auth-client.ts 2>/dev/null; then
  fail "ssoClient plugin missing from lib/auth-client.ts" \
    "signIn.sso() is a ssoClient-plugin method. Not registering it means PKCE can't be generated client-side." \
    "$(grep -n 'plugins:' lib/auth-client.ts || echo '(file not found)')"
else
  pass "ssoClient() registered in lib/auth-client.ts"
fi

# ---------------------------------------------------------------------------
# Check 3: samlConfigSchema must not accept a `callbackUrl` field. BetterAuth
#          honours it and overrides the derived ACS; any drift from the
#          derived value silently breaks SAML assertion delivery.
# ---------------------------------------------------------------------------
# Match Zod property declarations (`callbackUrl: z.`) and strip out comment
# lines (starting with `*`, `//`, or `#`) so the docstring referencing the
# field doesn't trip the check.
callback_match=$(grep -nE "^[[:space:]]*callbackUrl\s*:" lib/sso/provider-schemas.ts 2>/dev/null || true)
if [ -n "$callback_match" ]; then
  fail "callbackUrl re-added as a property in lib/sso/provider-schemas.ts" \
    "BetterAuth honours callbackUrl and overrides the derived ACS URL. If the user-typed value drifts (trailing slash, http vs https) SAML breaks silently." \
    "$callback_match"
else
  pass "samlConfigSchema does not accept callbackUrl"
fi

# ---------------------------------------------------------------------------
# Check 4: POST /sso/providers must not set userId to the creating owner.
#          ssoProvider.userId FK has onDelete: Cascade — binding an org-scoped
#          provider to the owner cascades the delete if the owner ever leaves
#          the org, silently killing SSO for the whole team.
# ---------------------------------------------------------------------------
owner_userid=$(grep -nE "userId:\s*access\.session\.user\.id" \
  "app/api/organizations/[orgId]/sso/providers/route.ts" 2>/dev/null || true)
if [ -n "$owner_userid" ]; then
  fail "ssoProvider.userId is being set to the creating owner" \
    "FK cascade will kill the entire org's SSO when the owner is deleted. Leave userId null for org-scoped providers." \
    "$owner_userid"
else
  pass "ssoProvider.userId stays null on org-scoped provider creation"
fi

# ---------------------------------------------------------------------------
# Check 5: customSession enforceSSO check must NOT use the blanket
#          `providerId: { not: "credential" }` test. That matches personal
#          Google / GitHub OAuth and lets the user bypass enforcement. The
#          precise check matches against the org's registered
#          ssoProvider.providerId list.
# ---------------------------------------------------------------------------
bad_enforce=$(grep -nE 'providerId:\s*\{\s*not:\s*"credential"' lib/auth.ts 2>/dev/null || true)
if [ -n "$bad_enforce" ]; then
  fail "Blanket 'providerId != credential' check in customSession" \
    "Personal Google/GitHub OAuth would satisfy this check and bypass enforceSSO. Use { providerId: { in: registeredProviderIds } }." \
    "$bad_enforce"
else
  pass "customSession enforceSSO uses precise ssoProvider.providerId match"
fi

# ---------------------------------------------------------------------------
# Check 6: No "coming soon" strings on the SSO settings page. OIDC is fully
#          supported; a stale subtitle would mislead the IT admin into
#          thinking OIDC configs will be ignored.
# ---------------------------------------------------------------------------
page="app/dashboard/organization/[orgId]/settings/sso/page.tsx"
stale=$(grep -nEi "oidc[^a-z]*coming soon|coming soon[^a-z]*oidc" "$page" 2>/dev/null || true)
if [ -n "$stale" ]; then
  fail "\"OIDC coming soon\" label on the SSO settings page" \
    "OIDC support has been implemented — labelling it 'coming soon' misleads admins." \
    "$stale"
else
  pass "No stale 'coming soon' strings on the SSO settings page"
fi

# ---------------------------------------------------------------------------
# Check 7: Server-side SSO veto must be present — the databaseHooks.session
#          .create.before hook is what makes enforceSSO non-bypassable by
#          direct POSTs to BetterAuth's credential endpoints. Without it,
#          the enforcement collapses back to UI + reactive session flag,
#          which motivated users can step around with curl. See issue #673.
# ---------------------------------------------------------------------------
if ! grep -q "shouldRejectSession" lib/auth.ts 2>/dev/null; then
  fail "shouldRejectSession not referenced in lib/auth.ts" \
    "The session.create.before hook is the single server-side chokepoint that closes issue #673. If you removed it, the enforceSSO policy is only enforced by the UI again." \
    "$(grep -n 'session:' lib/auth.ts | head -5 || echo '(no session hook found)')"
else
  pass "session.create.before hook wired via shouldRejectSession"
fi

# ---------------------------------------------------------------------------
# Check 8: BetterAuth versions must stay aligned between better-auth and
#          @better-auth/sso. Drift can cause subtle plugin-API mismatches.
# ---------------------------------------------------------------------------
ba=$(node -e "console.log(require('./package.json').dependencies['better-auth'])" 2>/dev/null || echo "")
sso=$(node -e "console.log(require('./package.json').dependencies['@better-auth/sso'])" 2>/dev/null || echo "")
if [ -z "$ba" ] || [ -z "$sso" ]; then
  fail "Cannot read better-auth / @better-auth/sso versions" \
    "Both packages must be declared in package.json dependencies." ""
elif [ "$ba" != "$sso" ]; then
  fail "better-auth ($ba) and @better-auth/sso ($sso) versions don't match" \
    "Plugin and core must move together — mismatched versions cause runtime type errors in the SSO handler." \
    "better-auth=$ba  @better-auth/sso=$sso"
else
  pass "better-auth and @better-auth/sso versions match ($ba)"
fi

echo
if [ $status -eq 0 ]; then
  echo "All SSO invariants hold."
else
  echo "SSO invariants failed — read the Why lines above before changing the invariant itself."
fi
exit $status
