"use client";

import { Button, ButtonProps } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { cn } from "@/utils/tailwind";

interface SubmitButtonProps extends Omit<ButtonProps, "type"> {
  isLoading: boolean;
  loadingText?: string;
  children: React.ReactNode;
}

export function SubmitButton({
  isLoading,
  loadingText = "Saving...",
  children,
  className,
  disabled,
  ...props
}: Readonly<SubmitButtonProps>) {
  return (
    <Button
      type="submit"
      disabled={isLoading || disabled}
      className={cn("min-w-[120px]", className)}
      {...props}
    >
      {isLoading ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
          {loadingText}
        </>
      ) : (
        children
      )}
    </Button>
  );
}
