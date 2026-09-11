/**
 * Stripe Connect Integration
 * Handles connected accounts and payouts for consultants
 *
 * API Documentation: https://docs.stripe.com/connect
 */

import { reportSentryError } from "@/lib/observability/report";
import Stripe from "stripe";

// ============================================
// Types
// ============================================

export interface StripeConnectConfig {
  secretKey: string;
  clientId?: string;
  webhookSecret?: string;
}

export interface CreateConnectedAccountRequest {
  email: string;
  country: string;
  type?: "express" | "standard" | "custom";
  businessType?: "individual" | "company";
  metadata?: Record<string, string>;
}

export interface ConnectedAccount {
  id: string;
  type: string;
  email: string;
  country: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  requirements: {
    currentlyDue: string[];
    eventuallyDue: string[];
    pastDue: string[];
    pendingVerification: string[];
  };
  externalAccounts?: {
    data: Array<{
      id: string;
      type: string;
      last4?: string;
      bankName?: string;
      routingNumber?: string;
    }>;
  };
  metadata: Record<string, string>;
}

export interface CreateAccountLinkRequest {
  accountId: string;
  refreshUrl: string;
  returnUrl: string;
  type?: "account_onboarding" | "account_update";
}

export interface AccountLink {
  url: string;
  expiresAt: number;
}

export interface CreateTransferRequest {
  amount: number; // in cents/paise
  currency: string;
  destinationAccountId: string;
  description?: string;
  sourceTransaction?: string; // Charge ID for direct charges
  metadata?: Record<string, string>;
  transferGroup?: string;
  idempotencyKey?: string;
}

export interface StripeTransfer {
  id: string;
  amount: number;
  amountReversed: number;
  currency: string;
  destinationAccountId: string;
  description?: string;
  livemode: boolean;
  reversed: boolean;
  sourceTransaction?: string;
  transferGroup?: string;
  metadata: Record<string, string>;
  created: number;
}

export interface CreatePayoutRequest {
  amount: number;
  currency: string;
  description?: string;
  destinationAccountId: string;
  method?: "instant" | "standard";
  metadata?: Record<string, string>;
}

export interface StripePayout {
  id: string;
  amount: number;
  currency: string;
  arrivalDate: number;
  description?: string;
  method: string;
  status: "pending" | "in_transit" | "paid" | "failed" | "canceled";
  failureCode?: string;
  failureMessage?: string;
  type: string;
  metadata: Record<string, string>;
  created: number;
}

// ============================================
// Stripe Connect Service
// ============================================

export class StripeConnectService {
  private stripe: Stripe;
  private config: StripeConnectConfig;

  constructor(config: StripeConnectConfig) {
    this.config = config;

    if (!config.secretKey) {
      throw new Error("Stripe secret key not configured");
    }

    this.stripe = new Stripe(config.secretKey, {
      apiVersion: "2025-08-27.basil" as Stripe.LatestApiVersion,
      typescript: true,
    });
  }

  /**
   * Check if Stripe Connect is configured
   */
  isConfigured(): boolean {
    return !!this.config.secretKey;
  }

  // ============================================
  // Connected Accounts API
  // ============================================

  /**
   * Create a connected account for a consultant
   */
  async createConnectedAccount(
    request: CreateConnectedAccountRequest,
  ): Promise<ConnectedAccount> {
    const account = await this.stripe.accounts.create({
      type: request.type || "express",
      email: request.email,
      country: request.country,
      business_type: request.businessType || "individual",
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      metadata: request.metadata,
    });

    return this.mapAccount(account);
  }

  /**
   * Fetch a connected account
   */
  async fetchConnectedAccount(accountId: string): Promise<ConnectedAccount> {
    const account = await this.stripe.accounts.retrieve(accountId);
    return this.mapAccount(account);
  }

  /**
   * Update a connected account
   */
  async updateConnectedAccount(
    accountId: string,
    updates: {
      email?: string;
      metadata?: Record<string, string>;
    },
  ): Promise<ConnectedAccount> {
    const account = await this.stripe.accounts.update(accountId, {
      email: updates.email,
      metadata: updates.metadata,
    });
    return this.mapAccount(account);
  }

  /**
   * Delete a connected account
   */
  async deleteConnectedAccount(accountId: string): Promise<void> {
    await this.stripe.accounts.del(accountId);
  }

