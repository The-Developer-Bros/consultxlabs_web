import { PaymentDetailPage } from "@/components/dashboard/shared/PaymentDetailPage";

export default async function AdminPaymentDetailRoute({
  params,
}: {
  params: Promise<{ paymentId: string }>;
}) {
  const { paymentId } = await params;
  return <PaymentDetailPage paymentId={paymentId} basePath="/dashboard/admin" />;
}
