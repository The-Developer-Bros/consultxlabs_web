/**
 * Admin TDS return CSV — the authenticated hop to the quarterly full-PAN file.
 *
 * #1354/#1362 — the export job writes one CSV per FY+quarter into the PRIVATE
 * `org-invoices` bucket because it is the only artifact in the system that
 * carries a decrypted PAN. That is also why there is no download proxy and no
 * artifact upload anywhere: a full PAN leaves the database exactly once, into
 * an object no anonymous URL reaches, and this route is the only door — an
 * ADMIN session exchanges the quarter for a short-lived signed URL.
 *
 * CR #1354 r1 — ADMIN, not merely privileged: `requirePrivilegedAuth` admits
 * STAFF, and this object is the same decrypted-PAN class of data that
 * `/api/admin/tds?view=form26q` has always gated on ADMIN alone.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth-helpers";
import { applyRateLimit, moneyOpsLimiter } from "@/lib/rate-limit";
import { tdsReturnCsvStoragePath } from "@/lib/compliance/tds-return";
import {
  createPrivateFinanceSignedUrl,
  privateFinanceObjectExists,
} from "@/lib/storage/private-finance-object";

/** Short enough that a leaked URL from a browser history is already dead. */
const SIGNED_URL_TTL_SECONDS = 10 * 60;

/**
 * CR #1354 r1 — the shape has to be canonical, not merely plausible.
 * `Number.parseInt` reads "2foo" as quarter 2, and a bare `\d{4}-\d{2}$`
 * accepts "2026-99", so both would name a storage object for a period that
 * cannot exist. The refine pins the second half to the FY's closing year.
 */
const QuerySchema = z.object({
  financialYear: z
    .string()
    .regex(/^\d{4}-\d{2}$/, 'financialYear must look like "2026-27"')
    .refine((fy) => {
      const startYear = Number.parseInt(fy.slice(0, 4), 10);
      return fy.slice(5) === String((startYear + 1) % 100).padStart(2, "0");
    }, 'financialYear must be a consecutive Apr-Mar pair, e.g. "2026-27"'),
  quarter: z
    .string()
    .regex(/^[1-4]$/, "quarter must be 1-4")
    .transform((q) => Number.parseInt(q, 10)),
});

/**
 * GET /api/admin/compliance/tds-return?financialYear=2026-27&quarter=2
 * Redirects to a signed URL for that quarter's return CSV.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireAdminAuth();
    if (auth.error) return auth.error;

    const limited = await applyRateLimit(moneyOpsLimiter, auth.session.user.id);
    if (limited) return limited;

    const { searchParams } = new URL(req.url);
    const parsed = QuerySchema.safeParse(Object.fromEntries(searchParams));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid query", detail: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const { financialYear, quarter } = parsed.data;

    const storagePath = tdsReturnCsvStoragePath(financialYear, quarter);
    if (!(await privateFinanceObjectExists(storagePath))) {
      return NextResponse.json(
        {
          error:
            "No return CSV for that quarter — run the tds-return-draft workflow first.",
        },
        { status: 404 },
      );
    }

    const signedUrl = await createPrivateFinanceSignedUrl(
      storagePath,
      SIGNED_URL_TTL_SECONDS,
    );
    return NextResponse.redirect(signedUrl, 302);
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "admin" } },
    );
    console.error("Error signing TDS return CSV:", error);
    return NextResponse.json(
      { error: "Failed to fetch the TDS return CSV" },
      { status: 500 },
    );
  }
}
