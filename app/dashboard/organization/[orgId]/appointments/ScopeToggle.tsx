"use client";

/**
 * Mine / Everyone switch for the org appointments page.
 *
 * The org sidebar used to carry "My Appointments" and "Appointments" as two
 * adjacent entries — same noun, different scope, and an OWNER saw both. They
 * are one destination now, and the scope is a control on the page rather than
 * a second nav item.
 *
 * Renders nothing when the viewer lacks `operations.read`: with only one scope
 * available a toggle would be a control that can't be operated. Those members
 * simply get their own appointments, which is all the old "My Appointments"
 * page ever showed them.
 */

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/utils/tailwind";

export type AppointmentScope = "mine" | "everyone";

export function ScopeToggle({ scope }: { scope: AppointmentScope }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const select = (next: AppointmentScope) => {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.set("scope", next);
    // The two scopes paginate independently; carrying `page` across would land
    // on a page the other scope may not have.
    params.delete("page");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const options: { value: AppointmentScope; label: string }[] = [
    { value: "mine", label: "Mine" },
    { value: "everyone", label: "Everyone" },
  ];

  return (
    <div
      role="group"
      aria-label="Appointment scope"
      className="inline-flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-1"
    >
      {options.map((o) => (
        <Button
          key={o.value}
          type="button"
          size="sm"
          variant="ghost"
          aria-pressed={scope === o.value}
          onClick={() => select(o.value)}
          className={cn(
            "h-7 px-3 text-sm",
            scope === o.value
              ? "bg-background shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}
