/**
 * POST /api/csp-report
 *
 * Sink for `Content-Security-Policy-Report-Only` violation reports.
 * Browsers send this with `Content-Type: application/csp-report`;
 * we accept either that or plain JSON since the spec is in flux.
 *
 * The route does NOT require auth — anyone can post a CSP report (the
 * browser is the originator, not the user). We rate-limit on IP to keep a
 * hostile poster from flooding our logs, but with a ceiling sized for
 * browser-generated traffic: see cspReportLimiter for why the old
 * spamLimiter budget made this endpoint useless.
 *
 * The report is logged as a structured event (`event: "csp_violation"`)
 * so an operator scanning `console` output during the report-only
 * rollout window can see which directives drift in production. When
 * we flip to enforce mode (`ENABLE_CSP_ENFORCE=true`), the same reports
 * still arrive — just attached to a blocked request rather than an
 * allowed-but-flagged one.
 */

import { NextResponse, type NextRequest } from "next/server";
import { applyRateLimit, cspReportLimiter } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";

  const rl = await applyRateLimit(cspReportLimiter, `csp:${ip}`);
  if (rl) return rl;

  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json(
      { error: "Invalid CSP report payload" },
      { status: 400 },
    );
  }

  // Structured log — `event: "csp_violation"` is the canonical search
  // key for the operator dashboard / log aggregation pipeline.
  console.warn(
    JSON.stringify({
      event: "csp_violation",
      ip,
      ua: req.headers.get("user-agent"),
      report: body,
    }),
  );
  return new NextResponse(null, { status: 204 });
}
