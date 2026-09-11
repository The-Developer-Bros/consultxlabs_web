"use client";

import { cn } from "@/utils/tailwind";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { motion } from "framer-motion";
import { HelpCircle, LucideIcon } from "lucide-react";

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: LucideIcon;
  trend?: {
    value: number;
    isPositive: boolean;
  };
  tooltip?: string;
  variant?: "default" | "success" | "warning" | "danger" | "info";
  className?: string;
  onClick?: () => void;
}

export function StatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  trend,
  tooltip,
  variant = "default",
  className,
  onClick,
}: StatCardProps) {
  // Card surface is always the token `bg-card` (white in light, elevated dark
  // surface in dark). Only the icon chip + value colour vary by variant; the
  // coloured chips carry explicit dark variants so they don't read as a light
  // island on a dark card.
  const variants = {
    default: {
      iconBg: "bg-muted",
      iconColor: "text-muted-foreground",
      valueColor: "text-foreground",
    },
    success: {
      iconBg: "bg-emerald-50 dark:bg-emerald-950",
      iconColor: "text-emerald-600 dark:text-emerald-400",
      valueColor: "text-emerald-600 dark:text-emerald-400",
    },
    warning: {
      iconBg: "bg-amber-50 dark:bg-amber-950",
      iconColor: "text-amber-600 dark:text-amber-400",
      valueColor: "text-amber-600 dark:text-amber-400",
    },
    danger: {
      iconBg: "bg-red-50 dark:bg-red-950",
      iconColor: "text-red-600 dark:text-red-400",
      valueColor: "text-red-600 dark:text-red-400",
    },
    info: {
      iconBg: "bg-blue-50 dark:bg-blue-950",
      iconColor: "text-blue-600 dark:text-blue-400",
      valueColor: "text-blue-600 dark:text-blue-400",
    },
  };

  const v = variants[variant];

  return (
    <motion.div
      whileHover={{ y: -2, boxShadow: "0 8px 30px -12px rgba(0, 0, 0, 0.15)" }}
      transition={{ duration: 0.2 }}
      className={cn(
        "relative overflow-hidden rounded-xl border border-border bg-card p-5 transition-all",
        onClick && "cursor-pointer",
        className,
      )}
      onClick={onClick}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <p className="flex items-center gap-1 text-sm font-medium text-muted-foreground truncate">
            {title}
            {tooltip && (
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <HelpCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70 cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs text-xs">
                    {tooltip}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </p>
          <p
            className={cn(
              "mt-2 text-2xl font-bold tracking-tight",
              v.valueColor,
            )}
          >
            {value}
          </p>
          {subtitle && (
            <p className="mt-1 text-xs text-muted-foreground/70">{subtitle}</p>
          )}
          {trend && (
            <div className="mt-2 flex items-center gap-1">
              <span
                className={cn(
                  "inline-flex items-center text-xs font-medium",
                  trend.isPositive
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-red-600 dark:text-red-400",
                )}
              >
                {trend.isPositive ? "↑" : "↓"} {Math.abs(trend.value)}%
              </span>
              <span className="text-xs text-muted-foreground/70">
                vs last period
              </span>
            </div>
          )}
        </div>

        {Icon && (
          <div
            className={cn(
              "flex h-11 w-11 items-center justify-center rounded-xl",
              v.iconBg,
            )}
          >
            <Icon className={cn("h-5 w-5", v.iconColor)} />
          </div>
        )}
      </div>

      {/* Decorative gradient */}
      <div className="absolute -right-8 -top-8 h-24 w-24 rounded-full bg-gradient-to-br from-muted/50 to-transparent opacity-50" />
    </motion.div>
  );
}

interface StatCardSkeletonProps {
  className?: string;
}

export function StatCardSkeleton({ className }: StatCardSkeletonProps) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border border-border bg-card p-5",
        className,
      )}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1 space-y-3">
          <div className="h-4 w-24 animate-pulse rounded bg-muted" />
          <div className="h-8 w-16 animate-pulse rounded bg-muted" />
          <div className="h-3 w-20 animate-pulse rounded bg-muted" />
        </div>
        <div className="h-11 w-11 animate-pulse rounded-xl bg-muted" />
      </div>
    </div>
  );
}
