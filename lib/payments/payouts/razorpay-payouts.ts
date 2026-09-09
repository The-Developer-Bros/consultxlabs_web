/**
 * RazorpayX Payouts Integration
 * Handles fund transfers to consultants via RazorpayX Payouts API
 *
 * API Documentation: https://razorpay.com/docs/api/x/payouts/
 */

import * as Sentry from "@sentry/nextjs";
import {
  reportSentryError,
  reportSentryMessage,
} from "@/lib/observability/report";
import { ENABLE_LIVE_PAYOUTS } from "@/lib/feature-flags";
import { PaymentError } from "@/lib/payments/core/types";
import crypto from "crypto";

// ============================================
// Types
// ============================================

export interface RazorpayXConfig {
  keyId: string;
  keySecret: string;
  accountNumber: string; // RazorpayX account number
  webhookSecret?: string;
}

export interface CreateContactRequest {
  name: string;
  email: string;
  contact?: string;
  type: "vendor" | "customer" | "employee" | "self";
  referenceId?: string;
  notes?: Record<string, string>;
}

export interface Contact {
  id: string;
  entity: string;
  name: string;
  email: string;
  contact: string;
  type: string;
  referenceId?: string;
  batchId?: string;
  active: boolean;
  createdAt: number;
}

export interface CreateFundAccountRequest {
  contactId: string;
  accountType: "bank_account" | "vpa";
  bankAccount?: {
    name: string;
    ifsc: string;
    accountNumber: string;
  };
  vpa?: {
    address: string; // UPI ID
  };
}

export interface FundAccount {
  id: string;
  entity: string;
  contactId: string;
  accountType: string;
  bankAccount?: {
    ifsc: string;
    bankName: string;
    name: string;
    notes: string[];
    accountNumber: string;
  };
  vpa?: {
    username: string;
    handle: string;
    address: string;
  };
  active: boolean;
  createdAt: number;
}

export interface CreatePayoutRequest {
  fundAccountId: string;
  amount: number; // in paise
  currency: string;
  mode: "NEFT" | "RTGS" | "IMPS" | "UPI";
  purpose:
    | "refund"
    | "cashback"
    | "payout"
    | "salary"
    | "utility_bill"
    | "vendor_bill";
  queueIfLowBalance?: boolean;
  referenceId?: string;
  narration?: string;
  notes?: Record<string, string>;
  idempotencyKey: string; // Required from March 2025
}

export interface RazorpayPayout {
  id: string;
  entity: string;
  fundAccountId: string;
  amount: number;
  currency: string;
  mode: string;
  purpose: string;
  fees: number;
  tax: number;
  status: RazorpayPayoutStatus;
  utr?: string; // Unique Transaction Reference
  referenceId?: string;
  narration?: string;
  batchId?: string;
  failureReason?: string;
  createdAt: number;
}

export type RazorpayPayoutStatus =
  | "queued"
  | "pending"
  | "processing"
  | "processed"
  | "reversed"
  | "cancelled"
  | "rejected"
  // Terminal failure state returned by the Payouts Entity; the webhook
  // mappers already handle payout.failed events, so the fetch-side type
  // must model it too or a poller switch on remote.status cannot compile.
  | "failed";

export interface PayoutWebhookEvent {
  entity: string;
  accountId: string;
  event: string;
  containsArray: boolean;
  payload: {
    payout: {
      entity: RazorpayPayout;
    };
  };
  createdAt: number;
}

// ============================================
// RazorpayX Payouts Service
// ============================================

/**
 * #1377 — ceiling on any single RazorpayX HTTP call. Sized against the payout
 * batch: the submission loop runs under a cron lock, and a request that has
 * not answered in half a minute is not going to answer usefully.
 */
const RAZORPAYX_REQUEST_TIMEOUT_MS = 30_000;

