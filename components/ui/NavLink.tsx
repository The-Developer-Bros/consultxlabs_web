"use client";

import React from "react";
import Link, { useLinkStatus } from "next/link";
import { Loader2, type LucideIcon } from "lucide-react";
import { cn } from "@/utils/tailwind";

/**
 * Pending affordance. MUST be rendered as a DESCENDANT of <Link> for
 * useLinkStatus() to read that Link's navigation state (#15.5 contract).
 *
 * Debounced: the spinner starts at opacity-0 and fades in over a ~120ms
 * delayed transition, so it only becomes visible on slow navigations and
 * fast cache-hit navigations never flash it.
 */
function PendingIndicator({ className }: { className?: string }) {
  const { pending } = useLinkStatus();

  return (
    <Loader2
      aria-hidden
      className={cn(
        "h-3.5 w-3.5 shrink-0 animate-spin transition-opacity duration-150 [transition-delay:120ms] motion-reduce:animate-none",
        pending ? "opacity-100" : "opacity-0",
        className,
      )}
    />
  );
}

/**
 * Icon-swap variant of the pending affordance for icon-led nav items
 * (sidebar rows, mobile tab bars): the item's own icon flips to a spinner
 * while its enclosing Link's navigation is in flight. Same #15.5 contract —
 * MUST be a descendant of the <Link> it reports on. Single shared
 * implementation for every dashboard shell (sidebar, personal mobile tabs,
 * org mobile tabs) so the subtle useLinkStatus contract can't drift.
 */
export function LinkPendingIcon({
  Icon,
  className = "h-5 w-5 flex-shrink-0",
}: {
  Icon: LucideIcon;
  className?: string;
}) {
  const { pending } = useLinkStatus();
  return pending ? (
    <Loader2
      className={cn(className, "animate-spin motion-reduce:animate-none")}
      aria-hidden
    />
  ) : (
    <Icon className={className} />
  );
}

export interface NavLinkProps
  extends Omit<React.ComponentProps<typeof Link>, "href"> {
  href: React.ComponentProps<typeof Link>["href"];
  children: React.ReactNode;
  /** Extra classes applied to the inline pending spinner. */
  indicatorClassName?: string;
}

/**
 * A drop-in <Link> that renders its children plus a debounced inline pending
 * spinner while a navigation to its href is in flight. Generic enough for the
 * sidebar — callers keep full control of layout/active styling via children.
 */
export function NavLink({
  href,
  children,
  className,
  indicatorClassName,
  ...rest
}: NavLinkProps) {
  return (
    <Link href={href} className={className} {...rest}>
      {children}
      <PendingIndicator className={indicatorClassName} />
    </Link>
  );
}

export default NavLink;
