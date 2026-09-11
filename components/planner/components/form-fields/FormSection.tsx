"use client";

import { cn } from "@/utils/tailwind";
import { LucideIcon } from "lucide-react";

interface FormSectionProps {
  title: string;
  description?: string;
  icon?: LucideIcon;
  children: React.ReactNode;
  className?: string;
}

export function FormSection({
  title,
  description,
  icon: Icon,
  children,
  className,
}: Readonly<FormSectionProps>) {
  return (
    <div
      className={cn(
        "bg-muted/20 rounded-lg p-6 space-y-4 border border-border/40",
        className,
      )}
    >
      <div className="flex items-center gap-2 pb-3 border-b border-border/30">
        {Icon && <Icon className="h-5 w-5 text-muted-foreground" />}
        <div>
          <h3 className="text-base font-semibold text-foreground">{title}</h3>
          {description && (
            <p className="text-sm text-muted-foreground mt-0.5">
              {description}
            </p>
          )}
        </div>
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}
