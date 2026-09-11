import { PaymentsPage } from "@/components/dashboard/shared/PaymentsPage";

/** Payment list — shared with the staff tree. Refunds are their own route. */
export default function AdminPaymentsPage() {
  return <PaymentsPage basePath="/dashboard/admin" />;
}
