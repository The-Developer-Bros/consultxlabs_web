"use client";

import { type ReactNode } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  CalendarX,
  CreditCard,
  ExternalLink,
  FileText,
  Users,
  Video,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/dashboard/DataCard";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { throwSupportError } from "@/lib/support/error-copy";
import { useSetBreadcrumbLabel } from "@/components/dashboard/breadcrumb-override";
import type { AppointmentActionAdapter } from "@/lib/appointments/adapter";
import { mapAppointmentDetail } from "@/lib/appointments/map-detail";
import { eventUnionStatusBadge } from "@/lib/appointments/status";
import type { AppointmentVM } from "@/lib/appointments/view-model";
import { trialCheckoutHref } from "@/lib/appointments/trial-checkout-href";
import type { TAppointmentDetail } from "@/lib/data/appointment-detail";
import {
  paymentStatusBadge,
  recordingStatusBadge,
  resolveSponsoringOrgName,
  type PaymentDisplayStatus,
} from "@/lib/labels/session-labels";
import { useSession } from "@/lib/auth-client";
import { useHoldCountdown } from "@/hooks/useHoldCountdown";
import { formatCurrencyAmount } from "@/utils/formatting";
import { CountdownBadge } from "../CountdownBadge";
import { KIND_LABEL } from "../AppointmentRow";
import { RowPrimaryAction } from "../RowPrimaryAction";
import { SessionTimeline } from "../SessionTimeline";
import { RescheduleProposalCard } from "./RescheduleProposalCard";
import { SupportThreadSheet } from "@/components/support/SupportThreadSheet";
import { AppointmentSupportStatusCard } from "@/components/support/AppointmentSupportStatusCard";
import { AppointmentCsatCard } from "@/components/support/AppointmentCsatCard";
import { SessionReviewCard } from "@/components/reviews/SessionReviewCard";

const PARTICIPANTS_PREVIEW = 5;

/**
 * #1428 — the single answer to "what may the payer do about this tentative
 * hold right now", so the timeline row and the payment card cannot drift.
 *
 * Past `Payment.expiresAt` the hold is already DEAD for availability
 * (`buildDeadHoldFilter`, utils/slotAllocation/occupancyPolicy.ts counts a
 * PENDING payment with a lapsed window as free), so another buyer can take
 * the slot before any sweep runs. Checkout also refuses to resume a stale
 * order (`findReusablePendingOrderPayment` matches only `expiresAt > now`)
 * and mints a fresh one instead. Paying the old link would therefore capture
 * onto a released slot and land in the #1439 terminal-race refund — so the
 * lapsed state offers a new checkout, not the dead "Pay now".
 */
type TentativeHoldCta = "PAY" | "REBOOK" | "NONE";

function tentativeHoldCta(args: {
  isConsultee: boolean;
  holdDeadline: Date | null;
  holdExpired: boolean;
  pendingPaymentUrl: string | null;
}): TentativeHoldCta {
  // The consultant sees held slots read-only; only the payer gets an action.
  if (!args.isConsultee) return "NONE";
  // No deadline at all is not a lapse — useHoldCountdown reports a null
  // deadline as expired, which would otherwise mis-read as "released".
  if (args.holdDeadline !== null && args.holdExpired) return "REBOOK";
  return args.pendingPaymentUrl ? "PAY" : "NONE";
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  );
}

function ResourceSubgroup({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof FileText;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        {title}
      </p>
      {children}
    </div>
  );
}

interface AppointmentDetailClientProps {
  appointmentId: string;
  role: "consultee" | "consultant";
  adapter: AppointmentActionAdapter;
  backHref: string;
  /** Role-specific documents block (consultee upload widget / consultant list). */
  renderDocuments?: (vm: AppointmentVM) => ReactNode;
  /** Consultant-only: participants management link resolver. */
  participantsHref?: (detail: TAppointmentDetail) => string | null;
  joinWindowMs?: number;
}

