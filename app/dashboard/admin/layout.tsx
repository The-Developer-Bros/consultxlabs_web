import { requireUserRole } from "@/lib/auth-guard";
import { ENABLE_TDS_ADMIN_VIEW } from "@/lib/feature-flags";
import { AdminShell } from "./AdminShell";

/**
 * Server-side guard for the admin dashboard.
 *
 * Access is enforced here, on the server, before any dashboard markup ships
 * to the client: `requireUserRole("ADMIN")` redirects a non-admin to
 * `/dashboard` (which in turn routes them to their own role home) — for a
 * STAFF user that lands them in `/dashboard/staff/<id>/home`, their own tree.
 * This replaces the previous client-only pattern — a `useSession()` +
 * `useQuery` fetch of `/api/user/:id` followed by a post-hydration
 * `router.replace`, which shipped the protected shell to unauthorized users
 * before bouncing them.
 *
 * Deliberately ADMIN-only while the staff layout admits both roles: an admin
 * can drop into the staff tree to reproduce what an intern reports, but staff
 * never reach admin surfaces. Because nothing but ADMIN gets past this line,
 * every page below it is admin-only by construction and needs no second gate.
 *
 * The user identity (name/email/image) is read from the server session and
 * passed to the client shell as props, so the sidebar renders the same name
 * on the server HTML and the first client render (no hydration mismatch).
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireUserRole("ADMIN");

  return (
    <AdminShell
      userName={session.user.name ?? null}
      userEmail={session.user.email ?? null}
      userImage={session.user.image ?? null}
      showTds={ENABLE_TDS_ADMIN_VIEW}
    >
      {children}
    </AdminShell>
  );
}
