import type { ReactNode } from "react";
import type { AppointmentVM } from "./view-model";

/**
 * Role adapter contract for the shared appointments surface. The shell/list
 * components are role-agnostic; everything role-specific (what Join does,
 * which dialogs exist, where "View details" goes) comes through this
 * interface, implemented once per dashboard next to its page client.
 */

export type PrimaryActionKind =
  | "join"
  | "pay"
  | "schedule"
  | "complete-booking"
  | "view";

export interface PrimaryAction {
  kind: PrimaryActionKind;
  label: string;
  onClick?: () => void;
  /** Navigation-style actions (pay-now URL, details route) use href instead. */
  href?: string;
  disabled?: boolean;
  busy?: boolean;
}

export interface OverflowItem {
  key: string;
  label: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

export interface AppointmentActionAdapter {
  role: "consultee" | "consultant";
  /** Detail-page route for the row, or null when none exists (Sheet-only rows). */
  detailHref(vm: AppointmentVM): string | null;
  /** The single context-aware button rendered inline on the row. */
  primaryAction(vm: AppointmentVM): PrimaryAction;
  /** Extra actions behind the row's ⋯ menu (reschedule/cancel/report/…). */
  overflowItems(vm: AppointmentVM): OverflowItem[];
  /** Adapter-owned dialogs, keyed off the adapter's active row rather than one
   *  instance per row. Mounted by whichever component renders the actions that
   *  open them — AppointmentsShell for the list, AppointmentDetailClient for
   *  the detail page. Callers of those do NOT mount it themselves. */
  renderDialogs(): ReactNode;
}