  /**
   * Create account link for onboarding
   */
  async createAccountLink(
    request: CreateAccountLinkRequest,
  ): Promise<AccountLink> {
    const link = await this.stripe.accountLinks.create({
      account: request.accountId,
      refresh_url: request.refreshUrl,
      return_url: request.returnUrl,
      type: request.type || "account_onboarding",
    });

    return {
      url: link.url,
      expiresAt: link.expires_at,
    };
  }

  /**
   * Create login link for Express dashboard
   */
  async createLoginLink(accountId: string): Promise<string> {
    const link = await this.stripe.accounts.createLoginLink(accountId);
    return link.url;
  }

  // ============================================
  // Transfers API (Platform -> Connected Account)
  // ============================================

  /**
   * Create a transfer to a connected account
   * Use this to move funds from platform to consultant
   */
  async createTransfer(
    request: CreateTransferRequest,
  ): Promise<StripeTransfer> {
    const transfer = await this.stripe.transfers.create(
      {
        amount: request.amount,
        currency: request.currency,
        destination: request.destinationAccountId,
        description: request.description,
        source_transaction: request.sourceTransaction,
        transfer_group: request.transferGroup,
        metadata: request.metadata,
      },
      request.idempotencyKey
        ? { idempotencyKey: request.idempotencyKey }
        : undefined,
    );

    return this.mapTransfer(transfer);
  }

  /**
   * Fetch a transfer
   */
  async fetchTransfer(transferId: string): Promise<StripeTransfer> {
    const transfer = await this.stripe.transfers.retrieve(transferId);
    return this.mapTransfer(transfer);
  }

  /**
   * Reverse a transfer (clawback)
   */
  async reverseTransfer(
    transferId: string,
    options?: {
      amount?: number;
      description?: string;
      metadata?: Record<string, string>;
    },
  ): Promise<{ id: string; amount: number; transferId: string }> {
    const reversal = await this.stripe.transfers.createReversal(transferId, {
      amount: options?.amount,
      description: options?.description,
      metadata: options?.metadata,
    });

    return {
      id: reversal.id,
      amount: reversal.amount,
      transferId: reversal.transfer as string,
    };
  }

  /**
   * List transfers
   */
  async listTransfers(params?: {
    destination?: string;
    transferGroup?: string;
    limit?: number;
    startingAfter?: string;
  }): Promise<{
    data: StripeTransfer[];
    hasMore: boolean;
  }> {
    const transfers = await this.stripe.transfers.list({
      destination: params?.destination,
      transfer_group: params?.transferGroup,
      limit: params?.limit || 10,
      starting_after: params?.startingAfter,
    });

    return {
      data: transfers.data.map((t) => this.mapTransfer(t)),
      hasMore: transfers.has_more,
    };
  }

  // ============================================
  // Payouts API (Connected Account -> Bank)
  // ============================================

  /**
   * Create a payout from a connected account to their bank
   * This triggers the actual bank transfer
   */
  async createPayout(request: CreatePayoutRequest): Promise<StripePayout> {
    const payout = await this.stripe.payouts.create(
      {
        amount: request.amount,
        currency: request.currency,
        description: request.description,
        method: request.method || "standard",
        metadata: request.metadata,
      },
      {
        stripeAccount: request.destinationAccountId,
      },
    );

    return this.mapPayout(payout);
  }

  /**
   * Fetch a payout
   */
  async fetchPayout(
    payoutId: string,
    accountId: string,
  ): Promise<StripePayout> {
    const payout = await this.stripe.payouts.retrieve(payoutId, {
      stripeAccount: accountId,
    });
    return this.mapPayout(payout);
  }

  /**
   * Cancel a pending payout
   */
  async cancelPayout(
    payoutId: string,
    accountId: string,
  ): Promise<StripePayout> {
    const payout = await this.stripe.payouts.cancel(payoutId, {
      stripeAccount: accountId,
    });
    return this.mapPayout(payout);
  }

  /**
   * Get connected account balance
   */
  async getAccountBalance(accountId: string): Promise<{
    available: Array<{ amount: number; currency: string }>;
    pending: Array<{ amount: number; currency: string }>;
  }> {
    const balance = await this.stripe.balance.retrieve({
      stripeAccount: accountId,
    });

    return {
      available: balance.available.map((b) => ({
        amount: b.amount,
        currency: b.currency,
      })),
      pending: balance.pending.map((b) => ({
        amount: b.amount,
        currency: b.currency,
      })),
    };
  }

