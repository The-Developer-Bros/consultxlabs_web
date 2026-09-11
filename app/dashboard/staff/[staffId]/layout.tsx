import { redirect } from "next/navigation";
import { requireOnboarded } from "@/lib/auth-guard";
import { StaffShell } from "./StaffShell";

/**
 * Server-side guard for the staff dashboard.
 *
 * Access is enforced here, on the server, before any dashboard markup ships
 * to the client. This preserves the previous client-side rule exactly — an
 * ADMIN or STAFF user, or the user whose own `staffProfileId` matches the URL
 * segment, may enter; anyone else is redirected to `/dashboard` (which routes
 * them to their own role home). The old layout enforced this only after
 * hydration, via `useSession()` + a `fetchUserDetails` query + a
 * `router.replace` — shipping the protected shell to unauthorized users first.
 *
 * User identity (name/email/image) is read from the server session and passed
 * to the client shell as props (no `useSession()` first-render null → no
 * hydration mismatch on the displayed name).
 */
export default async function StaffDashboardLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ staffId: string }>;
}) {
  const { staffId } = await params;
  const session = await requireOnboarded();

  const { role, staffProfileId } = session.user;
  const hasStaffAccess =
    role === "ADMIN" || role === "STAFF" || staffProfileId === staffId;
  if (!hasStaffAccess) {
    redirect("/dashboard");
  }

  return (
    <StaffShell
      staffId={staffId}
      userName={session.user.name ?? null}
      userEmail={session.user.email ?? null}
      userImage={session.user.image ?? null}
    >
      {children}
    </StaffShell>
  );
}
