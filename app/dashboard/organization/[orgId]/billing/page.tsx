import { requireOrgAccess } from "@/lib/auth-helpers";
import {
  getOrgReceivables,
  type OrgReceivablesPayload,
} from "@/lib/data/org-receivables";

import { BillingPageClient } from "./BillingPageClient";

export default async function OrgBillingPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  // #1319 — the receivables read is server-side, so it carries the same gate as
  // GET /api/organizations/[orgId]/billing rather than inheriting the layout's.
  // The gate scopes the new section only: the client component runs its own
  // `useRequireOrgAccess` for everything it already rendered, and passing null
  // here leaves that behaviour exactly as it was.
  const access = await requireOrgAccess(orgId, {
    permission: "billing.read",
    canSponsor: true,
  });
  const receivables: OrgReceivablesPayload | null = access.error
    ? null
    : await getOrgReceivables(orgId);

  return <BillingPageClient orgId={orgId} receivables={receivables} />;
}
