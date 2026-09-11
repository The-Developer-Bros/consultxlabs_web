/**
 * SSO Cert Expiry Alert — Core Logic
 *
 * Parses X.509 certificates out of every `SsoProvider.samlConfig` row
 * and emits an `OrgAuditLog` entry (SETTINGS / SSO_CERT_EXPIRING) at
 * two thresholds:
 *
 *   - 30 days remaining → severity "WARN"
 *   - 7 days remaining  → severity "CRITICAL"
 *   - already expired   → severity "EXPIRED"
 *
 * Daily dedup: if an audit row with the same action+provider was emitted
 * in the last 20 hours we skip, so running the cron twice in a day does
 * not double-alert. The cron itself runs once daily at 03:25 UTC.
 *
 * Scope:
 *   - Only SAML providers (OIDC uses discovery endpoints, cert rotation
 *     is invisible to us; that is a separate monitoring problem).
 *   - Ignores providers whose samlConfig is unparseable or missing a
 *     `cert` field — emits a structured warning to logs but does not
 *     fail the cron.
 *   - No Novu wiring in this v1 pass — alerts are audit-log only, per
 *     the user's decision to defer bell-notifications to Phase 2.
 *     A future iteration pipes the same trigger into Novu so OWNERs
 *     see the alert on their dashboard bell.
 *
 * This module exports the core alert function. It is imported by:
 *   - jobs/cleanup/sso-cert-expiry-alert.ts (GitHub Actions wrapper)
 *   - app/api/cleanup/sso-cert-expiry-alert/route.ts (HTTP endpoint)
 *
 * Schedule: Daily at 08:55 IST (03:25 UTC; #709 minute map). Runs on its own slot so
 *           it does not overlap cleanup-abandoned-org-top-ups (07:30
 *           IST / 02:00 UTC), stale-invitations (08:00 IST / 02:30
 *           UTC), or the subscription cron (05:30 IST / 00:00 UTC).
 */

import { X509Certificate } from "node:crypto";
import prisma from "../../lib/prisma";
import { AUDIT_ACTIONS } from "../../lib/enterprise/audit-actions";
import { notifyOrgSsoCertExpiring } from "../../lib/novu/org-workflows";
import { withCronLock } from "@/lib/cron/with-cron-lock";

type Severity = "WARN" | "CRITICAL" | "EXPIRED";

const WARN_DAYS = 30;
const CRITICAL_DAYS = 7;
const DEDUP_WINDOW_MS = 20 * 60 * 60 * 1000; // 20h — ensures daily cron fires exactly once

export interface SsoCertExpiryAlertResult {
  success: boolean;
  scanned: number;
  alerted: number;
  parseFailures: number;
  errors: string[];
  timestamp: string;
}

function severityFor(daysRemaining: number): Severity | null {
  if (daysRemaining < 0) return "EXPIRED";
  if (daysRemaining <= CRITICAL_DAYS) return "CRITICAL";
  if (daysRemaining <= WARN_DAYS) return "WARN";
  return null; // outside alert window — nothing to do
}

function parseNotAfter(samlConfigJson: string): Date | null {
  try {
    const parsed = JSON.parse(samlConfigJson);
    if (!parsed || typeof parsed !== "object") return null;
    const cert = (parsed as { cert?: unknown }).cert;
    if (typeof cert !== "string" || cert.trim() === "") return null;
    const x509 = new X509Certificate(cert);
    return new Date(x509.validTo);
  } catch {
    return null;
  }
}

// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open: repeat-safe side effects, lock is belt-and-braces.
export async function runSsoCertExpiryAlert(): Promise<SsoCertExpiryAlertResult> {
  return withCronLock("sso-cert-expiry-alert", { failMode: "open" }, () =>
    runSsoCertExpiryAlertUnlocked(),
  );
}

