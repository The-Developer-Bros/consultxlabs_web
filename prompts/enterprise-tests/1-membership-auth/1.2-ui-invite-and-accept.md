# 1-membership-auth — UI: invite + accept + RBAC chrome

> **Required reading:** [`_shared/shared-setup.md`](../_shared/shared-setup.md),
> [`_shared/mcp-recipes.md`](../_shared/mcp-recipes.md),
> [`_shared/case-template.md`](../_shared/case-template.md).
> Apply the **fix-and-retest gate** when any case fails.

**Surface(s) under test:**
- `app/dashboard/organization/[orgId]/members/page.tsx` — invite form + members table
- Accept-invitation flow (link in email; resolves at `/organizations/invitations/accept?token=...`)
- LEARNER chrome (sidebar hides admin entries; direct-URL navigation 403s)

**Case roster:**
1. **UI.M.1** — OWNER opens members page, invites LEARNER
2. **UI.M.2** — Two-tab accept: invitee accepts in second browser context
3. **UI.M.3** — Member appears in the table with role + status pill
4. **UI.M.4** — Role change via dropdown (OWNER promotes LEARNER → MANAGER)
5. **UI.M.5** — Member removal (OWNER → 200; LEARNER kebab is absent)
6. **UI.M.6** — LEARNER role: sidebar lacks Billing, Contracts, Programs entries
7. **UI.M.7** — LEARNER direct-URL to /billing → 403 page

---

## Common preconditions

Wipro from seed. Login as `founder@wipro.test` for OWNER cases.

For two-tab cases, use `mcp__chrome-devtools__new_page` to spawn a
second browser context (the invitee).

---

## Case UI.M.1: OWNER invites LEARNER via UI

1. `navigate_page("http://localhost:3000/dashboard/organization/<wipro-id>/members")`
2. `take_snapshot()` — find "Invite member" button
3. Click invite button → modal appears
4. `fill_form` email + role dropdown → "LEARNER"
5. Click "Send invitation"
6. `wait_for({ text: "Invitation sent" })` or check for the new row in the pending invitations list

### Assertions
- Invitation row in DB (matches case R.1 in API file).
- Pending invitations table on UI shows the new row.

---

## Case UI.M.2: Two-tab accept

1. Pull the invitation token from the DB (or from the invite-email log
   if Resend is mocked).
2. In a second tab via `new_page`, navigate to the accept URL.
3. Sign up (or log in) as the invitee email.
4. Click "Accept invitation."
5. `wait_for({ text: "Welcome" })` or org dashboard chrome.

### Assertions
- Membership row created (matches R.2).
- Tab 1 (OWNER) refreshes the members table → invitee appears.

---

## Case UI.M.3: New member in table

`take_snapshot` the members table. The new LEARNER row shows email,
"LEARNER" pill, "ACTIVE" status, action kebab (visible because viewer is
OWNER).

---

## Case UI.M.4: Role change

Click the kebab on the LEARNER row → "Change role" → select MANAGER.
Confirm dialog. `wait_for` "Role updated."

### Assertions
- DB: `Membership.role = 'MANAGER'`.
- Audit: `MEMBER_ROLE_CHANGED`.
- Table refreshes; pill says MANAGER.

---

## Case UI.M.5: Removal — OWNER can, LEARNER cannot

As OWNER:
- Click kebab → Remove. Confirm. `wait_for("Removed")`.
- DB: `Membership.status = 'REMOVED'`.

As LEARNER (login with the demoted user from UI.M.4 if you didn't
remove them — otherwise spawn a fresh LEARNER):
- Navigate to members page.
- `take_snapshot` — the rows do NOT have a kebab / action column.

### Assertions
- No kebab for LEARNER's view of any row (including self).
- Direct API call `DELETE /api/organizations/<wipro-id>/members/<id>`
  via `evaluate_script` → 403 (mirrors R.3-equivalent in API file).

---

## Case UI.M.6: LEARNER sidebar

Login as a fresh LEARNER. Navigate to the org dashboard.

`take_snapshot`. Expected: sidebar contains only the "Home" entry. No
Billing, Contracts, Programs, Payouts, Audit, Consent, Settings entries.

If any of those entries appear, the sidebar gating in the layout
component is broken. TRIVIAL fix if it's a single conditional.

---

## Case UI.M.7: LEARNER direct-URL → 403

As LEARNER, `navigate_page("/dashboard/organization/<wipro-id>/billing")`.

`take_snapshot`. Expected: a 403 page or a redirect to /home, no
Billing data visible.

`list_network_requests` — any background API calls to billing routes
should be 403.
