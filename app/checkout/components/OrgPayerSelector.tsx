"use client";

import { useSession } from "@/lib/auth-client";
import { useQuery } from "@tanstack/react-query";
import Image from "next/image";
import { Building2, CreditCard, AlertTriangle, Ban, Info } from "lucide-react";
import type { CoveredPlanType } from "@prisma/client";

interface OveragePreview {
  applicable: boolean;
  programName: string | null;
  marginalPaise: number;
  willExceedCap: boolean;
  willBlock: boolean;
  chargeTo: "MEMBER" | "ORG" | null;
}

interface OrgPayerSelectorProps {
  selectedOrganizationId: string | null;
  onSelect: (organizationId: string | null) => void;
  /**
   * #777 §C — when provided, the selector previews whether billing this plan to
   * the selected org will breach its cap and warns BEFORE pay. Optional so
   * existing callers without plan context keep working unchanged.
   */
  planType?: CoveredPlanType;
  planId?: string;
}

const inr = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;

/** #777 §C — pre-checkout overage warning for the selected sponsoring org. */
function OverageWarning({
  organizationId,
  organizationName,
  planType,
  planId,
}: {
  organizationId: string;
  organizationName: string;
  planType: CoveredPlanType;
  planId: string;
}) {
  const { data } = useQuery<OveragePreview>({
    queryKey: ["overage-preview", organizationId, planType, planId],
    queryFn: async () => {
      const res = await fetch(
        `/api/organizations/${organizationId}/checkout/overage-preview?planType=${planType}&planId=${planId}`,
      );
      if (!res.ok) throw new Error("preview failed");
      return res.json();
    },
    staleTime: 30_000,
    retry: false,
  });

  if (!data?.applicable) return null;

  if (data.willBlock) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm">
        <Ban className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
        <span className="text-rose-900">
          This booking exceeds {organizationName}&apos;s covered allocation and
          can&apos;t be billed to the organization. Pay with your card, or ask
          your admin to raise the program cap.
        </span>
      </div>
    );
  }

  if (data.willExceedCap && data.marginalPaise > 0) {
    const who =
      data.chargeTo === "MEMBER"
        ? `you'll be charged ${inr(data.marginalPaise)}`
        : `${inr(data.marginalPaise)} will be billed to ${organizationName}`;
    return (
      <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <span className="text-amber-900">
          This exceeds your covered allocation — {who} as an overage charge.
        </span>
      </div>
    );
  }

  return null;
}

/**
 * #1430 — non-blocking consent pre-flight. `handleCheckout` already fails
 * closed on a missing SESSION_BOOKING consent artifact for the booking
 * member, so this is a heads-up, not a gate: the server stays the
 * authoritative check, this just stops the surprise at pay time.
 */
function ConsentPreflightNotice({
  organizationId,
}: {
  organizationId: string;
}) {
  const { data } = useQuery<{ hasConsent: boolean }>({
    queryKey: ["checkout-consent-preview", organizationId],
    queryFn: async () => {
      const res = await fetch(
        `/api/organizations/${organizationId}/checkout/consent-preview`,
      );
      if (!res.ok) throw new Error("consent preview failed");
      return res.json();
    },
    staleTime: 30_000,
    retry: false,
  });

  if (!data || data.hasConsent) return null;

  return (
    <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
      <span className="text-blue-900">
        You have not granted session-booking consent yet. Your organization
        cannot book or pay for a session on your behalf until you grant it in
        your privacy settings.
      </span>
    </div>
  );
}

/**
 * Payer selector for checkout pages. Shows "Pay personally" vs "Bill to
 * [org name]" when the user has org memberships. Self-hides for users
 * with no org affiliations (B2C users).
 *
 * Each org option renders a funding-source-aware subtitle so the learner
 * knows what picking that org actually costs them before they confirm:
 *   - PERSONAL → "You pay — the org is tagged for reporting only"
 *   - WALLET   → "Wallet: ₹X remaining" (#752 — "Credits" overloaded wallet
 *     balance with CREDIT_POOL metering; the value shown is wallet balance)
 *   - INVOICE  → "Added to the org's monthly invoice"
 *   - LICENSE  → "Free — covered by the org's enterprise license"
 *
 * The membership shape comes straight from lib/auth.ts customSession;
 * there are no `as` casts here — the Session type already carries the
 * narrowed FundingSource via z.infer on the Prisma enum.
 */