async function runSsoCertExpiryAlertUnlocked(): Promise<SsoCertExpiryAlertResult> {
  const now = new Date();
  const errors: string[] = [];
  let alerted = 0;
  let parseFailures = 0;

  console.log("🔐 Starting SSO cert expiry alert scan...");

  // Only providers linked to an org (organizationId not null) + with a
  // samlConfig. OIDC providers don't store a cert — discovery-endpoint
  // rotation is invisible to us.
  const providers = await prisma.ssoProvider.findMany({
    where: {
      samlConfig: { not: null },
      organizationId: { not: null },
    },
    select: {
      id: true,
      providerId: true,
      organizationId: true,
      domain: true,
      samlConfig: true,
    },
  });

  console.log(`   Found ${providers.length} SAML provider(s).`);

  for (const provider of providers) {
    if (!provider.samlConfig || !provider.organizationId) continue;

    const notAfter = parseNotAfter(provider.samlConfig);
    if (!notAfter || Number.isNaN(notAfter.getTime())) {
      parseFailures += 1;
      console.warn(
        JSON.stringify({
          event: "sso_cert_parse_failed",
          providerId: provider.providerId,
          organizationId: provider.organizationId,
        }),
      );
      continue;
    }

    const msUntilExpiry = notAfter.getTime() - now.getTime();
    const daysRemaining = Math.floor(msUntilExpiry / (1000 * 60 * 60 * 24));
    const severity = severityFor(daysRemaining);
    if (!severity) continue;

    try {
      // Dedup: skip if we emitted an SSO_CERT_EXPIRING row for this
      // provider in the last 20 hours. Using details->>'providerId' would
      // need a JSONB filter; the cheaper check is org+category+action
      // within the window and a details.providerId match after fetch.
      const recent = await prisma.orgAuditLog.findFirst({
        where: {
          organizationId: provider.organizationId,
          category: "SETTINGS",
          action: AUDIT_ACTIONS.SETTINGS.SSO_CERT_EXPIRING,
          createdAt: { gte: new Date(now.getTime() - DEDUP_WINDOW_MS) },
        },
        select: { id: true, details: true },
      });
      if (
        recent &&
        typeof recent.details === "object" &&
        recent.details !== null &&
        (recent.details as { providerId?: unknown }).providerId ===
          provider.providerId
      ) {
        continue; // already alerted for this provider today
      }

      await prisma.orgAuditLog.create({
        data: {
          organizationId: provider.organizationId,
          actorMembershipId: null,
          category: "SETTINGS",
          action: AUDIT_ACTIONS.SETTINGS.SSO_CERT_EXPIRING,
          description: `SSO SAML certificate for provider '${provider.providerId}' is ${
            severity === "EXPIRED"
              ? "already expired"
              : `expiring in ${daysRemaining} day(s)`
          } [severity=${severity}]`,
          details: {
            providerId: provider.providerId,
            domain: provider.domain,
            notAfter: notAfter.toISOString(),
            daysRemaining,
            severity,
          },
        },
      });
      // Best-effort Novu bell notification to OWNERs. Lookup org name
      // inline — providers table doesn't carry it.
      const org = await prisma.organization.findUnique({
        where: { id: provider.organizationId },
        select: { name: true },
      });
      if (org) {
        await notifyOrgSsoCertExpiring(provider.organizationId, {
          orgName: org.name,
          providerId: provider.providerId,
          daysRemaining,
          severity,
          notAfter: notAfter.toISOString(),
          dashboardUrl: `/dashboard/organization/${provider.organizationId}/settings/sso`,
        });
      }
      alerted += 1;
      console.log(
        `   ⚠️  ${severity} — provider ${provider.providerId} expires ${notAfter.toISOString()} (${daysRemaining}d)`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`provider ${provider.providerId}: ${message}`);
      console.error(
        JSON.stringify({
          event: "sso_cert_alert_write_failed",
          providerId: provider.providerId,
          organizationId: provider.organizationId,
          message,
        }),
      );
    }
  }

  return {
    success: errors.length === 0,
    scanned: providers.length,
    alerted,
    parseFailures,
    errors,
    timestamp: now.toISOString(),
  };
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
