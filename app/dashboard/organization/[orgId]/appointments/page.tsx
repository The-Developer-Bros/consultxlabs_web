import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import { notFound } from "next/navigation";

import { requireOrgAccess } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import {
  getOrgAppointments,
  getOrgMemberAppointments,
} from "@/lib/data/org-appointments";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import StreamProvider from "@/providers/StreamProvider";

import { AppointmentsPageClient } from "./AppointmentsPageClient";
import {
  MyAppointmentsClient,
  type MyAppointmentItem,
} from "./MyAppointmentsClient";
import { ScopeToggle, type AppointmentScope } from "./ScopeToggle";

/**
 * /dashboard/organization/[orgId]/appointments — one destination, two scopes.
 *
 * This replaces the `appointments` + `my-appointments` pair that sat next to
 * each other in the sidebar under near-identical names. "Mine" is the member's
 * own participation (attending or delivering); "Everyone" is the org-wide
 * operations feed. Both data sources are unchanged — `getOrgMemberAppointments`
 * and `getOrgAppointments` respectively — only the entry point merged.
 *
 * Access floors at active membership, NOT at `operations.read`: a pure learner
 * has to be able to see their own sessions. The wider scope is gated
 * separately, and a viewer without it never sees the toggle at all, so the
 * page can't offer a control that would 403.
 */
export default async function OrgAppointmentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ scope?: string; page?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;

  // Floor at active membership — requireOrgAccess rejects non-members, and we
  // keep the URL tree honest with a 404 rather than leaking the shell.
  const access = await requireOrgAccess(orgId);
  if (access.error) {
    notFound();
  }

  const canReadAll = hasOrgPermission(access.member.role, "operations.read");

  // Default to "mine". An operator who wants the org feed asks for it; the
  // member view is the one every role can actually use. A non-operator asking
  // for "everyone" is quietly served their own — no error page for a URL they
  // could only have reached by editing it.
  const scope: AppointmentScope =
    canReadAll && sp.scope === "everyone" ? "everyone" : "mine";

  const rawPage = Number(sp.page ?? "1");
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;

  const header = (
    <DashboardHeader
      title="Appointments"
      subtitle={
        scope === "everyone"
          ? `All bookings made under ${access.org.name}.`
          : `Sessions you're attending or delivering under ${access.org.name}.`
      }
      actions={canReadAll ? <ScopeToggle scope={scope} /> : undefined}
    />
  );

  if (scope === "everyone") {
    const queryClient = new QueryClient();
    // #890 — prefetch only the default page; filtered/paged views diverge by
    // queryKey and fall back to the client fetch. The trailing `undefined` is
    // the appointmentType filter and MUST be present: the client's key carries
    // that slot, and ["...", 1] wouldn't match ["...", 1, undefined].
    await Promise.allSettled([
      queryClient.prefetchQuery({
        queryKey: ["org-appointments", orgId, page, undefined],
        queryFn: () => getOrgAppointments(orgId, { page }),
      }),
    ]);

    return (
      <>
        {header}
        <div className="p-4 sm:p-6 lg:p-8">
          <HydrationBoundary state={dehydrate(queryClient)}>
            <AppointmentsPageClient orgId={orgId} />
          </HydrationBoundary>
        </div>
      </>
    );
  }

  const userId = access.session.user.id;
  const { items, total, perPage } = await getOrgMemberAppointments(
    orgId,
    userId,
    { page },
  );

  return (
    <>
      {header}
      <div className="p-4 sm:p-6 lg:p-8">
        {/* Video-only Stream client, scoped to this subtree so Join has a
            connected client without connecting video on every org route. */}
        <StreamProvider userId={userId} enableChat={false} enableVideo={true}>
          <MyAppointmentsClient
            orgId={orgId}
            viewerId={userId}
            items={items as unknown as MyAppointmentItem[]}
            total={total}
            page={page}
            perPage={perPage}
          />
        </StreamProvider>
      </div>
    </>
  );
}
