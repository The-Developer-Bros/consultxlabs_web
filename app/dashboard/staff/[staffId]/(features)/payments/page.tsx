import { PaymentsPage } from "@/components/dashboard/shared/PaymentsPage";

/** Payment list — shared with the admin tree. Refunds are their own route. */
export default async function StaffPaymentsPage({
  params,
}: {
  params: Promise<{ staffId: string }>;
}) {
  const { staffId } = await params;
  return <PaymentsPage basePath={`/dashboard/staff/${staffId}`} />;
}
