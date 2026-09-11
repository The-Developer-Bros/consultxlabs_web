/**
 * #777 §A + #779 §F — the single org-state model behind BOTH the Getting-Started
 * activation checklist (new orgs) AND the "action required" center (ongoing
 * condition banners). #777 calls for designing this once and reusing it for the
 * checklist, the verification banner, and the nav entry — this is that model.
 *
 * The derivations are PURE over an `OrgActivationSnapshot` (so they unit-test
 * without a DB, and client components can import them — keep this module free
 * of server-only imports). `resolveActivationSignals` in
 * org-activation-signals.ts does the few extra reads the analytics payload
 * doesn't already carry; the analytics route merges them in and the home page
 * maps the payload → snapshot → derived steps/banners.
 *
 * Deliberately surfaces only banners whose data exists today. Dunning sequences,
 * dispute-deadline alerts, and the cycle engine are v4 (#779 §B/§D) — their
 * banners arrive when their crons do.
 */
import type { FundingSource, OrgStatus } from "@prisma/client";

export interface OrgActivationSnapshot {
  status: OrgStatus;
  canSponsor: boolean;
  canHost: boolean;
  fundingSource: FundingSource | null;
  memberCount: number;
  activeProgramCount: number;
  activeAssignmentCount: number;
  billingConfigured: boolean;
  hasContract: boolean;
  hasActiveContract: boolean;
  kybVerified: boolean;
  // action-center signals (each banner only renders when its datum is present)
  pastDueInvoiceCount: number;
  outstandingInvoicePaise: number;
  contractExpiringSoonCount: number;
  pendingOverageCount: number;
  pendingOveragePaise: number;
  stuckPayoutCount: number;
  walletLowBalancePaise: number | null; // null = not a wallet org
  creditPoolMaxUtilizationPct: number | null;
}

export interface ActivationStep {
  key: string;
  label: string;
  done: boolean;
  href: string;
}

type ActionSeverity = "critical" | "warning" | "info";

export interface ActionItem {
  key: string;
  severity: ActionSeverity;
  title: string;
  body: string;
  ctaLabel: string;
  ctaHref: string;
}

/** Below this the wallet is "low" — surfaced before bookings start failing. */
const WALLET_LOW_BALANCE_PAISE = 1_000_00; // ₹1,000

/**
 * The activation checklist — capability-aware. A SPONSOR org's path runs
 * verify → KYB(INVOICE) → billing → contract → program → invite → assign;
 * HOST-only orgs collapse to verify → invite. Each step deep-links to the
 * surface that completes it.
 */
export function deriveActivationChecklist(
  s: OrgActivationSnapshot,
  orgId: string,
): ActivationStep[] {
  const base = `/dashboard/organization/${orgId}`;
  const steps: ActivationStep[] = [
    {
      key: "verify",
      label: "Get your organization verified",
      done: s.status === "ACTIVE",
      href: `${base}/settings`,
    },
  ];

  if (s.canSponsor) {
    if (s.fundingSource === "INVOICE") {
      steps.push({
        key: "kyb",
        label: "Complete KYB verification (required for invoicing)",
        done: s.kybVerified,
        href: `${base}/settings`,
      });
    }
    steps.push(
      {
        key: "billing",
        label: "Configure billing & funding",
        done: s.billingConfigured,
        href: `${base}/billing`,
      },
      {
        key: "contract",
        label: "Create a contract",
        done: s.hasContract,
        href: `${base}/contracts`,
      },
      {
        key: "program",
        label: "Create your first program",
        done: s.activeProgramCount > 0,
        href: `${base}/programs`,
      },
    );
  }

  steps.push({
    key: "invite",
    label: s.canHost && !s.canSponsor ? "Invite your experts" : "Invite members",
    done: s.memberCount > 1,
    // #1132 — `${base}/invitations` is a hard 404: ADR 19 folded invitations
    // into the members page as a tab and this link was never updated, so the
    // Getting-Started checklist sent every new org to a not-found page. The
    // tab value matches MembersTabs; `tab` is UrlTabs' default paramName.
    href: `${base}/members?tab=invitations`,
  });

  if (s.canSponsor) {
    steps.push({
      key: "assign",
      label: "Assign members to a program",
      done: s.activeAssignmentCount > 0,
      href: `${base}/programs`,
    });
  }

  return steps;
}

