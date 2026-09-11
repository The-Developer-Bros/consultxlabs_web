import { OrgSupportTriage } from "./OrgSupportTriage";

/**
 * #support-hub — org support triage: CSAT aggregate + members' conversation
 * metadata (never transcripts, ADR 20) + the org-party dispute entry.
 * Gated `operations.read` in the page guard and the API routes.
 */
export default async function OrgSupportPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  return <OrgSupportTriage orgId={orgId} />;
}