  // ============================================
  // Webhook Handling
  // ============================================

  /**
   * Construct webhook event
   */
  constructWebhookEvent(
    payload: string | Buffer,
    signature: string,
  ): Stripe.Event {
    if (!this.config.webhookSecret) {
      throw new Error("Stripe Connect webhook secret not configured");
    }

    return this.stripe.webhooks.constructEvent(
      payload,
      signature,
      this.config.webhookSecret,
    );
  }

  /**
   * Map Stripe payout status to our internal status
   */
  mapPayoutStatus(
    status: string,
  ): "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED" {
    switch (status) {
      case "pending":
        return "PENDING";
      case "in_transit":
        return "PROCESSING";
      case "paid":
        return "COMPLETED";
      case "failed":
        return "FAILED";
      case "canceled":
        return "CANCELLED";
      default:
        return "PENDING";
    }
  }

  // ============================================
  // Private Helpers
  // ============================================

  private mapAccount(account: Stripe.Account): ConnectedAccount {
    return {
      id: account.id,
      type: account.type || "express",
      email: account.email || "",
      country: account.country || "",
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
      requirements: {
        currentlyDue: account.requirements?.currently_due || [],
        eventuallyDue: account.requirements?.eventually_due || [],
        pastDue: account.requirements?.past_due || [],
        pendingVerification: account.requirements?.pending_verification || [],
      },
      externalAccounts: account.external_accounts
        ? {
            data:
              (
                account.external_accounts as Stripe.ApiList<
                  Stripe.BankAccount | Stripe.Card
                >
              ).data?.map((ea) => ({
                id: ea.id,
                type: ea.object,
                last4: (ea as Stripe.BankAccount).last4,
                bankName: (ea as Stripe.BankAccount).bank_name || undefined,
                routingNumber:
                  (ea as Stripe.BankAccount).routing_number || undefined,
              })) || [],
          }
        : undefined,
      metadata: (account.metadata as Record<string, string>) || {},
    };
  }

  private mapTransfer(transfer: Stripe.Transfer): StripeTransfer {
    return {
      id: transfer.id,
      amount: transfer.amount,
      amountReversed: transfer.amount_reversed,
      currency: transfer.currency,
      destinationAccountId:
        typeof transfer.destination === "string"
          ? transfer.destination
          : transfer.destination?.id || "",
      description: transfer.description || undefined,
      livemode: transfer.livemode,
      reversed: transfer.reversed,
      sourceTransaction:
        typeof transfer.source_transaction === "string"
          ? transfer.source_transaction
          : transfer.source_transaction?.id,
      transferGroup: transfer.transfer_group || undefined,
      metadata: (transfer.metadata as Record<string, string>) || {},
      created: transfer.created,
    };
  }

  private mapPayout(payout: Stripe.Payout): StripePayout {
    return {
      id: payout.id,
      amount: payout.amount,
      currency: payout.currency,
      arrivalDate: payout.arrival_date,
      description: payout.description || undefined,
      method: payout.method || "standard",
      status: payout.status as StripePayout["status"],
      failureCode: payout.failure_code || undefined,
      failureMessage: payout.failure_message || undefined,
      type: payout.type,
      metadata: (payout.metadata as Record<string, string>) || {},
      created: payout.created,
    };
  }
}

// ============================================
// Factory
// ============================================

let stripeConnectInstance: StripeConnectService | null = null;

export function getStripeConnectService(): StripeConnectService {
  if (!stripeConnectInstance) {
    stripeConnectInstance = new StripeConnectService({
      secretKey: process.env.STRIPE_SECRET_KEY || "",
      clientId: process.env.STRIPE_CONNECT_CLIENT_ID,
      webhookSecret: process.env.STRIPE_CONNECT_WEBHOOK_SECRET,
    });
  }
  return stripeConnectInstance;
}

/**
 * Check if Stripe Connect is configured
 */
export function isStripeConnectConfigured(): boolean {
  try {
    const service = getStripeConnectService();
    return service.isConfigured();
  } catch (error) {
    // Constructor throws only on a missing secret key — a modelled
    // "not configured yet" outcome (e.g. local/dev env), not a fault.
    reportSentryError(error, {
      subsystem: "payments",
      tags: { provider: "stripe" },
      expected: true,
    });
    return false;
  }
}
