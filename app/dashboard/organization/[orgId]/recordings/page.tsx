import { redirect } from "next/navigation";

import { requireOrgAccess } from "@/lib/auth-helpers";

import { RecordingsClient } from "./RecordingsClient";

/**
 * /dashboard/organization/[orgId]/recordings — session recordings for events
 * run under this org.
 *
 * See the sibling documents page for why these are two routes rather than one
 * tabbed "Resources" page.
 */
export default async function OrgRecordingsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  const access = await requireOrgAccess(orgId, {
    permission: "operations.read",
  });
  if (access.error) {
    redirect(`/dashboard/organization/${orgId}/home`);
  }

  return <RecordingsClient orgId={orgId} />;
}