// RazorpayX accepts an `X-Payout-Idempotency` value of 4-36 characters drawn
// from letters, digits, hyphen, underscore and space, and rejects anything else
// with a 400 — so an over-long key is not a weaker duplicate guard, it is a
// payout that never leaves the building.
const PAYOUT_IDEMPOTENCY_MIN_LENGTH = 4;
const PAYOUT_IDEMPOTENCY_MAX_LENGTH = 36;
const PAYOUT_IDEMPOTENCY_ALLOWED_CHARS = /^[A-Za-z0-9 _-]+$/;

/**
 * Fold a caller's idempotency key onto one RazorpayX will accept.
 *
 * #1377 — both money-out paths overshot the limit. An organization payout sends
 * `payout_<uuid>` (43 characters) and a consultant payout prefers the
 * `idempotencyKey` persisted on the row, `payout_<profileId>_<batchId>` (72),
 * so every live submission would have been refused at the header rather than
 * deduplicated. The persisted value stays as it is — it is also the row's
 * unique key and the Stripe idempotency key, neither of which is bounded this
 * way — and only the gateway header is narrowed here.
 *
 * The fold is a pure function of the key, so the one property that makes a
 * retry safe survives: the same payout row always derives the same slot, and a
 * request that timed out after RazorpayX accepted it returns the original
 * payout instead of paying a second time.
 */
