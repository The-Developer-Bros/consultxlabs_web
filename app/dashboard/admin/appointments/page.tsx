import { OperatorAppointmentsPage } from "@/components/dashboard/shared/OperatorAppointmentsPage";

/** Platform-wide appointment triage — shared with the staff tree. */
export default function AdminAppointmentsPage() {
  // Platform-wide by design: operators triage every tenant. Stated
  // explicitly so the widest scope on the platform is never a default (#674).
  return <OperatorAppointmentsPage scope={{ kind: "all" }} />;
}