/** True once every applicable activation step is done — hides the checklist. */
export function isOrgActivated(s: OrgActivationSnapshot, orgId = "_"): boolean {
  return deriveActivationChecklist(s, orgId).every((step) => step.done);
}

/**
 * The "action required" center — the condition banners a customer should act on
 * NOW, ordered by severity. Only includes conditions whose backing data exists
 * today (no dunning/dispute banners — those land with v4's crons).
 */
export function deriveActionCenter(
  s: OrgActivationSnapshot,
  orgId: string,
): ActionItem[] {
  const base = `/dashboard/organization/${orgId}`;
  const items: ActionItem[] = [];

  if (s.status === "PENDING_VERIFICATION") {
    items.push({
      key: "pending-verification",
      severity: "warning",
      title: "Verification pending",
      body: "Inviting members and moving money unlocks once a platform admin verifies your organization.",
      ctaLabel: "Review setup",
      ctaHref: `${base}/settings`,
    });
  }
  if (s.status === "SUSPENDED") {
    items.push({
      key: "suspended",
      severity: "critical",
      title: "Organization suspended",
      body: "Invitations and payments are paused. Contact support to restore access.",
      ctaLabel: "Contact support",
      ctaHref: `${base}/settings`,
    });
  }

  if (s.pastDueInvoiceCount > 0) {
    items.push({
      key: "past-due-invoices",
      severity: "critical",
      title: `${s.pastDueInvoiceCount} invoice${s.pastDueInvoiceCount === 1 ? "" : "s"} overdue`,
      body: "Pay overdue invoices to keep bookings flowing.",
      ctaLabel: "Pay now",
      ctaHref: `${base}/billing`,
    });
  }

  if (s.creditPoolMaxUtilizationPct != null && s.creditPoolMaxUtilizationPct >= 80) {
    items.push({
      key: "credit-pool-near-cap",
      severity: "warning",
      title: `Program usage at ${Math.round(s.creditPoolMaxUtilizationPct)}%`,
      body: "A program is close to its cap. Top up or upsize before members hit overage.",
      ctaLabel: "View programs",
      ctaHref: `${base}/programs`,
    });
  }

  if (s.contractExpiringSoonCount > 0) {
    items.push({
      key: "contract-expiring",
      severity: "warning",
      title: `${s.contractExpiringSoonCount} contract${s.contractExpiringSoonCount === 1 ? "" : "s"} expiring soon`,
      body: "Renew or review contracts expiring within 30 days so coverage doesn't lapse.",
      ctaLabel: "Review contracts",
      ctaHref: `${base}/contracts`,
    });
  }

  if (s.pendingOverageCount > 0) {
    // #777 §C — overage-as-expansion prompt: recurring overage is the
    // strongest buy-more signal, so frame the cost against upsizing the
    // allocation instead of just reporting a count.
    const overageRupees =
      s.pendingOveragePaise > 0
        ? ` (₹${Math.round(s.pendingOveragePaise / 100).toLocaleString("en-IN")} this cycle)`
        : "";
    items.push({
      key: "pending-overages",
      severity: "info",
      title: `${s.pendingOverageCount} pending overage${s.pendingOverageCount === 1 ? "" : "s"}${overageRupees}`,
      body: "Members are booking past their covered allocation. If this recurs, expanding the program allocation is usually cheaper than paying overage.",
      ctaLabel: "Review allocation",
      ctaHref: `${base}/programs`,
    });
  }

  if (s.stuckPayoutCount > 0) {
    items.push({
      key: "stuck-payouts",
      severity: "info",
      title: `${s.stuckPayoutCount} payout${s.stuckPayoutCount === 1 ? "" : "s"} pending platform enablement`,
      body: "Payout disbursement isn't live yet — these are held, not failed.",
      ctaLabel: "View payouts",
      ctaHref: `${base}/payouts`,
    });
  }

  if (
    s.walletLowBalancePaise != null &&
    s.walletLowBalancePaise < WALLET_LOW_BALANCE_PAISE
  ) {
    items.push({
      key: "wallet-low",
      severity: "warning",
      title: "Wallet balance low",
      body: "Top up to avoid bookings failing when the balance runs out.",
      ctaLabel: "Top up",
      ctaHref: `${base}/billing`,
    });
  }

  return items;
}
