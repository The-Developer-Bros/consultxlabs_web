"use client";

import { InvoicesPage } from "@/components/dashboard/shared/InvoicesPage";

export default function StaffInvoicesPage() {
  return (
    <InvoicesPage
      apiEndpoint="/api/admin/invoices"
      title="Invoices"
      description="View platform payment invoices"
      showExport={true}
      queryKeyPrefix="staff-invoices"
    />
  );
}
