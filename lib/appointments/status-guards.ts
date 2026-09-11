/**
 * Consultee-side booking status guards — the implementation moved to
 * lib/appointments/status so the shared appointments VM layer can use it;
 * this module re-exports to keep existing feature imports stable.
 */

export {
  isInactiveStatus,
  isPendingPaymentStatus,
  isApprovedStatus,
  isConfirmedStatus,
  eventUnionStatusBadge,
} from "@/lib/appointments/status";
