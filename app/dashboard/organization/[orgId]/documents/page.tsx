import { redirect } from "next/navigation";

import { requireOrgAccess } from "@/lib/auth-helpers";

import { DocumentsClient } from "./DocumentsClient";

/**
 * /dashboard/organization/[orgId]/documents — documents uploaded against this
 * org's appointments, with the outcome of each review.
 *
 * Briefly a tab on a combined "Resources" page alongside Recordings. Split
 * back out: a group labelled Resources containing a single item also called
 * Resources is redundant nesting, and the two lists answer different
 * questions — this one is a review queue, Recordings is an archive.
 */
export default async function OrgDocumentsPage({
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

  return <DocumentsClient orgId={orgId} />;
}
