import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";

import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { getConsultantAppointments } from "@/lib/data/consultant-appointments";
import { buildConsultantEarningsPayload } from "@/lib/data/consultant-earnings-analytics";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";

import { EarningsTabs } from "./EarningsTabs";

type PageProps = {
  params: Promise<{ consultantId: string }>;
};

/**
 * /dashboard/consultant/[consultantId]/earnings — Summary + Analytics.
 *
 * This route was a client component until Analytics folded into it (ADR 19).
 * It is a server component now so the Analytics panel keeps the SSR prefetch it
 * had as its own page; the Summary panel still fetches on the client, as it
 * always did.
 */
export default async function EarningsPage({ params }: Readonly<PageProps>) {
  const { consultantId } = await params;
  // Ownership is enforced HERE, not by the layout: the layout is a client
  // component, so its check runs after this server render has already read
  // and streamed the data. See lib/auth/personal-dashboard-access.ts.
  await requirePersonalProfileAccess("consultant", consultantId);
  const queryClient = new QueryClient();

  // Keys MUST match AnalyticsPageClient's useQuery keys exactly or hydration
  // won't apply. allSettled so a failed read degrades to a client-side fetch
  // rather than crashing the whole page.
  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: ["consultant-earnings-analytics", consultantId],
      queryFn: () =>
        // #org-appts (#1024) — personal dashboard = B2C-only VIEW.
        // Explicit to match the client's default (unset orgScope).
        buildConsultantEarningsPayload(consultantId, {
          limit: 1,
          includeMonthly: true,
          organizationId: null,
        }),
    }),
    queryClient.prefetchQuery({
      queryKey: ["consultant-appointments", consultantId, "personal"],
      queryFn: () =>
        getConsultantAppointments({
          consultantProfileId: consultantId,
          scope: { kind: "personal" },
        }),
    }),
  ]);

  return (
    <>
      <DashboardHeader
        title="Earnings"
        subtitle="Income and performance across your practice"
      />
      <HydrationBoundary state={dehydrate(queryClient)}>
        <EarningsTabs consultantId={consultantId} />
      </HydrationBoundary>
    </>
  );
}