export function AppointmentDetailClient({
  appointmentId,
  role,
  adapter,
  backHref,
  renderDocuments,
  participantsHref,
  joinWindowMs,
}: AppointmentDetailClientProps) {
  const { data: session } = useSession();
  const {
    data: detail,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["appointment-detail", appointmentId] as const,
    queryFn: async (): Promise<TAppointmentDetail> => {
      const res = await fetch(`/api/appointments/${appointmentId}`);
      if (!res.ok) await throwSupportError(res, "appointment detail load");
      const { data } = await res.json();
      return data;
    },
  });

  const mapped = detail ? mapAppointmentDetail(detail, role) : null;
  useSetBreadcrumbLabel(mapped?.vm.title);

  const payments = detail?.appointment.payment ?? [];
  // #1428 — the tentative-hold deadline: the soonest still-pending payment
  // guarding a held slot on this booking. Derived ABOVE the loading/error
  // returns because useHoldCountdown below it is a hook and may not sit
  // behind a conditional return.
  const holdDeadline =
    payments
      .filter((p) => p.paymentStatus === "PENDING" && p.expiresAt)
      .map((p) => new Date(p.expiresAt!))
      .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  const { isExpired: holdExpired } = useHoldCountdown(holdDeadline);
  const tentativeCta = tentativeHoldCta({
    isConsultee: role === "consultee",
    holdDeadline,
    holdExpired,
    pendingPaymentUrl: mapped?.vm.pendingPaymentUrl ?? null,
  });

  if (isLoading && !detail) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    );
  }

  if (error || !detail || !mapped) {
    return (
      <EmptyState
        icon={CalendarX}
        title="Couldn't load this appointment"
        description={
          error instanceof Error ? error.message : "Please try again."
        }
        action={
          <Button variant="outline" onClick={() => void refetch()}>
            Retry
          </Button>
        }
      />
    );
  }

  const { vm, recordings } = mapped;
  const action = adapter.primaryAction(vm);
  // #1163 — the proposal card below IS the answer surface; the adapter's
  // "Review reschedule request" list affordance would only link back here.
  const overflow = adapter
    .overflowItems(vm)
    .filter((item) => item.key !== "reschedule-proposal");
  const badge = eventUnionStatusBadge(vm.status);
  const orgName =
    detail.appointment.organization?.name ??
    resolveSponsoringOrgName(
      vm.organizationId,
      session?.user?.organizationMemberships ?? [],
    );
  const participants = Array.from(
    new Map(
      detail.appointment.slotsOfAppointment
        .flatMap((slot) => slot.user)
        .map((u) => [u.id, u]),
    ).values(),
  );
  const previewParticipants = participants.slice(0, PARTICIPANTS_PREVIEW);
  const hiddenParticipantCount = Math.max(
    0,
    participants.length - PARTICIPANTS_PREVIEW,
  );
  const manageHref = participantsHref?.(detail) ?? null;
  const anchorSession = vm.nextAt
    ? vm.sessions.find((s) => s.startsAt.getTime() === vm.nextAt?.getTime())
    : undefined;
  const hasConfirmedSessions = vm.sessions.some((s) => !s.isTentative);
  const hasTentativeSessions = vm.sessions.some((s) => s.isTentative);
  // #1429 F2 — a trial's Pay Now lands on our branded trial checkout, which
  // names the amount and the hold deadline; only a non-trial booking falls
  // through to the raw gateway link. #1428 added a second Pay Now here without
  // the branch, so both entry points now ask the one shared helper.
  const trialHref = trialCheckoutHref(vm);
  const openPendingPayment = () => {
    if (trialHref) {
      window.location.href = trialHref;
      return;
    }
    if (vm.pendingPaymentUrl && /^https?:\/\//.test(vm.pendingPaymentUrl)) {
      window.open(vm.pendingPaymentUrl, "_blank", "noopener,noreferrer");
    }
  };
  // #1163 — the read narrows to open statuses and takes one, so [0] is THE
  // live proposal; the card is the answer surface "Awaiting schedule
  // confirmation" never offered.
  const openProposal = detail.appointment.rescheduleRequests?.[0] ?? null;

  return (
    <DashboardErrorBoundary>
      <div className="w-full space-y-4">
        <Button variant="ghost" size="sm" className="-ml-2" asChild>
          <Link href={backHref}>
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            All appointments
          </Link>
        </Button>

        {/* Header card */}
        <div className="rounded-2xl border border-border bg-card shadow-sm p-4 sm:p-6">
          <div className="flex flex-col sm:flex-row sm:items-start gap-4">
            <Avatar className="h-14 w-14 border border-border shrink-0">
              <AvatarImage
                src={vm.counterpart.image ?? undefined}
                alt={vm.counterpart.name}
              />
              <AvatarFallback className="text-base font-medium">
                {initials(vm.counterpart.name) || "?"}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-semibold text-foreground">
                  {vm.title}
                </h1>
                <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {KIND_LABEL[vm.kind]}
                </span>
                <StatusBadge {...badge} withDot size="sm" />
                {orgName && (
                  <span className="rounded bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300 px-1.5 py-px text-[10px] font-medium">
                    Sponsored · {orgName}
                  </span>
                )}
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                with {vm.counterpart.name}
                {vm.meta ? ` · ${vm.meta}` : ""}
              </p>
              {vm.nextAt && (
                <div className="flex flex-wrap items-center gap-2 mt-2 text-sm">
                  <span className="font-medium text-foreground tabular-nums">
                    {format(vm.nextAt, "EEE, d MMM yyyy · h:mm a")}
                    {anchorSession?.endsAt && (
                      <span className="text-muted-foreground font-normal">
                        {" – "}
                        {format(anchorSession.endsAt, "h:mm a")}
                      </span>
                    )}
                  </span>
                  {vm.bucket !== "past" && vm.bucket !== "cancelled" && (
                    <CountdownBadge
                      targetDate={vm.nextAt}
                      sessionEndDate={anchorSession?.endsAt ?? undefined}
                    />
                  )}
                </div>
              )}
              {vm.collaborators.length > 0 && (
                <p className="text-xs text-muted-foreground mt-2">
                  Collaborators:{" "}
                  {vm.collaborators
                    .map((c) => `${c.name}${c.role ? ` (${c.role})` : ""}`)
                    .join(", ")}
                </p>
              )}
            </div>
          </div>

          {/* Actions — full-width bar so buttons aren't cramped beside the title.
              Always rendered: "Get help" is available on every appointment. */}
          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-border pt-4">
            {action.kind !== "view" && (
              <RowPrimaryAction action={action} size="default" />
            )}
            {overflow.map((item) => (
              <Button
                key={item.key}
                variant="outline"
                size="sm"
                disabled={item.disabled}
                onClick={item.onClick}
                className={
                  item.destructive
                    ? "text-red-600 border-red-200 hover:bg-red-50 dark:text-red-400 dark:border-red-900/40 dark:hover:bg-red-900/20"
                    : undefined
                }
              >
                {item.label}
              </Button>
            ))}
            <SupportThreadSheet
              appointmentId={appointmentId}
              isOrgContext={!!orgName}
            />
          </div>

          {/* #support-hub — the live support conversation for THIS appointment:
              status + latest exchange inline; nothing renders until a thread
              exists. */}
          <AppointmentSupportStatusCard
            appointmentId={appointmentId}
            isOrgContext={!!orgName}
          />

          {vm.group && vm.group.total > 0 && (
            <div className="mt-4 pt-4 border-t border-border">
              <div className="flex items-center justify-between text-xs text-muted-foreground mb-1.5">
                <span>Program progress</span>
                <span className="font-medium text-foreground">
                  {vm.group.completed} of {vm.group.total} sessions
                </span>
              </div>
              <Progress
                value={
                  // A group whose sessions have no slots yet has total 0,
                  // and 0/0 is NaN — which reaches Progress as an
                  // attribute value and renders a broken bar.
                  vm.group.total > 0
                    ? (vm.group.completed / vm.group.total) * 100
                    : 0
                }
                className="h-2"
              />
            </div>
          )}
        </div>

        {openProposal && (
          <RescheduleProposalCard
            appointmentId={appointmentId}
            proposal={openProposal}
            role={role}
          />
        )}

        <div className="grid w-full grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(260px,340px)] lg:items-start">
          <div className="flex min-w-0 flex-col gap-4">
            {/* #705 — attendees only. The API authorizes any participant, so
                this used to offer a consultant a star rating on their own
                session, which then fed the org quality average. */}
            {vm.bucket === "past" && role === "consultee" && (
              <>
                <AppointmentCsatCard appointmentId={appointmentId} />
                <SessionReviewCard appointmentId={appointmentId} />
              </>
            )}
            <Section title="Sessions">
              {hasConfirmedSessions || hasTentativeSessions ? (
                <SessionTimeline
                  sessions={vm.sessions}
                  joinWindowMs={joinWindowMs}
                  defaultExpanded
                  isJoining={action.kind === "join" && !!action.busy}
                  onJoinSession={
                    action.kind === "join" && action.onClick
                      ? () => action.onClick!()
                      : undefined
                  }
                  showHeld
                  holdDeadline={holdDeadline}
                  // #1428 — consultee sees the CTA while the window is live;
                  // the consultant, and anyone once the hold has lapsed, sees
                  // the same held row read-only ("awaiting payment").
                  onCompletePayment={
                    tentativeCta === "PAY" ? openPendingPayment : undefined
                  }
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  No sessions scheduled yet.
                </p>
              )}
            </Section>

            <Section title="Payment & sponsorship">
              {payments.length === 0 && !orgName ? (
                <p className="text-xs text-muted-foreground">
                  No payment is attached to this booking.
                </p>
              ) : (
                <div className="space-y-2">
                  {payments.map((payment) => (
                    <div
                      key={payment.id}
                      className="flex items-center justify-between gap-2 rounded-lg bg-muted border border-border px-3 py-2"
                    >
                      <div className="flex items-center gap-2 text-sm">
                        <CreditCard className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="font-medium text-foreground tabular-nums">
                          {formatCurrencyAmount(
                            Number(payment.amount),
                            payment.currency?.toString() ?? "INR",
                          )}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {format(new Date(payment.createdAt), "d MMM yyyy")}
                        </span>
                      </div>
                      <StatusBadge
                        {...paymentStatusBadge(
                          payment.paymentStatus as PaymentDisplayStatus,
                        )}
                        size="sm"
                      />
                    </div>
                  ))}
                  {orgName && (
                    <p className="text-xs text-muted-foreground">
                      This booking is sponsored by <strong>{orgName}</strong>.
                    </p>
                  )}
                  {/* #1428 — TENTATIVE (held pending payment) reaches this
                      branch too now, gated by the same `tentativeHoldCta`
                      the timeline row uses; PAY_NOW's existing (role-agnostic)
                      behaviour is unchanged. */}
                  {((vm.needsActionReason === "PAY_NOW" &&
                    vm.pendingPaymentUrl) ||
                    (vm.needsActionReason === "TENTATIVE" &&
                      tentativeCta === "PAY")) && (
                    <Button
                      size="sm"
                      className="w-full bg-amber-500 hover:bg-amber-600 text-white dark:bg-amber-600 dark:hover:bg-amber-500"
                      onClick={openPendingPayment}
                    >
                      <CreditCard className="h-4 w-4 mr-2" />
                      Pay Now to Confirm
                    </Button>
                  )}
                  {vm.needsActionReason === "TENTATIVE" &&
                    tentativeCta === "REBOOK" && (
                      <div className="space-y-2 rounded-lg border border-border bg-muted px-3 py-2">
                        <p className="text-xs text-muted-foreground">
                          The payment window for this hold closed, so the slot
                          is released unless you book it again.
                        </p>
                        {/* Back to the consultant's profile rather than a
                            deep link to the old slot: that time may already
                            be taken, and the picker is where a live one is
                            chosen. */}
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full"
                          asChild
                        >
                          <Link
                            href={
                              vm.consultantProfileId
                                ? `/explore/experts/${vm.consultantProfileId}`
                                : "/explore/experts"
                            }
                          >
                            <CreditCard className="h-4 w-4 mr-2" />
                            Start a new checkout
                          </Link>
                        </Button>
                      </div>
                    )}
                </div>
              )}
            </Section>

            {role === "consultant" && (
              <Section title="Participants">
                {participants.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No participants on this session yet.
                  </p>
                ) : (
                  <div className="mb-3 flex flex-wrap gap-2">
                    {previewParticipants.map((u) => (
                      <span
                        key={u.id}
                        className="flex items-center gap-1.5 rounded-full border border-border bg-muted py-0.5 pl-1 pr-2.5 text-xs text-foreground"
                      >
                        <Avatar className="h-5 w-5">
                          <AvatarImage
                            src={u.image ?? undefined}
                            alt={u.name}
                          />
                          <AvatarFallback className="text-[9px]">
                            {initials(u.name) || "?"}
                          </AvatarFallback>
                        </Avatar>
                        {u.name}
                      </span>
                    ))}
                    {hiddenParticipantCount > 0 && (
                      <span className="inline-flex items-center rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
                        +{hiddenParticipantCount} more
                      </span>
                    )}
                  </div>
                )}
                {manageHref && (
                  <Button variant="outline" size="sm" asChild>
                    <Link href={manageHref}>
                      <Users className="mr-1.5 h-3.5 w-3.5" />
                      Manage participants
                    </Link>
                  </Button>
                )}
              </Section>
            )}
          </div>

          <aside className="min-w-0 lg:sticky lg:top-20">
            <Section title="Resources">
              <div className="space-y-5">
                <ResourceSubgroup title="Documents" icon={FileText}>
                  {renderDocuments ? (
                    renderDocuments(vm)
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Documents for this booking will appear here.
                    </p>
                  )}
                </ResourceSubgroup>

                <div className="border-t border-border" />

                <ResourceSubgroup title="Recordings" icon={Video}>
                  {recordings.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Recordings of completed sessions will appear here.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {recordings.map((rec) => (
                        <div
                          key={rec.id}
                          className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted px-3 py-2"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground">
                              {rec.title}
                            </p>
                            <p className="text-[11px] text-muted-foreground">
                              {format(rec.recordedAt, "d MMM yyyy")} ·{" "}
                              {rec.durationInMinutes} min
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <StatusBadge
                              {...recordingStatusBadge(rec.status)}
                              size="sm"
                            />
                            {rec.url && (
                              <Button variant="outline" size="sm" asChild>
                                <a
                                  href={rec.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  Watch
                                  <ExternalLink className="ml-1 h-3 w-3" />
                                </a>
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </ResourceSubgroup>
              </div>
            </Section>
          </aside>
        </div>
      </div>

      {/* Mounted HERE, not by each caller. This component renders the overflow
          menu whose every item opens one of these dialogs, so making the host
          remember to mount them separately is a contract that gets forgotten —
          and was: the consultee's detail page never did, leaving Reschedule,
          Cancel and Report issue setting state nothing was listening for. */}
      {adapter.renderDialogs()}
    </DashboardErrorBoundary>
  );
}
