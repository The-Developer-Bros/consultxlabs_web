import { PaymentDetailPage } from "@/components/dashboard/shared/PaymentDetailPage";

export default async function StaffPaymentDetailRoute({
  params,
}: {
  params: Promise<{ staffId: string; paymentId: string }>;
}) {
  const { staffId, paymentId } = await params;
  return (
    <PaymentDetailPage
      paymentId={paymentId}
      basePath={`/dashboard/staff/${staffId}`}
    />
  );
}
