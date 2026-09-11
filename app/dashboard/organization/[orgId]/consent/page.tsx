"use client";

/**
 * /dashboard/organization/[orgId]/consent
 *
 * DPDP (Digital Personal Data Protection Act 2023) consent-artifact
 * dashboard. Lists this org's `ConsentArtifact`s (active + withdrawn
 * history) and lets an admin grant / withdraw consent on behalf of a
 * member. Withdrawal is exposed at exactly the same prominence as grant
 * — DPDP §6(4) requires that withdrawing consent be as easy as giving it.
 *
 * Gated via the org permission matrix (consent.read) so OWNER + MAINTAINER +
 * BILLING_ADMIN + MANAGER reach it (mirrors the DPDP data-exports sibling
 * and the MANAGER floor on /api/organizations/[orgId]/consent). Self-
 * service withdrawal from a member's own account settings is a separate
 * route (#681 follow-up); this is the org-admin compliance surface.
 *
 * Withdrawal is irreversible in our model: a re-grant goes through POST
 * and mints a NEW artifact with a fresh hash, keeping chain-of-custody
 * intact for auditors.
 */

import { use, useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRequireOrgAccess } from "../useOrgRole";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import {
  ALL_PURPOSE_CODES,
  PURPOSE_CODE_META,
  PURPOSE_CODES,
} from "@/lib/compliance/purpose-codes";

type ConsentArtifact = {
  id: string;
  userId: string;
  dataFiduciary: string;
  purposeCodes: string[];
  grantedAt: string;
  withdrawnAt: string | null;
  language: string;
  consentManager: string | null;
  version: number;
  hash: string;
};

type Member = {
  user: { id: string; name: string | null; email: string };
  role: string;
};

// Granular purpose taxonomy — the SINGLE canonical set shared with the
// runtime gate (lib/compliance/purpose-codes.ts). The dashboard offers each
// canonical code as a one-click toggle; crucially the Stream toggle now
// grants/withdraws STREAM_DATA_PROCESSING, so a user CAN re-grant the consent
// the fail-closed video/chat gate reads. Free-form codes are still accepted by
// the API, but the UI only ever emits canonical codes.

// Schedule VIII languages we surface in v1 (English + the most common
// Indian-enterprise locales). The API accepts any ISO 639-1/2 code.
const LANGUAGES: Array<{ code: string; label: string }> = [
  { code: "en", label: "English" },
  { code: "hi", label: "हिन्दी (Hindi)" },
  { code: "bn", label: "বাংলা (Bengali)" },
  { code: "ta", label: "தமிழ் (Tamil)" },
  { code: "te", label: "తెలుగు (Telugu)" },
  { code: "mr", label: "मराठी (Marathi)" },
];

const NOTICE_VERSION = 1;

type PageProps = { params: Promise<{ orgId: string }> };

// Client-only locale date — toLocaleString() differs between the SSR (server
// TZ/locale) and client render, which trips React hydration. Render after mount
// so the formatted value only ever appears client-side.
function LocalDateTime({ value }: { value: string | Date | null | undefined }) {
  const [text, setText] = useState("");
  useEffect(() => {
    setText(value ? new Date(value).toLocaleString() : "—");
  }, [value]);
  return <span suppressHydrationWarning>{text || "—"}</span>;
}

