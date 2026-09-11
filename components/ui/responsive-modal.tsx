"use client";

import * as React from "react";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { SheetContent } from "@/components/ui/sheet";
import { cn } from "@/utils/tailwind";

/**
 * One modal that adapts to screen size: a centered Dialog at sm+ and a
 * bottom Sheet below sm. Dialog and Sheet both wrap @radix-ui/react-dialog,
 * so Root/Trigger/Title/Close are shared — only the content geometry switches.
 * API mirrors Dialog so existing dialogs convert with a near drop-in swap.
 */
const ResponsiveModal = Dialog;
const ResponsiveModalTrigger = DialogTrigger;
const ResponsiveModalClose = DialogClose;
const ResponsiveModalHeader = DialogHeader;
const ResponsiveModalFooter = DialogFooter;
const ResponsiveModalTitle = DialogTitle;
const ResponsiveModalDescription = DialogDescription;

const ResponsiveModalContent = React.forwardRef<
  React.ElementRef<typeof DialogContent>,
  React.ComponentPropsWithoutRef<typeof DialogContent>
>(({ className, children, ...props }, ref) => {
  const isDesktop = useMediaQuery("(min-width: 640px)", true);

  if (isDesktop) {
    return (
      <DialogContent ref={ref} className={className} {...props}>
        {children}
      </DialogContent>
    );
  }

  return (
    <SheetContent
      ref={ref}
      side="bottom"
      className={cn("gap-4 p-6", className)}
      {...props}
    >
      {children}
    </SheetContent>
  );
});
ResponsiveModalContent.displayName = "ResponsiveModalContent";

export {
  ResponsiveModal,
  ResponsiveModalTrigger,
  ResponsiveModalClose,
  ResponsiveModalContent,
  ResponsiveModalHeader,
  ResponsiveModalFooter,
  ResponsiveModalTitle,
  ResponsiveModalDescription,
};
