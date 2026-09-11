"use client";

import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { PhoneOff, RefreshCw, Home } from "lucide-react";

interface CallEndedProps {
  message?: string;
  onRejoin?: () => void;
  onReturnHome?: () => void; // New prop for cleanup before navigation
}

const CallEnded = ({
  message = "The call has been ended by the host",
  onRejoin,
  onReturnHome,
}: CallEndedProps) => {
  const router = useRouter();

  // Handle return to home - use cleanup callback if provided, otherwise fallback to router
  const handleReturnHome = () => {
    if (onReturnHome) {
      onReturnHome();
    } else {
      router.push("/");
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-zinc-950 via-zinc-900 to-zinc-950">
      {/* Background pattern */}
      <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxnIGZpbGw9IiNmZmYiIGZpbGwtb3BhY2l0eT0iMC4wMiI+PGNpcmNsZSBjeD0iMzAiIGN5PSIzMCIgcj0iMiIvPjwvZz48L2c+PC9zdmc+')] opacity-50" />

      <div className="relative z-10 bg-zinc-900/80 backdrop-blur-xl border border-zinc-800 rounded-2xl p-8 max-w-md text-center shadow-2xl">
        {/* Icon */}
        <div className="flex justify-center mb-6">
          <div className="relative">
            <div className="absolute inset-0 bg-red-500/20 blur-xl rounded-full" />
            <div className="relative w-20 h-20 bg-red-500/10 border border-red-500/30 rounded-2xl flex items-center justify-center">
              <PhoneOff className="w-10 h-10 text-red-500" />
            </div>
          </div>
        </div>

        {/* Text */}
        <h1 className="text-fluid-3xl font-bold tracking-tight text-white mb-2">
          {message}
        </h1>
        <p className="text-zinc-400 mb-8">
          You can return to the home page or try to rejoin the meeting.
        </p>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Button
            onClick={handleReturnHome}
            variant="outline"
            className="bg-transparent border-zinc-700 text-white hover:bg-zinc-800 hover:border-zinc-600 px-6 py-2.5 h-auto"
          >
            <Home className="w-4 h-4 mr-2" />
            Return to Home
          </Button>

          {onRejoin && (
            <Button
              onClick={onRejoin}
              className="bg-primary hover:bg-primary/90 text-primary-foreground px-6 py-2.5 h-auto"
            >
              <RefreshCw className="w-4 h-4 mr-2" />
              Try to Rejoin
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

export default CallEnded;
