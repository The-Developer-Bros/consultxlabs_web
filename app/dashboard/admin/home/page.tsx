import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import AdminHomePageClient from "./AdminHomePageClient";
import { getAdminStats } from "@/lib/data/admin-stats";

export default async function AdminHomePage() {
  const queryClient = new QueryClient();

  // #890 — SSR prefetch the admin stats so the client useQuery hydrates
  // without a fetch waterfall. queryKey ["admin-stats"] MUST match the
  // client in AdminHomePageClient. allSettled so a read failure degrades to
  // a client-side fetch rather than crashing the route.
  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: ["admin-stats"],
      queryFn: getAdminStats,
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <AdminHomePageClient />
    </HydrationBoundary>
  );
}
