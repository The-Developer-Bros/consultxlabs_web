import { redirect } from "next/navigation";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

/**
 * Server-side redirect to the consultee home tab. Resolves during the RSC
 * render — one hop, no skeleton paint + hydration + client replace chain
 * (the old client stub flashed PersonalDashboardShellSkeleton on every
 * direct visit to /dashboard/consultee/<id>).
 */
export default async function ConsulteePage({ params }: Readonly<PageProps>) {
  const { consulteeId } = await params;
  redirect(`/dashboard/consultee/${consulteeId}/home`);
}
