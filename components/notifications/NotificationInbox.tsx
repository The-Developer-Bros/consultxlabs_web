"use client";

import { useMemo, useState } from "react";
import { Bell, Inbox, InboxContent } from "@novu/nextjs";
import { Bell as BellIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const NOVU_APP_ID = process.env.NEXT_PUBLIC_NOVU_APP_ID;

type OrgMembershipLite = {
  organizationId: string;
  organizationName: string;
};

export function NotificationInbox() {
  const router = useRouter();
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);

  const memberships = useMemo(() => {
    const raw = (session?.user as Record<string, unknown> | undefined)
      ?.organizationMemberships;
    if (!Array.isArray(raw)) return [] as OrgMembershipLite[];
    // Validate rather than coerce. `String(someObject)` yields
    // "[object Object]", which would become a tab filter matching nothing and a
    // label rendering that literal — a malformed entry should drop out, not
    // produce a broken tab. (Also the SonarCloud finding on this block.)
    return raw.flatMap((m): OrgMembershipLite[] => {
      if (typeof m !== "object" || m === null) return [];
      const { organizationId, organizationName } = m as Record<string, unknown>;
      if (typeof organizationId !== "string" || organizationId === "") return [];
      return [
        {
          organizationId,
          organizationName:
            typeof organizationName === "string" && organizationName !== ""
              ? organizationName
              : "Organization",
        },
      ];
    });
  }, [session?.user]);

  /**
   * ADR 23 — one subscriber per user means every context shares a feed. Tabs
   * filter it back apart on the `scope` / `organizationId` the payloads now
   * carry.
   *
   * Only rendered for someone who actually belongs to an organization: a purely
   * B2C consultant has one context, and an "All / Personal" pair that always
   * shows the same list is noise. `scope` exists precisely so this filter can be
   * written — Novu matches payload fields by equality, and "organizationId is
   * null" is not expressible that way.
   */
  const tabs = useMemo(() => {
    if (memberships.length === 0) return undefined;
    return [
      { label: "All", filter: {} },
      { label: "Personal", filter: { data: { scope: "personal" } } },
      ...memberships.map((m) => ({
        label: m.organizationName,
        filter: { data: { organizationId: m.organizationId } },
      })),
    ];
  }, [memberships]);

  if (!session?.user?.id || !NOVU_APP_ID) {
    return null;
  }

  /**
   * Novu's bundled popover is deliberately not used. Given children, `Inbox`
   * drops to a provider and the panel becomes ours to place, which is what the
   * calendar needed: its own popover took a fixed 400px at a bespoke z-index of
   * 9999, could not be closed programmatically, and so stayed parked over the
   * Friday and Saturday columns of the slot grid after a notification click
   * navigated there.
   *
   * The repo's Radix popover fixes the placement (collision-aware, capped at
   * the viewport, on the shared z-layer) and, because the open state is ours,
   * the panel dismisses itself before routing rather than following the user
   * onto the page they asked for.
   */
  return (
    <Inbox
      applicationIdentifier={NOVU_APP_ID}
      subscriberId={session.user.id}
      tabs={tabs}
      appearance={{
        variables: {
          colorBackground: "#ffffff",
          colorForeground: "#18181b",
          colorPrimary: "#18181b",
          colorPrimaryForeground: "#ffffff",
          colorSecondary: "#f4f4f5",
          colorSecondaryForeground: "#3f3f46",
          colorCounter: "#ef4444",
          colorCounterForeground: "#ffffff",
          colorNeutral: "#a1a1aa",
          colorShadow: "rgba(0, 0, 0, 0.08)",
          fontSize: "0.875rem",
          borderRadius: "0.5rem",
        },
        elements: {
          // Novu's InboxContent is height:auto by default. When the Radix
          // popover was `overflow-y-auto` + shrink-to-content, a short feed
          // made the whole panel squat and tabs ("LearnPro Academy") overflowed
          // sideways. Give Novu a filled column and scroll the *list* only.
          inboxContent: {
            height: "100%",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            minWidth: 0,
          },
          // Org tab labels can be long; horizontal scroll here is fine —
          // vertical scroll must stay on the notification list below.
          tabsList: {
            flexShrink: 0,
            overflowX: "auto",
            overflowY: "hidden",
            minWidth: 0,
          },
          notificationList: {
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            overflowX: "hidden",
          },
          notification: {
            padding: "12px 16px",
            gap: "12px",
            minWidth: 0,
          },
          // Long reminder copy was forcing horizontal overflow; wrap instead.
          notificationSubject: {
            overflowWrap: "anywhere",
            wordBreak: "break-word",
          },
          notificationBody: {
            overflowWrap: "anywhere",
            wordBreak: "break-word",
          },
        },
      }}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Notifications"
            aria-haspopup="dialog"
            className="relative inline-flex h-9 w-9 items-center justify-center rounded-md text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-50"
          >
            <Bell
              renderBell={(unreadCount) => {
                const count = unreadCount?.total ?? 0;
                return (
                  <span className="relative flex items-center justify-center">
                    <BellIcon className="h-5 w-5" />
                    {count > 0 && (
                      <span
                        role="status"
                        aria-label={`${count} unread notifications`}
                        className="absolute -top-2 -right-2 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white"
                      >
                        {count > 99 ? "99+" : count}
                      </span>
                    )}
                  </span>
                );
              }}
            />
          </button>
        </PopoverTrigger>
        {/* Restore ~400px width (was narrowed to 22rem and felt cramped). Fixed
            height + overflow-hidden so the panel does not shrink-wrap content
            and invent a horizontal scrollbar; list scroll is configured above. */}
        <PopoverContent
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="flex h-[min(36rem,calc(100vh-5rem))] w-[min(400px,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] flex-col overflow-hidden p-0"
        >
          <InboxContent
            onNotificationClick={(notification) => {
              const url = notification?.redirect?.url;
              // Closed first: the panel must not still be sitting over the
              // grid it just sent the user to.
              setOpen(false);
              if (url) {
                router.push(url);
              }
            }}
          />
        </PopoverContent>
      </Popover>
    </Inbox>
  );
}
