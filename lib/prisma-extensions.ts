// Money result-extension map for the Prisma client. Extracted from lib/prisma.ts
// so the connection/client setup there stays readable; this is the mechanical
// BigInt/Decimal -> number conversion applied via $extends({ result }).
// #780 — money is BigInt at the DB column (int4 ceiling ₹2.14cr was the v3
// audit's #1 finding), number at the JS boundary (MAX_SAFE_INTEGER ≈ ₹90 lakh
// crore). Every BigInt column is converted on read here so no bigint ever
// reaches JSON/Zod/Razorpay. Aggregations (_sum/groupBy) bypass result
// extensions — wrap those reads in sumPaise() from lib/payments/utils/money.
// A drift test asserts this map covers every BigInt column in the schema.
function f<K extends string>(field: K) {
  return {
    needs: { [field]: true } as { [P in K]: true },
    compute: (row: { [P in K]: bigint }) => Number(row[field]),
  };
}

function fn<K extends string>(field: K) {
  return {
    needs: { [field]: true } as { [P in K]: true },
    compute: (row: { [P in K]: bigint | null }) => {
      const v = row[field];
      return v === null ? null : Number(v);
    },
  };
}

// #781 §C — nullable Decimal → number. Prisma.Decimal instances can't cross
// the RSC boundary; FX snapshots are 6-dp, well within double precision.
function dn<K extends string>(field: K) {
  return {
    needs: { [field]: true } as { [P in K]: true },
    compute: (row: { [P in K]: { toNumber(): number } | null }) => {
      const v = row[field];
      return v === null ? null : v.toNumber();
    },
  };
}