export function boundPayoutIdempotencyKey(key: string): string {
  if (
    key.length >= PAYOUT_IDEMPOTENCY_MIN_LENGTH &&
    key.length <= PAYOUT_IDEMPOTENCY_MAX_LENGTH &&
    PAYOUT_IDEMPOTENCY_ALLOWED_CHARS.test(key)
  ) {
    return key;
  }
  // 34 characters: inside the limit, inside the charset, and still readable as
  // a payout key in the RazorpayX dashboard.
  return `p_${crypto.createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

export class RazorpayPayoutsService {
  private config: RazorpayXConfig;
  private baseUrl = "https://api.razorpay.com/v1";

  constructor(config: RazorpayXConfig) {
    this.config = config;

    if (!config.keyId || !config.keySecret || !config.accountNumber) {
      throw new Error(
        "RazorpayX credentials not configured. Required: keyId, keySecret, accountNumber",
      );
    }
  }

  /**
   * Check if RazorpayX is configured
   */
  isConfigured(): boolean {
    return !!(
      this.config.keyId &&
      this.config.keySecret &&
      this.config.accountNumber
    );
  }

  /**
   * Make authenticated API request to RazorpayX
   */
  private async apiRequest<T>(
    method: "GET" | "POST" | "PATCH",
    endpoint: string,
    body?: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<T> {
    const auth = Buffer.from(
      `${this.config.keyId}:${this.config.keySecret}`,
    ).toString("base64");

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${endpoint}`, {
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        // #1377 — bare `fetch` has no default timeout, so a hung connection to
        // api.razorpay.com hangs the caller for as long as the socket stays
        // open. This is the same hazard `withRazorpaySdkTimeout` exists for on
        // the payments client, and it is worse here: the payout batch holds a
        // cron lock while it submits, so one stalled socket can wedge an
        // entire disbursement run. Every payout submission carries
        // `X-Payout-Idempotency`, so a timed-out request that DID reach
        // RazorpayX returns the original payout on retry rather than paying
        // twice.
        signal: AbortSignal.timeout(RAZORPAYX_REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      // AbortSignal.timeout rejects with a TimeoutError DOMException, and a
      // DNS/socket failure rejects with a TypeError. Neither says whether the
      // request reached RazorpayX, so both are surfaced as one retryable code
      // rather than being flattened into an anonymous Error.
      throw new PaymentError(
        `RazorpayX request ${method} ${endpoint} did not complete: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        "RAZORPAYX_REQUEST_FAILED",
        "RAZORPAY",
        cause,
      );
    }

    if (!response.ok) {
      // Razorpay's error envelope is `{ error: { code, description, reason } }`.
      // The old throw kept only `description`, so callers could not tell a
      // 401 on bad credentials from a 400 on a malformed fund account from a
      // 502 worth retrying — every failure read as one opaque string. Carry
      // the gateway's own code and the HTTP status through instead.
      const parsed: unknown = await response.json().catch(() => null);
      const gatewayError =
        parsed &&
        typeof parsed === "object" &&
        "error" in parsed &&
        typeof (parsed as { error: unknown }).error === "object"
          ? ((parsed as { error: { code?: string; description?: string } })
              .error ?? {})
          : {};
      throw new PaymentError(
        `RazorpayX API error (HTTP ${response.status}) on ${method} ${endpoint}: ${
          gatewayError.description || response.statusText || "no description"
        }`,
        gatewayError.code || `RAZORPAYX_HTTP_${response.status}`,
        "RAZORPAY",
        parsed,
      );
    }

    // #1377 — the success body is read OUTSIDE the fetch() try above, so a
    // reply whose headers arrived but whose body stalls trips the same
    // AbortSignal here, and a non-JSON body (an edge/WAF error page) throws a
    // SyntaxError. Either would escape as a bare exception and lose the
    // retryable code the payout callers classify on. Neither says whether the
    // payout was accepted, which is exactly the RAZORPAYX_REQUEST_FAILED case.
    try {
      return (await response.json()) as T;
    } catch (cause) {
      throw new PaymentError(
        `RazorpayX response to ${method} ${endpoint} could not be read: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        "RAZORPAYX_REQUEST_FAILED",
        "RAZORPAY",
        cause,
      );
    }
  }

  // ============================================
  // Contacts API
  // ============================================

  /**
   * Create a contact (consultant) in RazorpayX
   */
  async createContact(request: CreateContactRequest): Promise<Contact> {
    return this.apiRequest<Contact>("POST", "/contacts", {
      name: request.name,
      email: request.email,
      contact: request.contact,
      type: request.type,
      reference_id: request.referenceId,
      notes: request.notes,
    });
  }

  /**
   * Fetch a contact by ID
   */
  async fetchContact(contactId: string): Promise<Contact> {
    return this.apiRequest<Contact>("GET", `/contacts/${contactId}`);
  }

  /**
   * Update a contact
   */
  async updateContact(
    contactId: string,
    updates: Partial<CreateContactRequest>,
  ): Promise<Contact> {
    return this.apiRequest<Contact>("PATCH", `/contacts/${contactId}`, {
      name: updates.name,
      email: updates.email,
      contact: updates.contact,
      type: updates.type,
      reference_id: updates.referenceId,
      notes: updates.notes,
    });
  }

  // ============================================
  // Fund Accounts API
  // ============================================

  /**
   * Create a fund account (bank account or UPI) for a contact
   */
  async createFundAccount(
    request: CreateFundAccountRequest,
  ): Promise<FundAccount> {
    const payload: Record<string, unknown> = {
      contact_id: request.contactId,
      account_type: request.accountType,
    };

    if (request.accountType === "bank_account" && request.bankAccount) {
      payload.bank_account = {
        name: request.bankAccount.name,
        ifsc: request.bankAccount.ifsc,
        account_number: request.bankAccount.accountNumber,
      };
    } else if (request.accountType === "vpa" && request.vpa) {
      payload.vpa = {
        address: request.vpa.address,
      };
    }

    return this.apiRequest<FundAccount>("POST", "/fund_accounts", payload);
  }

  /**
   * Fetch a fund account by ID
   */
  async fetchFundAccount(fundAccountId: string): Promise<FundAccount> {
    return this.apiRequest<FundAccount>(
      "GET",
      `/fund_accounts/${fundAccountId}`,
    );
  }

  /**
   * Validate a bank account via penny testing
   * Note: This creates a ₹1 transfer that is reversed
   */
  async validateBankAccount(fundAccountId: string): Promise<{
    id: string;
    status: "created" | "completed" | "failed";
    accountStatus: "valid" | "invalid" | "unknown";
  }> {
    return this.apiRequest("POST", "/fund_accounts/validations", {
      fund_account: {
        id: fundAccountId,
      },
      account_number: this.config.accountNumber,
      amount: 100, // ₹1 in paise
      currency: "INR",
      notes: {
        purpose: "bank_account_validation",
      },
    });
  }

  /**
   * #863 — current RazorpayX account balance in paise, or null when the
   * response shape isn't what we expect. Used ONLY by the pre-batch balance
   * preflight; a null is treated as "unknown" (fail-open) by the caller, so a
   * shape mismatch or transient error never blocks payouts. The exact endpoint
   * must be re-verified against the sandbox before ENABLE_LIVE_PAYOUTS flips.
   */
  async getAccountBalance(): Promise<number | null> {
    try {
      const res = await this.apiRequest<{
        balance?: number;
        balances?: Array<{ balance?: number }>;
      }>("GET", `/accounts/${encodeURIComponent(this.config.accountNumber)}`);
      if (typeof res.balance === "number") return res.balance;
      const first = res.balances?.[0]?.balance;
      return typeof first === "number" ? first : null;
    } catch (error) {
      // Genuinely unexpected (network/shape/auth) — the fail-open null return
      // is a deliberate caller-side decision (assertPayoutBalance), not a
      // claim that this failure is routine.
      reportSentryError(error, {
        subsystem: "payments",
        tags: { provider: "razorpay" },
      });
      return null;
    }
  }

  // ============================================
  // Payouts API
  // ============================================

  /**
   * Create a payout to a fund account
   * Note: Idempotency key is REQUIRED from March 2025
   */
  async createPayout(request: CreatePayoutRequest): Promise<RazorpayPayout> {
    return this.apiRequest<RazorpayPayout>(
      "POST",
      "/payouts",
      {
        account_number: this.config.accountNumber,
        fund_account_id: request.fundAccountId,
        amount: request.amount,
        currency: request.currency,
        mode: request.mode,
        purpose: request.purpose,
        queue_if_low_balance: request.queueIfLowBalance ?? true,
        reference_id: request.referenceId,
        narration: request.narration,
        notes: request.notes,
      },
      {
        "X-Payout-Idempotency": boundPayoutIdempotencyKey(
          request.idempotencyKey,
        ),
      },
    );
  }

  /**
   * Fetch a payout by ID
   */
  async fetchPayout(payoutId: string): Promise<RazorpayPayout> {
    return this.apiRequest<RazorpayPayout>("GET", `/payouts/${payoutId}`);
  }

  /**
   * Cancel a queued payout
   */
  async cancelPayout(payoutId: string): Promise<RazorpayPayout> {
    return this.apiRequest<RazorpayPayout>(
      "POST",
      `/payouts/${payoutId}/cancel`,
    );
  }

  /**
   * List payouts with filters
   */
  async listPayouts(params?: {
    fundAccountId?: string;
    mode?: string;
    status?: RazorpayPayoutStatus;
    from?: number;
    to?: number;
    count?: number;
    skip?: number;
  }): Promise<{
    entity: string;
    count: number;
    items: RazorpayPayout[];
  }> {
    const queryParams = new URLSearchParams();
    queryParams.set("account_number", this.config.accountNumber);

    if (params?.fundAccountId)
      queryParams.set("fund_account_id", params.fundAccountId);
    if (params?.mode) queryParams.set("mode", params.mode);
    if (params?.status) queryParams.set("status", params.status);
    if (params?.from) queryParams.set("from", params.from.toString());
    if (params?.to) queryParams.set("to", params.to.toString());
    if (params?.count) queryParams.set("count", params.count.toString());
    if (params?.skip) queryParams.set("skip", params.skip.toString());

    return this.apiRequest("GET", `/payouts?${queryParams.toString()}`);
  }

  // ============================================
  // Webhook Handling
  // ============================================

  /**
   * Verify webhook signature
   */
  verifyWebhookSignature(payload: string, signature: string): boolean {
    if (!this.config.webhookSecret) {
      Sentry.logger.warn("RazorpayX webhook secret not configured");
      return false;
    }

    const expectedSignature = crypto
      .createHmac("sha256", this.config.webhookSecret)
      .update(payload)
      .digest("hex");

    // timingSafeEqual THROWS on a length mismatch, so an attacker-controlled
    // header could turn signature rejection into an unhandled exception.
    // Compare lengths first, exactly as app/api/webhooks/utils.ts does.
    if (signature.length !== expectedSignature.length) {
      // Internet-facing and hostile traffic can drive this arbitrarily high —
      // captured at warning/expected so it never reads as a platform fault.
      // Candidate for a Sentry inbound rate-limit on this event if volume
      // ever needs bounding.
      reportSentryMessage("RazorpayX webhook signature length mismatch", {
        subsystem: "payments",
        tags: { provider: "razorpay" },
        expected: true,
        level: "warning",
      });
      return false;
    }

    const valid = crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature),
    );
    if (!valid) {
      // Same rate-limit candidacy note as above.
      reportSentryMessage("RazorpayX webhook signature mismatch", {
        subsystem: "payments",
        tags: { provider: "razorpay" },
        expected: true,
        level: "warning",
      });
    }
    return valid;
  }

  /**
   * Parse and validate webhook event
   */
  parseWebhookEvent(payload: string): PayoutWebhookEvent {
    return JSON.parse(payload);
  }

  /**
   * Map RazorpayX payout status to our internal status.
   *
   * The four terminal RazorpayX states are `processed`, `rejected`,
   * `cancelled`, `reversed` and `failed`; `queued`, `pending` and `processing`
   * are intermediate.
   * https://razorpay.com/docs/x/payouts/status-details/
   *
   * #1377 — `failed` used to fall through to the `default` arm and be read as
   * PENDING, i.e. as "still in flight". A payout that the bank refused would
   * therefore never reach FAILED, so its earnings stayed BATCHED instead of
   * being returned to READY and the consultant was never paid and never
   * re-queued. The default arm is kept for genuinely unknown strings, where
   * PENDING is the right answer because it keeps the reconciler polling
   * instead of settling state on a guess.
   */
  mapPayoutStatus(
    status: RazorpayPayoutStatus,
  ): "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED" {
    switch (status) {
      case "queued":
      case "pending":
        return "PENDING";
      case "processing":
        return "PROCESSING";
      case "processed":
        return "COMPLETED";
      case "reversed":
      case "rejected":
      case "failed":
        return "FAILED";
      case "cancelled":
        return "CANCELLED";
      default:
        return "PENDING";
    }
  }

  // ============================================
  // Utility Methods
  // ============================================

  /**
   * Generate idempotency key for payout
   */
  // M4 FIX: Deterministic key so retries hit the same RazorpayX idempotency slot
  generateIdempotencyKey(payoutId: string): string {
    return `payout_${payoutId}`;
  }

  /**
   * Determine payout mode based on amount
   * - IMPS: Instant, up to ₹5L per transaction
   * - NEFT: Settled in batches, no limit
   * - RTGS: For amounts > ₹2L, real-time
   * - UPI: For VPA fund accounts
   */
  determinePayoutMode(
    amount: number,
    accountType: "bank_account" | "vpa",
  ): "IMPS" | "NEFT" | "UPI" {
    if (accountType === "vpa") {
      return "UPI";
    }

    // Amount in paise
    const amountInRupees = amount / 100;

    if (amountInRupees <= 500000) {
      // ₹5L limit for IMPS
      return "IMPS";
    }

    return "NEFT";
  }
}