export function OrgPayerSelector({
  selectedOrganizationId,
  onSelect,
  planType,
  planId,
}: OrgPayerSelectorProps) {
  const { data: session } = useSession();
  const memberships = session?.user?.organizationMemberships ?? [];

  // Only render the selector when the user has at least one org that can
  // actually sponsor (canSponsor=true). A pure HOST membership wouldn't
  // let the learner book through the org anyway, so showing it here
  // would be misleading.
  const sponsoringMemberships = memberships.filter((m) => m.canSponsor);
  if (sponsoringMemberships.length === 0) return null;

  const selectedMembership = sponsoringMemberships.find(
    (m) => m.organizationId === selectedOrganizationId,
  );

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-muted-foreground">
        Who is paying?
      </p>

      {/* Personal payment option */}
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={`w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-colors ${
          selectedOrganizationId === null
            ? "border-foreground bg-muted ring-1 ring-foreground"
            : "border-border hover:border-muted-foreground/40"
        }`}
      >
        <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center shrink-0">
          <CreditCard className="w-4 h-4 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            Pay with your card
          </p>
          <p className="text-xs text-muted-foreground/70">Personal payment</p>
        </div>
      </button>

      {/* Org payment options */}
      {sponsoringMemberships.map((m) => {
        const isSelected = selectedOrganizationId === m.organizationId;
        const subtitle = renderSubtitle(m);
        return (
          <button
            key={m.organizationId}
            type="button"
            onClick={() => onSelect(m.organizationId)}
            className={`w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-colors ${
              isSelected
                ? "border-foreground bg-muted ring-1 ring-foreground"
                : "border-border hover:border-muted-foreground/40"
            }`}
          >
            <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center overflow-hidden shrink-0">
              {m.organizationLogo ? (
                <Image
                  src={m.organizationLogo}
                  alt={m.organizationName}
                  width={32}
                  height={32}
                  className="w-full h-full object-cover"
                />
              ) : (
                <Building2 className="w-4 h-4 text-muted-foreground" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">
                Bill to {m.organizationName}
              </p>
              <p className="text-xs mt-0.5 truncate">{subtitle}</p>
            </div>
          </button>
        );
      })}

      {/* #777 §C — pre-checkout overage warning for the selected org. */}
      {selectedOrganizationId && selectedMembership && planType && planId && (
        <OverageWarning
          organizationId={selectedOrganizationId}
          organizationName={selectedMembership.organizationName}
          planType={planType}
          planId={planId}
        />
      )}

      {/* #1430 — consent pre-flight, non-blocking. */}
      {selectedOrganizationId && (
        <ConsentPreflightNotice organizationId={selectedOrganizationId} />
      )}

      {selectedOrganizationId && (
        <p className="text-xs text-amber-600">
          Referral credits cannot be used for org-funded bookings.
        </p>
      )}
    </div>
  );
}

/**
 * Derive the cost-aware subtitle from the membership payload. Returns a
 * ReactNode because wallet + "no funding source" cases want coloured
 * numbers, while the rest are plain text.
 */
function renderSubtitle(m: {
  fundingSource: import("@prisma/client").FundingSource | null;
  walletBalance: number | null;
}): React.ReactNode {
  switch (m.fundingSource) {
    case "WALLET": {
      const paise = m.walletBalance ?? 0;
      return (
        <span
          className={paise === 0 ? "text-red-500" : "text-muted-foreground"}
        >
          Wallet: ₹{(paise / 100).toLocaleString("en-IN")} remaining
        </span>
      );
    }
    case "INVOICE":
      return (
        <span className="text-muted-foreground">
          Added to org&apos;s monthly invoice
        </span>
      );
    case "LICENSE":
      return (
        <span className="text-emerald-600">
          Free — covered by enterprise license
        </span>
      );
    case "PERSONAL":
      return (
        <span className="text-muted-foreground">
          You pay — org receives the report
        </span>
      );
    case null:
      // No billing account attached — org was set up without one, or it
      // was deleted. Default to a neutral label; server-side will reject
      // the org-funded checkout on validation.
      return (
        <span className="text-muted-foreground">Organization billing</span>
      );
  }
}