export const moneyResultExtensions = {
  billingAccount: {
    walletBalance: fn("walletBalance"),
    creditLimit: fn("creditLimit"),
    minBalancePaise: fn("minBalancePaise"),
    autoTopUpAmountPaise: fn("autoTopUpAmountPaise"),
  },
  billingSubscription: {
    ratePerSeatPaise: fn("ratePerSeatPaise"),
    flatFeePaise: fn("flatFeePaise"),
  },
  walletTopUp: { amountPaise: f("amountPaise") },
  licensedSeatConfig: {
    ratePerSeatPaise: f("ratePerSeatPaise"),
    priceCapPerEngagementPaise: fn("priceCapPerEngagementPaise"),
    maxOveragePerCyclePaise: fn("maxOveragePerCyclePaise"),
  },
  creditPoolConfig: {
    maxOveragePerCyclePaise: fn("maxOveragePerCyclePaise"),
  },
  programAssignment: { consumedPaise: f("consumedPaise") },
  bookingUtilization: { priceAtBookingPaise: f("priceAtBookingPaise") },
  rateCard: {
    minGrossPaise: fn("minGrossPaise"),
    maxGrossPaise: fn("maxGrossPaise"),
  },
  organizationEarnings: {
    grossAmountPaise: f("grossAmountPaise"),
    platformFeePaise: f("platformFeePaise"),
    orgSharePaise: f("orgSharePaise"),
    consultantSharePaise: f("consultantSharePaise"),
    refundedAmountPaise: f("refundedAmountPaise"),
  },
  organizationPayout: {
    amountPaise: f("amountPaise"),
    grossRevenuePaise: f("grossRevenuePaise"),
    platformFeePaise: f("platformFeePaise"),
    refundsPaise: f("refundsPaise"),
    netPayoutPaise: f("netPayoutPaise"),
    tdsAmountPaise: fn("tdsAmountPaise"),
    clawbackAmountPaise: f("clawbackAmountPaise"),
  },
  organizationInvoice: {
    inrEquivalentPaise: f("inrEquivalentPaise"),
    subtotalPaise: f("subtotalPaise"),
    igstPaise: f("igstPaise"),
    cgstPaise: f("cgstPaise"),
    sgstPaise: f("sgstPaise"),
    totalPaise: f("totalPaise"),
  },
  invoiceLineItem: {
    unitPricePaise: f("unitPricePaise"),
    taxPaise: fn("taxPaise"),
  },
  purchaseOrder: {
    totalAmountPaise: f("totalAmountPaise"),
    remainingAmountPaise: f("remainingAmountPaise"),
  },
  usageLedgerEntry: { priceAtBookingPaise: f("priceAtBookingPaise") },
  ledgerAccountBalance: {
    balancePaise: f("balancePaise"),
    entrySeq: f("entrySeq"),
  },
  ledgerEntry: { amountPaise: f("amountPaise") },
  consultationPlan: { price: f("price") },
  subscriptionPlan: {
    price: f("price"),
    trialPriceInPaise: f("trialPriceInPaise"),
  },
  webinarPlan: { price: f("price") },
  classPlan: { price: f("price") },
  recording: {
    fileSize: fn("fileSize"),
    // #366 marketplace — nullable sale price (set only when listed).
    listPricePaise: fn("listPricePaise"),
  },
  recordingPurchase: { amountPaise: f("amountPaise") },
  payment: {
    amount: f("amount"),
    originalAmount: f("originalAmount"),
    taxAmount: f("taxAmount"),
    gstTcsCollectedPaise: fn("gstTcsCollectedPaise"),
    exchangeRateAtCheckout: dn("exchangeRateAtCheckout"),
  },
  paymentLeg: { amountPaise: f("amountPaise") },
  refund: {
    amountPaise: f("amountPaise"),
    exchangeRateAtRefund: dn("exchangeRateAtRefund"),
  },
  dispute: { amountPaise: f("amountPaise") },
  consultantEarnings: {
    grossAmount: f("grossAmount"),
    platformFeePaise: f("platformFeePaise"),
    consultantSharePaise: f("consultantSharePaise"),
    refundedShareAmount: f("refundedShareAmount"),
    gstTcsAccruedPaise: fn("gstTcsAccruedPaise"),
  },
  consultantPayout: {
    amount: f("amount"),
    tdsDeducted: f("tdsDeducted"),
    netAmount: fn("netAmount"),
  },
  tDSRecord: {
    cumulativeAmountCredited: f("cumulativeAmountCredited"),
    tdsDeducted: f("tdsDeducted"),
  },
  tdsRate: { thresholdPaise: fn("thresholdPaise") },
  creditNote: {
    subtotalPaise: f("subtotalPaise"),
    igstPaise: f("igstPaise"),
    cgstPaise: f("cgstPaise"),
    sgstPaise: f("sgstPaise"),
    totalPaise: f("totalPaise"),
  },
  consumerInvoice: {
    taxableValuePaise: f("taxableValuePaise"),
    cgstPaise: f("cgstPaise"),
    sgstPaise: f("sgstPaise"),
    igstPaise: f("igstPaise"),
    totalPaise: f("totalPaise"),
  },
  consumerCreditNote: {
    taxableValuePaise: f("taxableValuePaise"),
    cgstPaise: f("cgstPaise"),
    sgstPaise: f("sgstPaise"),
    igstPaise: f("igstPaise"),
    totalPaise: f("totalPaise"),
  },
  tdsAdjustment: { amountPaise: f("amountPaise") },
  gstTcsBatch: {
    netSupplyPaise: f("netSupplyPaise"),
    tcsCollectedPaise: f("tcsCollectedPaise"),
  },
  gstTcsAdjustment: { amountPaise: f("amountPaise") },
  discountCode: { maxDiscount: fn("maxDiscount") },
  referralProgramConfig: {
    monthlyBudgetPaise: fn("monthlyBudgetPaise"),
    currentMonthSpentPaise: f("currentMonthSpentPaise"),
    referrerRewardPaise: f("referrerRewardPaise"),
  },
  platformPricingConfig: {
    minTrialPriceInPaise: f("minTrialPriceInPaise"),
  },
  referralCode: {
    referrerReward: fn("referrerReward"),
    refereeReward: fn("refereeReward"),
    totalEarned: f("totalEarned"),
  },
  referral: {
    referrerRewardAmount: fn("referrerRewardAmount"),
    refereeRewardAmount: fn("refereeRewardAmount"),
  },
  referralCredit: {
    amount: f("amount"),
    usedAmount: f("usedAmount"),
    remainingAmount: f("remainingAmount"),
  },
  referralCreditUsage: {
    amount: f("amount"),
    originalAmount: f("originalAmount"),
    restoredAmount: f("restoredAmount"),
  },
  orgDataExportJob: { fileSizeBytes: fn("fileSizeBytes") },
  overageEvent: {
    marginalPaise: f("marginalPaise"),
    basePaise: f("basePaise"),
    surchargePaise: f("surchargePaise"),
  },
};
