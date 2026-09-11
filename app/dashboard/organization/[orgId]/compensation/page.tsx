/**
 * /dashboard/organization/[orgId]/compensation — EXPERT's per-org view.
 *
 * The org's RateCard governs WHO gets paid WHAT for sessions hosted via
 * this org's brand. An EXPERT must be able to confirm:
 *   1. Where their share of sessions actually goes — `payoutRecipient`
 *      (`SELF` flows to their personal account; `ORGANIZATION` is
 *      absorbed by the org and they get a cut later via internal split).
 *   2. The exact bps split that applies right now — `RateCard` for the
 *      org (default + any consultant-category override).
 *   3. Their recent earnings via this org so they can reconcile the
 *      personal earnings dashboard against the org-routed flow.
 *
 * Read-only. Mutations (changing payout arrangement, accepting a new
 * RateCard) live on operator pages — an EXPERT can't self-flip those.
 */

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Building2 } from "lucide-react";

import { requireOrgAccess } from "@/lib/auth-helpers";
import { ENABLE_LIVE_PAYOUTS } from "@/lib/feature-flags";
import { formatCurrencyAmount } from "@/utils/formatting";
import { getMyArrangementData } from "@/lib/data/org-member-arrangement";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";

const PAYOUT_RECIPIENT_LABEL: Record<string, string> = {
  SELF: "You — paid directly",
  ORGANIZATION: "The organisation — they distribute internally",
};

// #777 §D.5 — humanise the raw EarningStatus enum. Payout disbursement is
// gated by ENABLE_LIVE_PAYOUTS, so even a READY earning is "earned, not yet
// paid out" — the note below the table says so honestly.
const EARNING_STATUS_LABEL: Record<string, string> = {
  READY: "Ready to settle",
  HELD: "On hold",
  PENDING: "Pending (hold window)",
  PENDING_TRUST: "Pending (trust window)",
  BATCHED: "Processing payout", // #837 — batched, cash not yet disbursed
  PAID: "Paid",
  REFUNDED: "Refunded",
};

const PAYOUT_RECIPIENT_DESCRIPTION: Record<string, string> = {
  SELF:
    "Your share of every session hosted via this org flows directly to your personal payout account. Manage that on your personal dashboard.",
  ORGANIZATION:
    "Your share of every session hosted via this org is absorbed by the organisation. They handle the internal distribution to you offline.",
};

