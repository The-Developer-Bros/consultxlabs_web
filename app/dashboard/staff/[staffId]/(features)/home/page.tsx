import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import HomePageClient from "./HomePageClient";
import { getStaffStats } from "@/lib/data/staff-stats";

type PageProps = {
  params: Promise<{ staffId: string }>;
};

export default async function StaffHomePage({ params }: Readonly<PageProps>) {
  const { staffId } = await params;
  const queryClient = new QueryClient();

  // #890 — SSR prefetch so the client useQuery hydrates without a fetch
  // waterfall. Key MUST match the client: ["staff-stats"]. allSettled so a
  // read failure degrades to a client-side fetch rather than crashing the route.
  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: ["staff-stats"],
      queryFn: getStaffStats,
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <HomePageClient staffId={staffId} />
    </HydrationBoundary>
  );
}
