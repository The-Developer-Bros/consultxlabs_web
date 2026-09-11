import { SupportFeedbackPage } from "@/components/dashboard/shared/support/SupportPages";

export default async function FeedbackPage({
  params,
}: {
  params: Promise<{ consulteeId: string }>;
}) {
  const p = await params;
  return <SupportFeedbackPage profileId={p.consulteeId} />;
}