export default async function MyArrangementPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId);
  if (access.error) {
    redirect(`/dashboard/organization/${orgId}/home`);
  }
  // Pages under canHost=false orgs (pure sponsors) don't host sessions
  // and have no RateCards / earnings — surface 404 to keep the URL
  // tree honest.
  if (!access.org.canHost) {
    notFound();
  }

  const member = access.member;

  const { orgDefaultCard, payoutAccount, earnings, upcomingSessions } =
    await getMyArrangementData({
      orgId,
      payoutRecipient: member.payoutRecipient,
      consultantProfileId: member.consultantProfileId,
    });

  // #1166 ORG-7 — the personal appointments page is personal-pinned (ADR 19)
  // and structurally ignores ?orgScope=, so deep-linking there could never
  // show the org-hosted session being joined. The org dashboard's own
  // appointments surface ("mine" scope) has the in-context Join.
  const appointmentsHref = `/dashboard/organization/${orgId}/appointments?scope=mine`;

  return (
    <>
      <DashboardHeader
        title="Compensation"
        subtitle={`How ${access.org.name} compensates you for sessions hosted under their brand.`}
      />
      {/* space-y-6: DashboardContent only supplies padding, and these sibling
          sections carry no margin of their own, so without it the bordered
          cards stack flush against each other. */}
      <DashboardContent className="space-y-6">

      {/* #754 — upcoming org-hosted sessions */}
      {member.consultantProfileId && upcomingSessions.length > 0 && (
        <section>
          <div className="mb-3">
            <h2 className="text-lg font-medium">Upcoming sponsored sessions</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Bookings {access.org.name} sponsored for you to host. Personal
              bookings you take from learners outside this org appear on your
              consultant dashboard.
            </p>
          </div>
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium whitespace-nowrap">When</th>
                  <th className="px-4 py-2 font-medium whitespace-nowrap">Learner</th>
                  <th className="px-4 py-2 font-medium whitespace-nowrap">Type</th>
                  <th className="px-4 py-2 font-medium whitespace-nowrap">Status</th>
                  <th className="px-4 py-2 font-medium text-right whitespace-nowrap">Your share</th>
                  <th className="px-4 py-2 font-medium text-right whitespace-nowrap">Join</th>
                </tr>
              </thead>
              <tbody>
                {upcomingSessions.map((s) => (
                  <tr key={s.id} className="border-t">
                    <td className="px-4 py-2">
                      {s.startsAt.toLocaleString("en-IN", {
                        timeZone: "Asia/Kolkata", // RSC renders in UTC otherwise
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="px-4 py-2">{s.learner}</td>
                    <td className="px-4 py-2 lowercase">{s.type}</td>
                    <td className="px-4 py-2 text-xs">
                      {s.status.toLowerCase().replace(/_/g, " ")}
                    </td>
                    <td className="px-4 py-2 text-right text-xs">
                      {/* Maps the earning to its session when one exists (#754).
                          Pre-payment sessions show "—". */}
                      {s.earning
                        ? formatCurrencyAmount(s.earning.consultantSharePaise, "INR")
                        : "—"}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {/* Real join lives on the org appointments page (it
                          mounts the Stream client). Gate the link to the
                          10-min window. */}
                      {s.joinable ? (
                        <Link
                          href={appointmentsHref}
                          className="inline-flex rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
                        >
                          Join now
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          Not yet
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Sessions you host under {access.org.name}. Join from this
            dashboard&apos;s{" "}
            <Link href={appointmentsHref} className="underline text-primary">
              appointments page
            </Link>{" "}
            when the room opens.
          </p>
        </section>
      )}

      {/* Payout arrangement */}
      <section className="rounded-lg border bg-card p-5">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-medium">Payout arrangement</h2>
            <p className="mt-1 text-sm">
              {PAYOUT_RECIPIENT_LABEL[member.payoutRecipient] ??
                member.payoutRecipient}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              {PAYOUT_RECIPIENT_DESCRIPTION[member.payoutRecipient]}
            </p>
          </div>
          <span className="rounded-full border px-2.5 py-0.5 text-xs">
            {member.payoutRecipient}
          </span>
        </div>

        {member.payoutRecipient === "ORGANIZATION" && payoutAccount && (
          <div className="mt-4 rounded-md border-l-2 border-primary bg-muted/40 p-3 text-sm">
            <p className="font-medium">Organisation payout account</p>
            <p className="mt-1 text-muted-foreground">
              {payoutAccount.bankName} · ••••{payoutAccount.accountNumberLast4} ·
              status: {payoutAccount.status.toLowerCase().replace(/_/g, " ")}
            </p>
          </div>
        )}

        {member.payoutRecipient === "SELF" && (
          <p className="mt-4 text-xs text-muted-foreground">
            Manage your personal payout account from{" "}
            <Link
              href="/dashboard"
              className="underline text-primary"
            >
              your personal dashboard
            </Link>
            .
          </p>
        )}
      </section>

      {/* RateCard split — read-only view of the ACTIVE split (#777 §D.16). */}
      <section className="rounded-lg border bg-card p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Revenue split</h2>
          {orgDefaultCard && (
            <span className="rounded-full border border-primary px-2.5 py-0.5 text-xs text-primary">
              Active split
            </span>
          )}
        </div>
        {orgDefaultCard ? (
          <>
            <p className="mt-1 text-sm text-muted-foreground">
              The active default split for sessions hosted via{" "}
              {access.org.name}. In effect since{" "}
              {orgDefaultCard.effectiveFrom.toLocaleDateString("en-IN", {
                timeZone: "Asia/Kolkata",
                day: "2-digit",
                month: "short",
                year: "numeric",
              })}
              .
            </p>
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3 text-center">
              <SplitCard
                label="Platform"
                bps={orgDefaultCard.platformBps}
              />
              <SplitCard
                label="Organisation"
                bps={orgDefaultCard.orgBps}
              />
              <SplitCard
                label="Your share"
                bps={orgDefaultCard.consultantBps}
                emphasised
              />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Illustration on a ₹1,000 session: platform takes{" "}
              {formatCurrencyAmount(
                Math.round(orgDefaultCard.platformBps * 10),
                "INR",
              )}
              , the organisation takes{" "}
              {formatCurrencyAmount(
                Math.round(orgDefaultCard.orgBps * 10),
                "INR",
              )}
              , your share is{" "}
              {formatCurrencyAmount(
                Math.round(orgDefaultCard.consultantBps * 10),
                "INR",
              )}
              .
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            No active rate card configured for this organisation yet. Reach out
            to your org administrator if you expect to host sessions soon.
          </p>
        )}
      </section>

      {/* Recent earnings */}
      {earnings.length > 0 && (
        <section>
          <div className="mb-3">
            <h2 className="text-lg font-medium">Recent panel earnings</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Your share from every session hosted under {access.org.name}'s
              panel — includes both org-sponsored bookings and direct/personal
              bookings learners made with you (per the rate-card panel cut).
            </p>
          </div>
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium whitespace-nowrap">When</th>
                  <th className="px-4 py-2 font-medium whitespace-nowrap">Type</th>
                  <th className="px-4 py-2 font-medium whitespace-nowrap">Source</th>
                  <th className="px-4 py-2 font-medium text-right whitespace-nowrap">Gross</th>
                  <th className="px-4 py-2 font-medium text-right whitespace-nowrap">
                    Your share
                  </th>
                  <th className="px-4 py-2 font-medium whitespace-nowrap">Status</th>
                </tr>
              </thead>
              <tbody>
                {earnings.map((e) => {
                  const isSponsored =
                    e.payment.appointment?.organizationId === orgId;
                  return (
                    <tr key={e.id} className="border-t">
                      <td className="px-4 py-2 whitespace-nowrap">
                        {e.payment.createdAt.toLocaleDateString("en-IN", {
                          timeZone: "Asia/Kolkata",
                          day: "2-digit",
                          month: "short",
                          year: "numeric",
                        })}
                      </td>
                      <td className="px-4 py-2 lowercase whitespace-nowrap">
                        {e.payment.appointment?.appointmentType ?? "—"}
                      </td>
                      <td className="px-4 py-2">
                        {isSponsored ? (
                          <span
                            className="inline-flex items-center gap-1 rounded-md bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-700"
                            title={`Sponsored by ${access.org.name}`}
                          >
                            <Building2 className="h-3 w-3 shrink-0" />
                            Sponsored
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            Direct booking
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        {formatCurrencyAmount(e.grossAmount, "INR")}
                      </td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        {formatCurrencyAmount(e.consultantSharePaise, "INR")}
                      </td>
                      <td className="px-4 py-2 text-xs whitespace-nowrap">
                        {EARNING_STATUS_LABEL[e.status] ?? e.status}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* #777 §D.5 — honest "earned, not yet paid out" note while the
              disbursement pipeline is gated. */}
          {!ENABLE_LIVE_PAYOUTS && (
            <p className="mt-2 text-xs text-amber-700">
              Earned — payout pending platform enablement. Your share is
              accrued and reconcilable above; cash disbursement switches on
              once live payouts are enabled for the platform.
            </p>
          )}
          {member.payoutRecipient === "ORGANIZATION" && (
            <p className="mt-2 text-xs text-muted-foreground">
              Your share figures above show the consultant cut per the rate
              card. Because your payout is routed to the organisation, the
              actual cash flow to you happens internally — confirm with your
              org administrator.
            </p>
          )}
        </section>
      )}

      {!member.consultantProfileId && (
        <div className="rounded-lg border bg-muted/40 p-4 text-sm">
          You don't have a consultant profile yet. Once you create one on your
          personal dashboard, sessions you host under this org will show up
          here.
        </div>
      )}
      </DashboardContent>
    </>
  );
}

function SplitCard({
  label,
  bps,
  emphasised,
}: {
  label: string;
  bps: number;
  emphasised?: boolean;
}) {
  const pct = (bps / 100).toFixed(bps % 100 === 0 ? 0 : 1);
  return (
    <div
      className={
        "rounded-md border p-4 " +
        (emphasised
          ? "border-primary bg-primary/5"
          : "border-border bg-card")
      }
    >
      <p className="text-2xl font-semibold">{pct}%</p>
      <p className="text-xs text-muted-foreground mt-1">{label}</p>
    </div>
  );
}
