/**
 * Production-ready logging utility for Stream operations
 * Provides conditional logging based on environment and structured output
 */

import * as Sentry from "@sentry/nextjs";

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogContext {
  userId?: string;
  channelId?: string;
  operation?: string;
  duration?: number;
  [key: string]: unknown;
}

const isDevelopment = process.env.NODE_ENV === "development";
const isTest = process.env.NODE_ENV === "test";

// Enable verbose logging only in development
const VERBOSE_LOGGING = isDevelopment && !isTest;

/**
 * Format a log message with optional context
 */
function formatMessage(
  prefix: string,
  message: string,
  context?: LogContext,
): string {
  const timestamp = new Date().toISOString();
  const contextStr = context ? ` ${JSON.stringify(context)}` : "";
  return `[${timestamp}] [${prefix}] ${message}${contextStr}`;
}

/**
 * Stream-specific logger with environment-aware output
 */
export const streamLogger = {
  /**
   * Debug level - only logs in development
   */
  debug(message: string, context?: LogContext): void {
    if (VERBOSE_LOGGING) {
      console.log(formatMessage("Stream:DEBUG", message, context));
    }
  },

  /**
   * Info level - always logs (connection events, sync completions, channel ops)
   */
  info(message: string, context?: LogContext): void {
    console.log(formatMessage("Stream:INFO", message, context));
  },

  /**
   * Warning level - always logs
   */
  warn(message: string, context?: LogContext): void {
    console.warn(formatMessage("Stream:WARN", message, context));
  },

  /**
   * Error level - always logs with full details
   */
  error(message: string, error?: Error | unknown, context?: LogContext): void {
    const errorContext = {
      ...context,
      error:
        error instanceof Error
          ? {
              message: error.message,
              name: error.name,
              ...(isDevelopment && { stack: error.stack }),
            }
          : error,
    };
    console.error(formatMessage("Stream:ERROR", message, errorContext));

    if (!isDevelopment && error instanceof Error) {
      Sentry.captureException(error, {
        tags: { subsystem: "stream" },
        contexts: {
          stream: {
            channelId: context?.channelId,
            operation: context?.operation,
          },
        },
      });
    }
  },

  /**
   * Log operation timing (useful for performance monitoring)
   */
  timing(operation: string, durationMs: number, context?: LogContext): void {
    const level: LogLevel = durationMs > 5000 ? "warn" : "debug";
    const message = `${operation} completed in ${durationMs}ms`;

    if (level === "warn") {
      this.warn(message, { ...context, duration: durationMs, operation });
    } else {
      this.debug(message, { ...context, duration: durationMs, operation });
    }
  },

  /**
   * Log API call (for tracking Stream API usage)
   */
  apiCall(
    method: string,
    endpoint: string,
    success: boolean,
    context?: LogContext,
  ): void {
    const message = `API ${method} ${endpoint} - ${success ? "SUCCESS" : "FAILED"}`;
    if (success) {
      this.debug(message, context);
    } else {
      this.warn(message, context);
    }
  },
};
