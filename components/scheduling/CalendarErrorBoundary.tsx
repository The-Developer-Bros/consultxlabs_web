import * as Sentry from "@sentry/nextjs";
import React, { Component, ErrorInfo, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { RotateCcw } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

class CalendarErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "client" } });
    console.error("Uncaught error in calendar:", error, errorInfo);
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: undefined });
    // You might want to trigger a refetch of data here
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="bg-red-50 p-4 rounded-md text-red-700">
          <h2 className="font-bold">Something went wrong</h2>
          <p className="text-sm mt-2">{this.state.error?.message}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={this.handleRetry}
            className="mt-4"
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            Retry
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default CalendarErrorBoundary;