export default function ConsentPage({ params }: Readonly<PageProps>) {
  const { orgId } = use(params);
  const { allowed, isLoading: isGateLoading } = useRequireOrgAccess(orgId, { permission: "consent.read" });
  const qc = useQueryClient();

  // Grant-form state. Minimal local state (no RHF) — one member picker,
  // a purpose-code toggle list, and a language select.
  const [grantUserId, setGrantUserId] = useState("");
  const [grantPurposes, setGrantPurposes] = useState<Set<string>>(
    new Set([PURPOSE_CODES.PRIMARY_PROCESSING]),
  );
  const [grantLanguage, setGrantLanguage] = useState("en");
  const [actionError, setActionError] = useState<string | null>(null);

  const members = useQuery<Member[]>({
    queryKey: ["org-members", orgId, "consent-grant"],
    queryFn: async () => {
      const res = await fetch(
        `/api/organizations/${orgId}/members?perPage=100`,
      );
      if (!res.ok) throw new Error("Failed to load members");
      const body = (await res.json()) as { data: Member[] };
      return body.data;
    },
    enabled: allowed,
  });

  const consents = useQuery<ConsentArtifact[]>({
    queryKey: ["org-consents", orgId],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}/consent?limit=200`);
      if (!res.ok) throw new Error("Failed to load consent artifacts");
      const body = (await res.json()) as { data: ConsentArtifact[] };
      return body.data;
    },
    enabled: allowed,
  });

  // Map userId → display label so the artifact table can show who the
  // data principal is without spelling out the raw id.
  const memberLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members.data ?? []) {
      map.set(m.user.id, m.user.name || m.user.email);
    }
    return map;
  }, [members.data]);

  const grant = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}/consent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: grantUserId,
          purposeCodes: Array.from(grantPurposes),
          language: grantLanguage,
          version: NOTICE_VERSION,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to record consent");
      return body.consent as ConsentArtifact;
    },
    onSuccess: () => {
      setActionError(null);
      setGrantUserId("");
      setGrantPurposes(new Set([PURPOSE_CODES.PRIMARY_PROCESSING]));
      setGrantLanguage("en");
      qc.invalidateQueries({ queryKey: ["org-consents", orgId] });
    },
    onError: (err) => setActionError(err.message),
  });

  // Withdrawal scopes to a single purposeCode when provided; omitting it
  // is the full DPDP §12 opt-out. The DELETE endpoint is idempotent.
  const withdraw = useMutation({
    mutationFn: async (vars: { userId: string; purposeCode?: string }) => {
      const qs = new URLSearchParams({ userId: vars.userId });
      if (vars.purposeCode) qs.set("purposeCode", vars.purposeCode);
      const res = await fetch(
        `/api/organizations/${orgId}/consent?${qs.toString()}`,
        { method: "DELETE" },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to withdraw consent");
      return body as { withdrawnCount: number };
    },
    onSuccess: () => {
      setActionError(null);
      qc.invalidateQueries({ queryKey: ["org-consents", orgId] });
    },
    onError: (err) => setActionError(err.message),
  });

  if (isGateLoading || !allowed) return null;

  const togglePurpose = (code: string) => {
    setGrantPurposes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  // Friendly label for a stored code; falls back to the raw value so any
  // legacy/free-form code still renders.
  const purposeLabel = (code: string) =>
    PURPOSE_CODE_META[code as keyof typeof PURPOSE_CODE_META]?.label ?? code;

  const rows = consents.data ?? [];
  const active = rows.filter((r) => r.withdrawnAt === null);
  const history = rows.filter((r) => r.withdrawnAt !== null);

  const canGrant =
    grantUserId !== "" && grantPurposes.size > 0 && !grant.isPending;

  const memberCell = (row: ConsentArtifact) =>
    memberLabel.get(row.userId) ?? (
      <span className="font-mono text-xs text-muted-foreground">
        {row.userId}
      </span>
    );

  const activeColumns: ResponsiveColumn<ConsentArtifact>[] = [
    {
      key: "member",
      header: "Member",
      primary: true,
      className: "text-sm",
      cell: memberCell,
    },
    {
      key: "purposes",
      header: "Purposes",
      cell: (row) => (
        <div className="flex flex-wrap items-center gap-1">
          {row.purposeCodes.map((p) => (
            <Badge
              key={p}
              variant="secondary"
              className="bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
            >
              {purposeLabel(p)}
              <button
                type="button"
                title={`Withdraw "${purposeLabel(p)}"`}
                className="ml-1 text-emerald-700/70 hover:text-emerald-900 dark:text-emerald-300/70 dark:hover:text-emerald-200"
                disabled={withdraw.isPending}
                onClick={() =>
                  withdraw.mutate({
                    userId: row.userId,
                    purposeCode: p,
                  })
                }
              >
                ×
              </button>
            </Badge>
          ))}
        </div>
      ),
    },
    {
      key: "language",
      header: "Language",
      className: "text-xs uppercase text-muted-foreground",
      cell: (row) => row.language,
    },
    {
      key: "granted",
      header: "Granted",
      className: "text-xs text-muted-foreground",
      cell: (row) => <LocalDateTime value={row.grantedAt} />,
    },
    {
      key: "withdraw",
      header: "Withdraw",
      headClassName: "text-right",
      className: "text-right",
      cell: (row) => (
        <Button
          size="sm"
          variant="outline"
          disabled={withdraw.isPending}
          onClick={() => withdraw.mutate({ userId: row.userId })}
        >
          Withdraw all
        </Button>
      ),
    },
  ];

  const historyColumns: ResponsiveColumn<ConsentArtifact>[] = [
    {
      key: "member",
      header: "Member",
      primary: true,
      className: "text-sm",
      cell: memberCell,
    },
    {
      key: "purposes",
      header: "Purposes",
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.purposeCodes.map((p) => (
            <Badge
              key={p}
              variant="secondary"
              className="bg-muted text-muted-foreground"
            >
              {purposeLabel(p)}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      key: "granted",
      header: "Granted",
      className: "text-xs text-muted-foreground",
      cell: (row) => <LocalDateTime value={row.grantedAt} />,
    },
    {
      key: "withdrawn",
      header: "Withdrawn",
      className: "text-xs text-muted-foreground",
      cell: (row) => <LocalDateTime value={row.withdrawnAt} />,
    },
    {
      key: "status",
      header: "Status",
      cell: () => (
        <Badge className="bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300">
          Withdrawn
        </Badge>
      ),
    },
  ];

  return (
    <>
      <DashboardHeader
        title="DPDP consent"
        subtitle="Tamper-evident consent artifacts per the Digital Personal Data Protection Act 2023. Retained 7 years from grant or withdrawal."
      />
      <DashboardContent>
        {actionError && (
          <p className="mb-4 text-sm text-red-600">{actionError}</p>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Record consent</CardTitle>
            <CardDescription>
              Capture a member&apos;s consent for one or more processing
              purposes. Each grant mints a new hashed artifact; withdrawal is
              available below at the same prominence (DPDP §6(4)).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4 max-w-xl">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="consent-member">Member</Label>
                <Select value={grantUserId} onValueChange={setGrantUserId}>
                  <SelectTrigger id="consent-member">
                    <SelectValue
                      placeholder={
                        members.isLoading
                          ? "Loading members…"
                          : "Select a member"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {(members.data ?? []).map((m) => (
                      <SelectItem key={m.user.id} value={m.user.id}>
                        {m.user.name || m.user.email}
                        {m.user.name ? ` · ${m.user.email}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>Purposes</Label>
                <div className="flex flex-wrap gap-2">
                  {ALL_PURPOSE_CODES.map((code) => {
                    const on = grantPurposes.has(code);
                    const meta = PURPOSE_CODE_META[code];
                    return (
                      <button
                        key={code}
                        type="button"
                        title={meta.description}
                        onClick={() => togglePurpose(code)}
                        className={
                          on
                            ? "rounded-full border border-primary bg-primary/10 px-3 py-1 text-xs font-medium text-primary"
                            : "rounded-full border border-input px-3 py-1 text-xs text-muted-foreground hover:bg-muted"
                        }
                        aria-pressed={on}
                      >
                        {meta.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="consent-language">Notice language</Label>
                <Select value={grantLanguage} onValueChange={setGrantLanguage}>
                  <SelectTrigger id="consent-language" className="sm:w-64">
                    <SelectValue placeholder="Language" />
                  </SelectTrigger>
                  <SelectContent>
                    {LANGUAGES.map((l) => (
                      <SelectItem key={l.code} value={l.code}>
                        {l.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Button
                  disabled={!canGrant}
                  onClick={() => grant.mutate()}
                >
                  {grant.isPending ? "Recording…" : "Record consent"}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Active consents</CardTitle>
            <CardDescription>
              Currently-granted artifacts. Withdraw a single purpose or all
              purposes for a member — withdrawal stamps the artifact and stops
              downstream processing.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0 sm:p-4">
            {consents.isLoading ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Loading…
              </p>
            ) : (
              <ResponsiveTable<ConsentArtifact>
                columns={activeColumns}
                rows={active}
                getRowId={(row) => row.id}
                empty={
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No active consent artifacts yet.
                  </p>
                }
              />
            )}
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Withdrawal history</CardTitle>
            <CardDescription>
              Read-only record of withdrawn consents. Retained for the DPDP
              7-year audit window; a daily cron purges rows past retention.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0 sm:p-4">
            {consents.isLoading ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Loading…
              </p>
            ) : (
              <ResponsiveTable<ConsentArtifact>
                columns={historyColumns}
                rows={history}
                getRowId={(row) => row.id}
                empty={
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No withdrawn consents.
                  </p>
                }
              />
            )}
          </CardContent>
        </Card>
      </DashboardContent>
    </>
  );
}
