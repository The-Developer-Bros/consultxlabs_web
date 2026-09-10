/**
 * The org-details Prisma include, in a LEAF module with no imports.
 *
 * It lives apart from lib/data/org-details-server.ts on purpose. That module
 * imports requireOrgAccess (and therefore the whole auth-helpers graph), and
 * pulling it into GET /api/organizations/[orgId] made that route 500 on every
 * request — verified by A/B against a preview without the change: 200 3/3
 * there, 500 3/3 with it. The route only ever needed the shape, so the shape
 * ships on its own and the heavy read stays where it belongs.
 */
export const orgDetailsInclude = {
  // #768 lockdown #6 carved branding onto a 1:1 satellite, and every other
  // reader already flattens `brandingProfile?.logo` (org-workspace, invitation
  // preview, explore, the settings route). This read did not, so
  // `org.organization.logo` was undefined and org avatars never displayed.
  brandingProfile: { select: { logo: true } },
  billingAccount: {
    select: {
      id: true,
      fundingSource: true,
      currency: true,
      walletBalance: true,
      creditLimit: true,
    },
  },
  payoutAccount: {
    select: {
      id: true,
      status: true,
      accountNumberLast4: true,
      bankName: true,
    },
  },
  // #1230 — settings UI renders the MSME declaration; the payout deadline
  // engine already reads this satellite server-side.
  msmeInfo: { select: { msmeStatus: true, msmeWrittenAgreementOnFile: true } },
  _count: {
    select: {
      memberships: true,
      contracts: true,
      invoices: true,
      purchaseOrders: true,
      auditLogs: true,
    },
  },
} as const;
