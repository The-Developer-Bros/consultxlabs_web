import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/auth-guard";
import NovuProvider from "@/providers/NovuProvider";
import { OrgWorkspaceShell } from "./OrgWorkspaceShell";

/**
 * Server-side guard + chrome lift for the operator (cross-org) dashboard.
 *
 * IDOR guard: the orgWorkspaceId in the URL must match the authenticated
 * user's orgWorkspaceProfileId. We refuse to even hint that another user's
 * profile exists — URL-guessing returns the same 404 as a truly absent
 * id.
 *
 * Chrome: full CollapsibleSidebar (mirrors /dashboard/admin and
 * /dashboard/staff), with a top context bar carrying the
 * OrganizationSwitcher dropdown and the Novu notification bell. The
 * sidebar items live on OrgWorkspaceShell — keeping the layout thin so
 * the auth check stays server-side.
 *
 * User identity props (name/email/image) are read from the *server*
 * session here and passed down. The shell intentionally does NOT use
 * useSession() for these — the client hook returns null on the first
 * render and resolves later, which causes a hydration mismatch when
 * the sidebar renders the displayed name.
 */
export default async function OrgWorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgWorkspaceId: string }>;
}) {
  const { orgWorkspaceId } = await params;
  const session = await requireAuth();

  // `orgWorkspaceProfileId` lives on the inferred Session["user"] via the
  // customSession callback (lib/auth.ts). Direct access is type-safe.
  if (session.user.orgWorkspaceProfileId !== orgWorkspaceId) {
    notFound();
  }

  return (
    <NovuProvider>
      <OrgWorkspaceShell
        orgWorkspaceId={orgWorkspaceId}
        userName={session.user.name ?? null}
        userEmail={session.user.email ?? null}
        userImage={session.user.image ?? null}
      >
        {children}
      </OrgWorkspaceShell>
    </NovuProvider>
  );
}
