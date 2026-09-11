import { Badge } from "@/components/ui/badge";
import { Clock, CreditCard } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface PaymentRequiredBadgeProps {
  /**
   * Whether to show the full text or just an icon
   */
  variant?: "full" | "icon";
  /**
   * Additional CSS classes
   */
  className?: string;
}

/**
 * Badge component to indicate when a request has been approved but is pending payment
 * Used in the consultant dashboard to show which requests need payment before slot allocation
 */
export function PaymentRequiredBadge({
  variant = "full",
  className = "",
}: PaymentRequiredBadgeProps) {
  if (variant === "icon") {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className={`inline-flex items-center ${className}`}>
              <CreditCard className="h-4 w-4 text-amber-600 animate-pulse" />
            </div>
          </TooltipTrigger>
          <TooltipContent>
            <p className="text-sm font-medium">Payment Required</p>
            <p className="text-xs text-muted-foreground">
              Waiting for client payment before slot allocation
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className={`bg-amber-50 border-amber-300 text-amber-700 hover:bg-amber-100 ${className}`}
          >
            <Clock className="mr-1 h-3 w-3" />
            Payment Pending
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-sm font-medium">Approved - Awaiting Payment</p>
          <p className="text-xs text-muted-foreground">
            Payment link has been sent to the client. Slot allocation will
            proceed after successful payment.
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