// ============================================
// Factory
// ============================================

let razorpayPayoutsInstance: RazorpayPayoutsService | null = null;

/**
 * #1407 — the one place the RazorpayX API credential pair is resolved.
 * Disbursement and the two status pollers must authenticate as the same
 * merchant: the pollers read RAZORPAY_KEY_ID/RAZORPAY_SECRET directly, so on
 * an account whose X keys differ from the core checkout keys every payout
 * lookup 401s and every stuck payout is silently left stuck. Fallback order
 * matches the documented one in `.env.sample`.
 */
export function resolveRazorpayXCredentials(): {
  keyId: string;
  keySecret: string;
} {
  return {
    keyId: process.env.RAZORPAYX_KEY_ID || process.env.RAZORPAY_KEY_ID || "",
    keySecret:
      process.env.RAZORPAYX_KEY_SECRET || process.env.RAZORPAY_SECRET || "",
  };
}

export function getRazorpayPayoutsService(): RazorpayPayoutsService {
  if (!razorpayPayoutsInstance) {
    const { keyId, keySecret } = resolveRazorpayXCredentials();

    // PM-10 — ENABLE_LIVE_PAYOUTS, not NODE_ENV, is the posture where real
    // money leaves via RazorpayX: the consultant rail holds submissions
    // behind it (payout-service.ts) and the org rail behind the same flag
    // (org-payout-service.ts). A TEST key there means payouts vanish into
    // test mode — no bank account is ever debited — while our ledger marks
    // them COMPLETED. With the flag off, test keys are legitimate (dev,
    // preview, the sandbox smokes under scripts/smoke/, or a prod deploy
    // still under the go-live freeze) and must keep working.
    //
    // Same `next build` exemption as the core client: a build with the flag
    // set moves no money, and module-load throws during page-data collection
    // broke deploys (see razorpay.ts).
    if (
      ENABLE_LIVE_PAYOUTS &&
      process.env.NEXT_PHASE !== "phase-production-build" &&
      /^rzp_test_/.test(keyId)
    ) {
      throw new PaymentError(
        `${
          process.env.RAZORPAYX_KEY_ID
            ? "RAZORPAYX_KEY_ID"
            : "RAZORPAYX_KEY_ID (unset — falling back to RAZORPAY_KEY_ID)"
        } is set to a Razorpay TEST key (${keyId}) while ENABLE_LIVE_PAYOUTS=true. ` +
          "Live payouts cannot run against test mode: no bank account would ever " +
          "be debited while our ledger marks the payout COMPLETED. " +
          "Fix: set RAZORPAYX_KEY_ID and RAZORPAYX_KEY_SECRET to the RazorpayX LIVE keys, " +
          "or set ENABLE_LIVE_PAYOUTS=false to keep the disbursement freeze on.",
        "RAZORPAYX_TEST_KEYS_IN_LIVE_MODE",
        "RAZORPAY",
      );
    }

    razorpayPayoutsInstance = new RazorpayPayoutsService({
      keyId,
      keySecret,
      accountNumber: process.env.RAZORPAYX_ACCOUNT_NUMBER || "",
      webhookSecret: process.env.RAZORPAYX_WEBHOOK_SECRET,
    });
  }
  return razorpayPayoutsInstance;
}

/**
 * Check if RazorpayX Payouts is configured
 */
export function isRazorpayPayoutsConfigured(): boolean {
  try {
    const service = getRazorpayPayoutsService();
    return service.isConfigured();
  } catch (error) {
    // Constructor throws only on missing credentials — a modelled
    // "not configured yet" outcome (e.g. local/dev env), not a fault.
    // EXCEPT the PM-10 live-posture guard in getRazorpayPayoutsService:
    // swallowing that into "not configured" would make assertPayoutBalance
    // fail OPEN and wave a payout batch through on test keys. Rethrow so
    // the live gate fails closed with the actionable error.
    if (
      error instanceof PaymentError &&
      error.code === "RAZORPAYX_TEST_KEYS_IN_LIVE_MODE"
    ) {
      throw error;
    }
    reportSentryError(error, {
      subsystem: "payments",
      tags: { provider: "razorpay" },
      expected: true,
    });
    return false;
  }
}
