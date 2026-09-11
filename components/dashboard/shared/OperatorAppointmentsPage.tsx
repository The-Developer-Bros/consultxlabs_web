import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import { OperatorAppointmentsClient } from "./OperatorAppointmentsClient";
import { getStaffAppointments } from "@/lib/data/staff-appointments";
import type { Scope } from "@/lib/api/scope/parse";

/**
 * `scope` is passed in rather than defaulted so each operator tree states what
 * it is looking at (#674 defect 13). Both callers pass `{ kind: "all" }` — the
 * platform-wide triage view these pages exist for.
 */
export async function OperatorAppointmentsPage({ scope }: { scope: Scope }) {
  const queryClient = new QueryClient();

  // #890 — SSR prefetch the DEFAULT view (page 1, no filters) so the client
  // useQuery hydrates without a fetch waterfall. The queryKey object MUST match
  // the client's default in AppointmentsPageClient: ["staff-appointments",
  // { page: 1, type: "all", status: "all", search: "" }]. Filtered/paged views
  // fall back to a client fetch (acceptable). allSettled so a read failure
  // degrades to a client-side fetch rather than crashing the route.
  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: [
        "staff-appointments",
        { page: 1, type: "all", status: "all", search: "" },
      ],
      queryFn: () => getStaffAppointments({ page: 1, scope }),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <OperatorAppointmentsClient />
    </HydrationBoundary>
  );
}
