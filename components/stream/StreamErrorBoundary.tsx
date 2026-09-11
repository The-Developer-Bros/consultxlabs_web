"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { AlertCircle, RefreshCw, MessageSquare, Video } from "lucide-react";

interface StreamErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  errorType: "chat" | "video" | "general";
}

interface StreamErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ComponentType<StreamErrorBoundaryState>;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
  enableRetry?: boolean;
}

// Default error fallback component
const DefaultStreamErrorFallback: React.FC<
  StreamErrorBoundaryState & { onRetry?: () => void }
> = ({ error, errorType, onRetry }) => {
  const getErrorMessage = () => {
    if (!error) return "An unknown error occurred";

    // Stream-specific error handling
    if (
      error.message.includes("token") ||
      error.message.includes("authentication")
    ) {
      return "Authentication failed. Please refresh the page to reconnect.";
    }

    if (
      error.message.includes("network") ||
      error.message.includes("connection")
    ) {
      return "Network connection failed. Please check your internet and try again.";
    }

    if (error.message.includes("permission")) {
      return "Permission denied. Please ensure you have the necessary permissions.";
    }

    // Default to the original error message for debugging
    return error.message;
  };

  const getIcon = () => {
    switch (errorType) {
      case "chat":
        return <MessageSquare className="h-8 w-8 text-red-500" />;
      case "video":
        return <Video className="h-8 w-8 text-red-500" />;
      default:
        return <AlertCircle className="h-8 w-8 text-red-500" />;
    }
  };

  const getTitle = () => {
    switch (errorType) {
      case "chat":
        return "Chat Service Error";
      case "video":
        return "Video Service Error";
      default:
        return "Stream Service Error";
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[200px] p-6 bg-gray-50 rounded-lg border border-gray-200">
      <div className="flex flex-col items-center text-center space-y-4">
        {getIcon()}

        <div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">
            {getTitle()}
          </h3>
          <p className="text-sm text-gray-600 max-w-md">{getErrorMessage()}</p>
        </div>

        {onRetry && (
          <Button
            onClick={onRetry}
            variant="outline"
            size="sm"
            className="flex items-center gap-2"
          >
            <RefreshCw className="h-4 w-4" />
            Try Again
          </Button>
        )}

        {process.env.NODE_ENV === "development" && error && (
          <details className="mt-4 text-xs text-gray-500 max-w-md">
            <summary className="cursor-pointer hover:text-gray-700">
              Technical Details (Development Only)
            </summary>
            <pre className="mt-2 p-2 bg-gray-100 rounded text-left overflow-auto">
              {error.stack}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
};

class StreamErrorBoundary extends React.Component<
  StreamErrorBoundaryProps,
  StreamErrorBoundaryState
> {
  private retryCount = 0;
  private maxRetries = 3;

  constructor(props: StreamErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      errorType: "general",
    };
  }

  static getDerivedStateFromError(
    error: Error,
  ): Partial<StreamErrorBoundaryState> {
    // Determine error type based on error message or stack trace
    let errorType: "chat" | "video" | "general" = "general";

    const errorString = error.toString().toLowerCase();
    if (
      errorString.includes("chat") ||
      errorString.includes("message") ||
      errorString.includes("channel")
    ) {
      errorType = "chat";
    } else if (
      errorString.includes("video") ||
      errorString.includes("call") ||
      errorString.includes("stream")
    ) {
      errorType = "video";
    }

    return {
      hasError: true,
      error,
      errorType,
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("StreamErrorBoundary caught an error:", error, errorInfo);

    this.setState({
      error,
      errorInfo,
    });

    // Call custom error handler if provided
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }

    // Log to monitoring service in production
    if (process.env.NODE_ENV === "production") {
      // You can integrate with error monitoring services like Sentry here
      console.error("Stream Error Boundary:", {
        error: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack,
        errorType: this.state.errorType,
        retryCount: this.retryCount,
      });
    }
  }

  handleRetry = () => {
    if (this.retryCount < this.maxRetries) {
      this.retryCount++;
      console.log(
        `Retrying Stream component (attempt ${this.retryCount}/${this.maxRetries})`,
      );

      this.setState({
        hasError: false,
        error: null,
        errorInfo: null,
        errorType: "general",
      });
    } else {
      console.warn("Maximum retry attempts reached for Stream component");
    }
  };

  render() {
    if (this.state.hasError) {
      const FallbackComponent =
        this.props.fallback || DefaultStreamErrorFallback;

      return (
        <FallbackComponent
          {...this.state}
          onRetry={
            this.props.enableRetry !== false ? this.handleRetry : undefined
          }
        />
      );
    }

    return this.props.children;
  }
}

// Convenience wrapper components for specific Stream services
export const StreamChatErrorBoundary: React.FC<
  Omit<StreamErrorBoundaryProps, "children"> & { children: React.ReactNode }
> = ({ children, ...props }) => (
  <StreamErrorBoundary {...props}>{children}</StreamErrorBoundary>
);

export const StreamVideoErrorBoundary: React.FC<
  Omit<StreamErrorBoundaryProps, "children"> & { children: React.ReactNode }
> = ({ children, ...props }) => (
  <StreamErrorBoundary {...props}>{children}</StreamErrorBoundary>
);

export default StreamErrorBoundary;
