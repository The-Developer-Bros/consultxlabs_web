import { redirect } from "next/navigation";

type PageProps = {
  params: Promise<{ consultantId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

/**
 * Server-side redirect to the consultant home tab. Resolves during the RSC
 * render — one hop, no skeleton paint + hydration + client replace chain
 * (the old client stub flashed skeletons on every direct visit to
 * /dashboard/consultant/<id>).
 */
export default async function ConsultantDashboard({ params }: Readonly<PageProps>) {
  const { consultantId } = await params;
  redirect(`/dashboard/consultant/${consultantId}/home`);
}
