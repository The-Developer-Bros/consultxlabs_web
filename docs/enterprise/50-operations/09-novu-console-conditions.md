---
title: Novu console conditions for notification scoping
band: 50-operations
audience: operator
status: live
last-reviewed: 2026-07-30
---

# Novu console conditions runbook

[ADR 23](../70-design-decisions/23-notification-scope.md) made notifications carry their organization scope and made the organization preference categories writable. The application half of that is complete: every field below is written to the Novu subscriber record by `POST /api/novu/subscriber` and `PUT /api/novu/preferences`.

The console half is now automated as well. [ADR 30](../70-design-decisions/30-novu-templates-as-code-and-workflow-families.md) moved the step conditions into `lib/novu/templates/conditions.ts`, and `npm run novu:sync` applies them per family — one `skip` rule per family's in-app step, derived from the family's `PreferenceCategory` — rather than an operator setting them by hand in the console. This document now describes what the sync writes, so that the reasoning behind the mapping stays legible without reverse-engineering the code.

## Where the flags come from

Every flag is a key on the subscriber's `data` object. The two writers are `lib/novu/subscriber.ts` — `syncSubscriber` for the routing flags and `updateSubscriberPreferences` for the category flags. In the Novu step editor these are referenced as `subscriber.data.<key>`.

| Key                     | Type    | Default          | Written from                                         |
| ----------------------- | ------- | ---------------- | ---------------------------------------------------- |
| `routingBell`           | boolean | `true`           | `OrgWorkspaceProfile.notificationRoutingMode`        |
| `routingEmail`          | boolean | `true`           | `OrgWorkspaceProfile.notificationRoutingMode`        |
| `routingMode`           | string  | `BELL_AND_EMAIL` | the same column, kept for readability in the console |
| `categoryOrgBilling`    | boolean | `true`           | `NotificationPreference.orgBillingAlerts`            |
| `categoryOrgMembership` | boolean | `true`           | `NotificationPreference.orgMembershipAlerts`         |
| `categoryOrgProgram`    | boolean | `true`           | `NotificationPreference.orgProgramAlerts`            |

The seven pre-existing `category*` flags are unchanged and already wired; do not touch them.

## Step one: the routing flag

This gates the channel rather than the event, so the sync applies it to **every** family's in-app step, not only the organization ones.

On each family's **In-App** step, `inAppSkipRule` in `lib/novu/templates/conditions.ts` writes the condition `subscriber.data.routingBell` **is not false**. The operator language changed from "is true" to "is not false" because a subscriber whose flag was never written resolves to `null` in Novu's JSON Logic, and `null == true` evaluates to false — which would have silenced a subscriber who had simply never touched the setting. `!= false` treats `null` the same as `true`, matching the flag's own permissive default.

A subscriber who has never touched the setting is therefore unaffected. Only an operator who has explicitly chosen `BELL_ONLY`, `EMAIL_ONLY` or `NEITHER` in their workspace settings sees a difference — which is the behaviour the settings panel has been promising and now delivers.

## Step two: the organization category flags

Each family carries at most one category condition, applied by the same `inAppSkipRule` call to its in-app step. The mapping follows the audience rather than the noun: an operator who wants invoices but not roster churn, and an expert who wants the reverse, are the two cases the split exists to serve.

### `categoryOrgBilling` — money in and money out

| Workflow slug                  |
| ------------------------------ |
| `org-invoice-issued`           |
| `org-invoice-paid`             |
| `org-invoice-overdue`          |
| `org-wallet-topup-confirmed`   |
| `org-wallet-low`               |
| `org-payout-completed`         |
| `org-payout-failed`            |
| `org-payout-reversed`          |
| `org-member-overage-timed-out` |
| `org-program-overage-due`      |

The two overage workflows sit here rather than under programs because both are addressed to the member who now owes money, not to the operator watching a cap.

### `categoryOrgMembership` — who is in the organization

| Workflow slug              |
| -------------------------- |
| `org-invite-sent`          |
| `org-invite-accepted`      |
| `org-expert-removed`       |
| `org-sso-provider-deleted` |
| `org-sso-cert-expiring`    |

The two SSO workflows are membership rather than a category of their own: they concern how people get into the organization, and an operator who mutes roster noise is unlikely to want certificate warnings routed elsewhere. Revisit this if an organization asks for security alerts to be separately non-mutable.

### `categoryOrgProgram` — entitlement and capacity

| Workflow slug                  |
| ------------------------------ |
| `org-program-exhausted`        |
| `org-program-cap-near`         |
| `org-license-renewal-upcoming` |
| `org-data-export-ready`        |

`org-data-export-ready` is the loosest fit. It is operational rather than commercial, and it sits here because it is addressed to the same operator audience as the capacity warnings.

## Step three: verify

Two checks are enough to prove the wiring end to end.

For a category, open the organization dashboard, go to **Settings → Notifications**, turn **Billing & Payouts** off, and trigger an invoice event for that organization. Nothing should arrive. Turn it back on and repeat; the notification should arrive. If it arrives in both cases the condition is missing or is reading the wrong key.

For routing, set **Notification routing** to `EMAIL_ONLY` in the cross-organization workspace settings, then trigger any organization event. An email should arrive and the bell should stay silent. Note that the routing flags come from `syncSubscriber`, which runs when a dashboard mounts — so sign out and back in, or reload a dashboard, after changing the setting.

## What is deliberately not conditioned

The `ORG_*` payloads do not carry a `NotificationScope`. They are unambiguous by construction — every one is an organization-lifecycle event and names its organization in the payload — so a scope discriminator would be redundant. The consequence, recorded in ADR 23, is that these notifications appear under the inbox's **All** tab but not under a specific organization's tab, which filters on `organizationId`. If an operator asks for organization-lifecycle events to file under their organization's tab, the fix is to add the scope to those payloads in code, not to add a console condition.
