import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";

import {
  classifyError,
} from "@/lib/errors/classification/payment-error-classification";

interface IApiErrorOptions {
  tag: string; // e.g. "[ClassPlan.GET]"
  error: unknown;
  userId?: string; // for debugging context
  fallbackMessage?: string;
}

export function apiError({
  tag,
  error,
  userId,
  fallbackMessage,
}: IApiErrorOptions): NextResponse {
  const classified = classifyError(error, fallbackMessage);

  // Developer-friendly logging with context
  const ctx = userId ? ` (user: ${userId})` : "";
  if (classified.isBusinessError) {
    console.warn(`${tag}${ctx} Business rule: ${classified.errorMessage}`);
  } else {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "api" } });
    console.error(`${tag}${ctx} Unexpected:`, error);
  }

  return NextResponse.json(
    { error: classified.errorMessage, errorType: classified.errorType },
    { status: classified.httpStatus },
  );
}
