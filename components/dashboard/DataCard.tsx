"use client";

import Image from "next/image";
import { cn } from "@/utils/tailwind";
import { motion } from "framer-motion";
import { LucideIcon, ChevronRight } from "lucide-react";
import Link from "next/link";
import { ReactNode } from "react";

interface DataCardProps {
  title: string;
  icon?: LucideIcon;
  headerAction?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  viewAllLink?: string;
  viewAllText?: string;
  className?: string;
  noPadding?: boolean;
}

export function DataCard({
  title,
  icon: Icon,
  headerAction,
  children,
  footer,
  viewAllLink,
  viewAllText = "View all",
  className,
  noPadding = false,
}: DataCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className={cn(
        "overflow-hidden rounded-xl border border-zinc-200/80 bg-white shadow-sm",
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
        <div className="flex items-center gap-3">
          {Icon && (
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-100">
              <Icon className="h-4.5 w-4.5 text-zinc-600" />
            </div>
          )}
          <h3 className="font-semibold text-zinc-900">{title}</h3>
        </div>
        {headerAction}
      </div>

      {/* Content */}
      <div className={cn(!noPadding && "p-5")}>{children}</div>

      {/* Footer */}
      {(footer || viewAllLink) && (
        <div className="border-t border-zinc-100 px-5 py-3">
          {footer || (
            <Link
              href={viewAllLink!}
              className="group flex items-center justify-center gap-1 text-sm font-medium text-zinc-500 hover:text-zinc-900 transition-colors"
            >
              {viewAllText}
              <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          )}
        </div>
      )}
    </motion.div>
  );
}

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      {Icon && (
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-muted">
          <Icon className="h-7 w-7 text-muted-foreground/70" />
        </div>
      )}
      <h4 className="text-base font-medium text-foreground">{title}</h4>
      {description && (
        <p className="mt-1 text-sm text-muted-foreground max-w-sm">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

interface ActivityItemProps {
  avatar?: string;
  name: string;
  action: string;
  time: string;
  onClick?: () => void;
}

export function ActivityItem({
  avatar,
  name,
  action,
  time,
  onClick,
}: ActivityItemProps) {
  const initials = name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase();

  return (
    <div
      className={cn(
        "flex items-center gap-3 py-3",
        onClick &&
          "cursor-pointer hover:bg-zinc-50 -mx-2 px-2 rounded-lg transition-colors",
      )}
      onClick={onClick}
    >
      <div className="h-9 w-9 rounded-full bg-zinc-100 flex items-center justify-center overflow-hidden shrink-0">
        {avatar ? (
          <Image src={avatar} alt={name} width={36} height={36} className="h-full w-full object-cover" />
        ) : (
          <span className="text-xs font-medium text-zinc-600">{initials}</span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-zinc-900">
          <span className="font-medium">{name}</span>{" "}
          <span className="text-zinc-500">{action}</span>
        </p>
        <p className="text-xs text-zinc-400">{time}</p>
      </div>
    </div>
  );
}

export function DataCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white shadow-sm">
      <div className="flex items-center gap-3 border-b border-zinc-100 px-5 py-4">
        <div className="h-9 w-9 animate-pulse rounded-lg bg-zinc-200" />
        <div className="h-5 w-32 animate-pulse rounded bg-zinc-200" />
      </div>
      <div className="p-5 space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="h-9 w-9 animate-pulse rounded-full bg-zinc-200" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-3/4 animate-pulse rounded bg-zinc-200" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-zinc-200" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
