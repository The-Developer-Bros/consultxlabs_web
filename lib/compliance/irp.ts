/**
 * IRP (Invoice Registration Portal) / IRN (Invoice Reference Number)
 * — INDIA COMPLIANCE.
 *
 * STATUS: ClearTax integration scaffold (decision Q2: ClearTax picked
 * for MVP — see plan A2 + `27-design-partner-customer-set.md`). Goes
 * live when `CLEARTAX_API_KEY` + `CLEARTAX_GSP_TOKEN` are set in env.
 * Without those, falls back to the STUB shape so the rest of the
 * pipeline keeps working in dev / CI.
 *
 * E-invoicing is mandatory for businesses with AATO > ₹5 Cr (since
 * 2017-18). Buyers > ₹5 Cr will reject non-IRN invoices at AP. Suppliers
 * > ₹10 Cr have a hard 30-day cap on IRN generation.
 *
 * ClearTax: REST API wrapper on top of the NIC IRP. Handles retries +
 * status polling. Provides a reconciliation dashboard. Cost: ~₹15/IRN.
 *
 * Vendor docs: https://docs.cleartax.in/cleartax-developers/e-invoicing-api
 *
 * Env vars required for live mode:
 *   - CLEARTAX_API_KEY        — primary auth header (`api-key`)
 *   - CLEARTAX_GSP_TOKEN      — short-lived bearer token, refresh hourly
 *                               via `POST /authenticate`
 *   - CLEARTAX_GSTIN          — your registered GSTIN
 *   - CLEARTAX_ENV            — "sandbox" | "production"
 *                               (default: "sandbox" if absent)
 *
 * Cron: `jobs/compliance/irp-uploader.ts` runs daily. For every
 * `OrganizationInvoice` with `irpStatus = PENDING` and
 * `issuedAt within 30 days`: call `generateIrn`; on success persist irn,
 * ackNumber, ackDate, signedQrPayload, set `irpStatus = GENERATED`,
 * `irpUploadedAt = now()`. On failure set `irpStatus = FAILED` and
 * surface in admin dashboard. Never retry GENERATED rows — IRN
 * regeneration requires cancel+reissue.
 *
 * Cancellation (within 24h of generation): call `cancelIrn`. After 24h,
 * only a credit note is valid; cancel returns `cancelled=false` with a
 * reason string.
 */

const CLEARTAX_BASE_URLS = {
  sandbox: "https://einv-apisandbox.cleartax.co/v0.1",
  production: "https://einv-api.cleartax.co/v0.1",
} as const;

export interface IrpResponse {
  irn: string | null;
  ackNumber: string | null;
  ackDate: Date | null;
  signedQrPayload: string | null;
  status: "GENERATED" | "FAILED" | "CANCELLED";
  reason: string;
}

/**
 * Returns true if env-configured to call the live ClearTax API. Used by
 * the cron + admin dashboards to decide whether IRN-related buttons are
 * functional vs disabled.
 */
export function isClearTaxConfigured(): boolean {
  return Boolean(
    process.env.CLEARTAX_API_KEY &&
      process.env.CLEARTAX_GSP_TOKEN &&
      process.env.CLEARTAX_GSTIN,
  );
}

function clearTaxBaseUrl(): string {
  const envName = (process.env.CLEARTAX_ENV ?? "sandbox") as
    | "sandbox"
    | "production";
  return CLEARTAX_BASE_URLS[envName] ?? CLEARTAX_BASE_URLS.sandbox;
}

function clearTaxHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "api-key": process.env.CLEARTAX_API_KEY ?? "",
    Authorization: `Bearer ${process.env.CLEARTAX_GSP_TOKEN ?? ""}`,
    gstin: process.env.CLEARTAX_GSTIN ?? "",
  };
}

/**
 * Upload an invoice payload to the IRP and return the resulting IRN.
 *
 * Call sites must pre-validate the payload structure (line items,
 * GSTIN, HSN codes) — ClearTax returns generic 400s on schema errors
 * which are noisier to debug than catching them upstream.
 *
 * In stub mode (no CLEARTAX_* env), returns a `FAILED` response with a
 * reason that documents the missing config so the cron logs it once
 * per row and stops retrying.
 */
export async function generateIrn(params: {
  invoiceId: string;
  payload: Record<string, unknown>;
}): Promise<IrpResponse> {
  if (!isClearTaxConfigured()) {
    return {
      irn: null,
      ackNumber: null,
      ackDate: null,
      signedQrPayload: null,
      status: "FAILED",
      reason:
        "STUB: ClearTax not configured (set CLEARTAX_API_KEY + CLEARTAX_GSP_TOKEN + CLEARTAX_GSTIN to enable).",
    };
  }

  const url = `${clearTaxBaseUrl()}/einvoice/uploadEinvoice`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: clearTaxHeaders(),
      body: JSON.stringify(params.payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        irn: null,
        ackNumber: null,
        ackDate: null,
        signedQrPayload: null,
        status: "FAILED",
        reason: `ClearTax HTTP ${res.status}: ${body.slice(0, 500)}`,
      };
    }

    const data = (await res.json()) as {
      data?: {
        Irn?: string;
        AckNo?: string | number;
        AckDt?: string; // YYYY-MM-DD HH:mm:ss
        SignedQRCode?: string;
      };
      message?: string;
    };

    if (!data.data?.Irn) {
      return {
        irn: null,
        ackNumber: null,
        ackDate: null,
        signedQrPayload: null,
        status: "FAILED",
        reason: `ClearTax returned no IRN: ${data.message ?? "unknown error"}`,
      };
    }

    return {
      irn: data.data.Irn,
      ackNumber: data.data.AckNo ? String(data.data.AckNo) : null,
      ackDate: data.data.AckDt ? new Date(data.data.AckDt) : null,
      signedQrPayload: data.data.SignedQRCode ?? null,
      status: "GENERATED",
      reason: "OK",
    };
  } catch (err) {
    return {
      irn: null,
      ackNumber: null,
      ackDate: null,
      signedQrPayload: null,
      status: "FAILED",
      reason: `ClearTax network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Cancel an IRN on the IRP. Window: 24 hours from `ackDate`. After 24h
 * the IRP rejects the cancellation; the only valid correction is a
 * credit note + new invoice.
 *
 * Reason codes per IRP spec: 1=Duplicate, 2=Data entry mistake,
 * 3=Order cancelled, 4=Other. We surface the operator-supplied free
 * text under Other (4) and pass it through as `cnlRem`.
 */
export async function cancelIrn(params: {
  irn: string;
  reason: string;
}): Promise<{ cancelled: boolean; reason: string }> {
  if (!isClearTaxConfigured()) {
    return {
      cancelled: false,
      reason:
        "STUB: ClearTax not configured (set CLEARTAX_API_KEY + CLEARTAX_GSP_TOKEN + CLEARTAX_GSTIN to enable).",
    };
  }

  const url = `${clearTaxBaseUrl()}/einvoice/cancel`;
  const body = {
    Irn: params.irn,
    CnlRsn: "4", // "Other" — closest fit for app-initiated cancels
    CnlRem: params.reason.slice(0, 100), // IRP caps at 100 chars
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: clearTaxHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        cancelled: false,
        reason: `ClearTax cancel HTTP ${res.status}: ${text.slice(0, 500)}`,
      };
    }
    return { cancelled: true, reason: "OK" };
  } catch (err) {
    return {
      cancelled: false,
      reason: `ClearTax cancel network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
