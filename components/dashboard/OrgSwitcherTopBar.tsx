"use client";

/**
 * Slim top-bar shell for org-context landing pages that don't have a
 * full sidebar of their own:
 *   - /dashboard/organization              (the switcher list)
 *   - /dashboard/organization/create       (create-org wizard)
 *   - /dashboard/org-workspace/[orgWorkspaceId]/*  (operator chooser)
 *
 * Each of those routes used to ship with a noop layout — no back link,
 * no user menu, no notification bell. Users had no way out of the page
 * except the browser back button. This component fixes that by giving
 * those layouts a single shared 64px header.
 *
 * Why a separate component instead of reusing /[orgId]/layout's chrome:
 * the operator dashboard's chrome is tightly coupled to a specific
 * Organization (org name in the title, capability badges in the
 * context bar, sidebar items derived from RateCard + funding source).
 * The switcher pages are explicitly *org-less* — there's nothing to
 * put in those slots.
 */

import Link from "next/link";
import { ArrowLeft, LogOut, User } from "lucide-react";

import { OrganizationSwitcher } from "@/components/dashboard/OrganizationSwitcher";
import { NotificationInbox } from "@/components/notifications/NotificationInbox";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOut, useSession } from "@/lib/auth-client";
import { resolvePersonalDashboardHref } from "@/lib/labels/personal-dashboard";
import { disconnectStreamClients } from "@/providers/StreamProvider";

/**
 * Render the top bar with: back link → personal dashboard,
 * OrganizationSwitcher, NotificationInbox, user menu.
 *
 * The back link uses `resolvePersonalDashboardHref` so a consultant
 * lands on /dashboard/consultant/<id>, a consultee on
 * /dashboard/consultee/<id>, an OrgWorkspace operator on its operator home, and a
 * user with none of those (rare — e.g. mid-onboarding) on /dashboard.
 *
 * `hideBackLink` lets the org-workspace layout suppress the back link
 * specifically for the OrgWorkspace chooser page (where "back to personal
 * dashboard" would loop the user right back to the same screen).
 */
export function OrgSwitcherTopBar({
  hideBackLink = false,
}: {
  hideBackLink?: boolean;
}) {
  const { data: session } = useSession();

  // `*ProfileId` fields live on the customSession-augmented user type
  // (lib/auth.ts:518-522). useSession()'s data is typed as the inferred
  // Session, so direct field access is type-safe.
  const personalHref = session?.user
    ? resolvePersonalDashboardHref({
        orgWorkspaceProfileId: session.user.orgWorkspaceProfileId,
        consultantProfileId: session.user.consultantProfileId,
        consulteeProfileId: session.user.consulteeProfileId,
      })
    : null;

  // Final back-link target. We accept "/dashboard" as the catch-all
  // when the resolver returns null (a user who hasn't completed
  // onboarding yet may have no profile). The catch-all renders a
  // role-routing page, so it's a safe non-loop default.
  const backHref = personalHref ?? "/dashboard";

  const handleSignOut = async () => {
    try {
      await disconnectStreamClients();
    } catch {
      // Stream cleanup is best-effort — never block the sign-out
      // because a chat client failed to disconnect cleanly.
    }
    signOut({
      fetchOptions: {
        onSuccess: () => {
          window.location.href = "/auth/signin";
        },
      },
    });
  };

  const userName = session?.user?.name ?? null;
  const userEmail = session?.user?.email ?? null;
  const userImage = session?.user?.image ?? null;
  const avatarFallback =
    userName?.charAt(0).toUpperCase() ??
    userEmail?.charAt(0).toUpperCase() ??
    "U";

  return (
    <div className="sticky top-0 z-30 flex h-14 items-center justify-between gap-2 border-b border-zinc-200/60 bg-white/80 px-4 backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/80 md:px-6">
      {/* Left: back link to personal dashboard. Suppressed on routes
          where the personal href would loop back to the same screen. */}
      <div className="flex min-w-0 items-center gap-2">
        {!hideBackLink && (
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 px-2 text-sm text-zinc-600 hover:text-zinc-900"
          >
            <Link href={backHref} aria-label="Back to dashboard">
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden sm:inline">Back to dashboard</span>
            </Link>
          </Button>
        )}
      </div>

      {/* Right: org switcher, notifications, user menu. */}
      <div className="flex items-center gap-1.5">
        <OrganizationSwitcher />
        <NotificationInbox />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="ml-1 inline-flex h-8 w-8 items-center justify-center rounded-full ring-offset-white transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2"
              aria-label="Open user menu"
            >
              <Avatar className="h-8 w-8">
                {userImage && (
                  <AvatarImage src={userImage} alt={userName ?? "User"} />
                )}
                <AvatarFallback>{avatarFallback}</AvatarFallback>
              </Avatar>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <div className="flex flex-col">
                <span className="text-sm font-medium">
                  {userName ?? "Signed in"}
                </span>
                {userEmail && (
                  <span className="truncate text-xs text-muted-foreground">
                    {userEmail}
                  </span>
                )}
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href={backHref}>
                <User className="mr-2 h-4 w-4" /> My personal dashboard
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                handleSignOut();
              }}
              className="text-red-600 focus:text-red-700"
            >
              <LogOut className="mr-2 h-4 w-4" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
