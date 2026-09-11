/**
 * Phase 15: Enterprise Organizations — Arch 4-Modified (Issue #681)
 *
 * Seeds FOUR representative org shapes covering every capability pair + the
 * two v1 Program types:
 *
 *   1. Wipro           canSponsor=true,  canHost=false  (pure SPONSOR)
 *                      → BillingAccount(INVOICE) + Program(LICENSED_SEAT)
 *                        + PurchaseOrder + OrganizationInvoice (DRAFT)
 *
 *   2. LearnPro Agency canSponsor=false, canHost=true   (pure HOST)
 *                      → OrganizationPayoutAccount + RateCard(10/10/80)
 *                        + 5 EXPERT memberships
 *
 *   3. IIT Madras      canSponsor=true,  canHost=true   (HYBRID)
 *                      → BillingAccount(WALLET) with WalletEntry ledger
 *                        + Program(CREDIT_POOL)
 *                        + OrganizationPayoutAccount + RateCard
 *                        + 3 internal consultants (payoutRecipient=ORGANIZATION)
 *                        + 2 external consultants (payoutRecipient=SELF)
 *
 *   4. Rahul           canSponsor=false, canHost=true   (solo consultant)
 *                      → personal org, depth=0, no contracts
 *
 * Plus ancillary rows:
 *   - 1 ConsentArtifact per seeded user (DPDP demo)
 *   - 1 HrisEmployeeMap on Wipro (CSV provider)
 *   - 3 top-ups + 5 booking debits in IIT's WalletEntry ledger
 *   - 1 DRAFT OrganizationInvoice on Wipro with `irn=null, irpStatus=PENDING`
 */

import { faker } from "@faker-js/faker";
import bcrypt from "bcrypt";
import {
  Currency,
  FundingSource,
  MemberRole,
  MemberStatus,
  OrgStatus,
  ProgramStatus,
  ProgramType,
  BillingCycle,
  OverageBehavior,
  ContractStatus,
  OrgInvoiceStatus,
  IrpStatus,
  PayoutRecipient,
  ResidencyStatus,
  MsmeStatus,
  PoStatus,
  UserRole,
  OrgDirectoryType,
  OrgSizeBucket,
} from "@prisma/client";
import prisma from "../../lib/prisma";
import { buildConsentArtifact } from "../../lib/compliance/dpdp";
import { PURPOSE_CODES } from "../../lib/compliance/purpose-codes";
import { postLedgerTxn } from "../../lib/payments/ledger/post";
import type { UserWithProfiles } from "./1a-create-users";

// Same source-of-truth as 1a-create-users.ts so the tour-owner credential
// matches every other seed user; tour scripts and docs reference this.
const SEED_PASSWORD = process.env.SEED_PASSWORD || "SeedPass123!";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

async function createRootOrg(params: {
  name: string;
  slug: string;
  canSponsor: boolean;
  canHost: boolean;
  status?: OrgStatus;
  gstin?: string;
  gstStateCode?: string;
  /** Plaintext PAN. Encrypted into panEncrypted+panLast4 inside the seeder. */
  pan?: string;
  billingEmail?: string;
  industry?: string;
  website?: string;
  description?: string;
  /** Opt in to the public /explore/enterprise/organisations directory. */
  isPublic?: boolean;
  directoryType?: OrgDirectoryType;
  sizeBucket?: OrgSizeBucket;
}) {
  // #768 lockdown — branding fields live on OrgBrandingProfile (1:1).
  // PAN at rest is encrypted; the plaintext column was dropped.
  const { encryptPAN } = await import("../../lib/payments/tax/pan-crypto");
  const panFields = params.pan
    ? (() => {
        const { encrypted, last4 } = encryptPAN(params.pan!);
        return { panEncrypted: encrypted, panLast4: last4 };
      })()
    : {};
  const brandingFields =
    params.industry ||
    params.website ||
    params.description ||
    params.directoryType ||
    params.sizeBucket
      ? {
          brandingProfile: {
            create: {
              industry: params.industry ?? null,
              website: params.website ?? null,
              description: params.description ?? null,
              directoryType: params.directoryType ?? null,
              sizeBucket: params.sizeBucket ?? null,
            },
          },
        }
      : {};
  return await prisma.organization.create({
    data: {
      name: params.name,
      slug: params.slug,
      canSponsor: params.canSponsor,
      canHost: params.canHost,
      status: params.status ?? OrgStatus.ACTIVE,
      isPublic: params.isPublic ?? false,
      // #771 D10 — tax identity on the OrganizationTaxInfo satellite.
      taxInfo: {
        create: {
          gstin: params.gstin ?? null,
          gstStateCode: params.gstStateCode ?? null,
          ...panFields,
        },
      },
      ...brandingFields,
      billingEmail: params.billingEmail ?? null,
      paymentTermsDays: 60,
      requiresPO: params.canSponsor ? true : false,
      dataResidencyRegion: "IN",
      contractCurrency: Currency.INR,
      reportingCurrency: Currency.INR,
    },
  });
}

// ---------------------------------------------------------------------------
// Seeding entry point
// ---------------------------------------------------------------------------

export async function createOrganizations(
  users: UserWithProfiles[],
): Promise<void> {
  console.log("[15a] Seeding Arch 4-Modified organizations");

  if (users.length < 10) {
    console.warn(
      "[15a] Fewer than 10 users available; enterprise seed expects a richer user set. Continuing with what exists.",
    );
  }

  // Partition users: first 6 learners, next 5 consultants, etc.
  const consultees = users
    .filter((u) => u.consulteeProfile)
    .slice(0, Math.min(users.length, 15));
  const consultants = users
    .filter((u) => u.consultantProfile)
    .slice(0, Math.min(users.length, 12)); // 12 = 5 LearnPro + 5 IIT + 1 solo + 1 IIT owner

  if (consultees.length < 8 || consultants.length < 5) {
    console.warn(
      "[15a] Skipping enterprise seed — need ≥8 consultees + ≥5 consultants; got",
      consultees.length,
      consultants.length,
    );
    return;
  }

  // --------------------------------------------------------------------- WIPRO
  // consultees[7] is the dedicated org owner; consultees[0..2] are learners
  await seedWipro(consultees.slice(0, 3), consultees[7]);

  // ------------------------------------------------------------------ LEARNPRO
  // consultants[11] is the dedicated LearnPro owner; fallback to consultants[5]
  await seedLearnPro(consultants[11] ?? consultants[5], consultants.slice(0, 5));

  // --------------------------------------------------------------------- IIT
  await seedIit({
    owner: consultants[10] ?? consultants[5], // dedicated org owner; fallback to first professor
    internalProfessors: consultants.slice(5, 7),
    externalConsultants: consultants.slice(7, 10),
    students: consultees.slice(3, 7),
  });

  // ---------------------------------------------------------------- RAHUL SOLO
  if (consultants.length >= 8) {
    await seedSoloConsultant(consultants[7]);
  }

  // -------------------------------------------------------- CONSENT ARTIFACTS
  // ALL seeded users, not just the first 10 — every user the runtime touches
  // (Stream upsert on dashboard load) needs the gate to pass.
  await seedConsentArtifacts(users);

  // ---------------------------------------------------- TOUR OWNER (#723)
  // Dedicated ORG_WORKSPACE account with deterministic credentials so tour
  // scripts and integration tests can sign in without hunting for the
  // right seed user. Idempotent so re-running `npm run db:seed` doesn't
  // dup. Adopts the canonical Wipro org as its OWNER membership.
  await seedTourOwner();

  // ---------------------------------------------- DERIVED FLAG RECONCILE
  // ConsultantProfile.isIndependent is derived ("true iff zero ACTIVE EXPERT
  // memberships at canHost orgs") and is normally maintained by
  // recomputeConsultantIsIndependent() on every membership mutation. This seed
  // writes memberships straight through prisma.membership.create(), which
  // bypasses that — leaving every hosted expert flagged independent and
  // invisible on their org's public page. Reconcile once at the end.
  await reconcileSeededIsIndependent();

  console.log("[15a] ✓ Enterprise seed complete");
}

// ---------------------------------------------------------------------------
// Shape 1: Wipro — pure SPONSOR with INVOICE funding + LICENSED_SEAT program
// ---------------------------------------------------------------------------

async function seedWipro(learners: UserWithProfiles[], owner: UserWithProfiles) {
  const org = await createRootOrg({
    name: "Wipro Limited",
    slug: "wipro",
    canSponsor: true,
    canHost: false,
    gstin: "29AABCW1234K1Z5",
    gstStateCode: "KA",
    pan: "AABCW1234K",
    billingEmail: "ap@wipro.com",
    industry: "IT Services",
    website: "https://wipro.com",
    description: "Indian multinational corporation for IT services.",
  });

  // BillingAccount with INVOICE funding (NET-60 India default)
  const billingAccount = await prisma.billingAccount.create({
    data: {
      ownerOrgId: org.id,
      billingEmail: "ap@wipro.com",
      currency: Currency.INR,
      fundingSource: FundingSource.INVOICE,
      creditLimit: 1_00_00_000 * 100, // ₹1 Cr in paise
    },
  });
  await prisma.organization.update({
    where: { id: org.id },
    data: { billingAccountId: billingAccount.id },
  });

  // PurchaseOrder (India AP 3-way match)
  const po = await prisma.purchaseOrder.create({
    data: {
      organizationId: org.id,
      poNumber: "WIP-PO-2026-0042",
      poDate: faker.date.recent({ days: 30 }),
      validUntil: faker.date.future({ years: 1 }),
      totalAmountPaise: 50_00_000 * 100, // ₹50L
      remainingAmountPaise: 50_00_000 * 100,
      currency: Currency.INR,
      status: PoStatus.ACTIVE,
    },
  });

  // Contract with annual license
  const contract = await prisma.contract.create({
    data: {
      organizationId: org.id,
      billingAccountId: billingAccount.id,
      purchaseOrderId: po.id,
      status: ContractStatus.ACTIVE,
      signedAt: faker.date.recent({ days: 45 }),
      effectiveFrom: faker.date.recent({ days: 30 }),
      effectiveTo: faker.date.future({ years: 1 }),
      paymentTermsDays: 60,
      autoRenew: true,
      // #768 lockdown — Contract.terms Json dropped; structured fields
      // (paymentTermsDays, license cap) live on typed columns.
    },
  });

  // Program: LICENSED_SEAT, 200 seats, 12 covered sessions per annual cycle
  const program = await prisma.program.create({
    data: {
      contractId: contract.id,
      type: ProgramType.LICENSED_SEAT,
      name: "Wipro Engineer Leadership Program",
      status: ProgramStatus.ACTIVE,
      coveredPlanTypes: ["CONSULTATION", "CLASS"],
      licensedSeatConfig: {
        create: {
          ratePerSeatPaise: 25_000 * 100, // ₹25K per seat/year
          cycle: BillingCycle.ANNUAL,
          coveredEngagementsPerCycle: 12, // 12 calendar occurrences per cycle
          overageBehavior: OverageBehavior.CHARGE_ORG,
          activeSeatCount: 0,
          priceCapPerEngagementPaise: 10_000 * 100, // ₹10K/engagement cap
        },
      },
    },
  });

  // OWNER membership (org admin; no program assignment needed)
  await prisma.membership.create({
    data: {
      userId: owner.id,
      organizationId: org.id,
      role: MemberRole.OWNER,
      status: MemberStatus.ACTIVE,
      departmentLabel: "Corporate-Ops",
      consulteeProfileId: owner.consulteeProfile?.id ?? null,
      payoutRecipient: PayoutRecipient.SELF,
    },
  });

  // Memberships for 3 learners + assignments
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), 0, 1);
  const periodEnd = new Date(now.getFullYear() + 1, 0, 1);

  for (let idx = 0; idx < learners.length; idx++) {
    const user = learners[idx];
    const membership = await prisma.membership.create({
      data: {
        userId: user.id,
        organizationId: org.id,
        role: MemberRole.LEARNER,
        status: MemberStatus.ACTIVE,
        departmentLabel: idx === 0 ? "EMEA-Product" : "India-Engineering",
        consulteeProfileId: user.consulteeProfile?.id ?? null,
      },
    });
    const engagements = idx === 0 ? 3 : 1;
    const assignment = await prisma.programAssignment.create({
      data: {
        programId: program.id,
        membershipId: membership.id,
        periodStart,
        periodEnd,
        engagementsUsed: engagements,
      },
    });
    // #772 B6 — back the denormalized engagementsUsed counter with the immutable
    // usage ledger so the reconcile engagements invariant (Σ UsageLedgerEntry ==
    // engagementsUsed) holds. One row per assignment carrying the full count.
    await prisma.usageLedgerEntry.create({
      data: {
        programAssignmentId: assignment.id,
        membershipId: membership.id,
        engagementsConsumed: engagements,
        priceAtBookingPaise: 200000,
        notes: "Seed: licensed-seat engagements consumed",
      },
    });
  }

  await prisma.licensedSeatConfig.update({
    where: { programId: program.id },
    data: { activeSeatCount: learners.length },
  });

  // #768 lockdown #13 — HRIS schema dropped; Merge.dev integration ships
  // when first customer asks for HRIS sync.

  // DRAFT OrganizationInvoice (awaiting IRN)
  await prisma.organizationInvoice.create({
    data: {
      billingAccountId: billingAccount.id,
      organizationId: org.id,
      purchaseOrderId: po.id,
      invoiceNumber: "INV-WIP-2026-0001",
      fiscalYear: 2026,
      status: OrgInvoiceStatus.DRAFT,
      displayCurrency: Currency.INR,
      inrEquivalentPaise: 1_00_000 * 100,
      subtotalPaise: 1_00_000 * 100,
      igstPaise: 18_000 * 100,
      totalPaise: 1_18_000 * 100,
      taxRate: 0.18,
      hsnCode: "999293",
      placeOfSupply: "KA",
      reverseCharge: false,
      gstin: "29AABCW1234K1Z5",
      irn: null,
      irpStatus: IrpStatus.PENDING,
      dueDate: faker.date.future({ years: 0.25 }),
      billingCycleStart: periodStart,
      billingCycleEnd: periodEnd,
      autoGenerated: false,
      // #768 lockdown #11 — OrganizationInvoice.items Json replaced with
      // InvoiceLineItem typed child rows.
      lineItems: {
        create: [
          {
            position: 0,
            description: "Wipro Engineer Leadership — January bookings",
            quantity: 10,
            unitPricePaise: 10_000 * 100,
          },
        ],
      },
    },
  });

  await prisma.orgAuditLog.create({
    data: {
      organizationId: org.id,
      category: "CONTRACT",
      action: "CONTRACT_CREATED",
      description: "Wipro contract signed; Engineer Leadership Program active.",
      details: { contractId: contract.id, programId: program.id },
    },
  });

  console.log(
    `[15a]   ✓ Wipro (SPONSOR, INVOICE, LICENSED_SEAT): ${learners.length} learners`,
  );
}

// ---------------------------------------------------------------------------
// Shape 2: LearnPro Agency — pure HOST with RateCard + payout account
// ---------------------------------------------------------------------------

async function seedLearnPro(owner: UserWithProfiles, agencyConsultants: UserWithProfiles[]) {
  const org = await createRootOrg({
    name: "LearnPro Academy",
    slug: "learnpro-academy",
    canSponsor: false,
    canHost: true,
    industry: "Education Services",
    website: "https://learnpro.example",
    description: "Coaching agency aggregating independent experts.",
    isPublic: true,
    directoryType: OrgDirectoryType.CONSULTING_AGENCY,
    sizeBucket: OrgSizeBucket.SMALL_1_50,
  });

  const rateCard = await prisma.rateCard.create({
    data: {
      ownerOrgId: org.id,
      platformBps: 1000, // 10%
      orgBps: 1000, // 10%
      consultantBps: 8000, // 80%
    },
  });

  await prisma.organizationPayoutAccount.create({
    data: {
      organizationId: org.id,
      accountHolderName: "LearnPro Academy Pvt Ltd",
      accountNumberEncrypted: Buffer.from("LP-1234567890").toString("base64"),
      accountNumberLast4: "7890",
      bankName: "HDFC Bank",
      ifscCode: "HDFC0001234",
      razorpayContactId: "cont_" + faker.string.alphanumeric(14),
      razorpayFundAccountId: "fa_" + faker.string.alphanumeric(14),
      status: "VERIFIED",
      verifiedAt: faker.date.recent({ days: 60 }),
    },
  });

  // OWNER membership — required so the org has an admin who can log in
  await prisma.membership.create({
    data: {
      userId: owner.id,
      organizationId: org.id,
      role: MemberRole.OWNER,
      status: MemberStatus.ACTIVE,
      departmentLabel: "Management",
      consultantProfileId: owner.consultantProfile?.id ?? null,
      payoutRecipient: PayoutRecipient.SELF,
    },
  });

  for (let idx = 0; idx < agencyConsultants.length; idx++) {
    const user = agencyConsultants[idx];
    if (!user.consultantProfile) continue;
    await prisma.consultantProfile.update({
      where: { id: user.consultantProfile.id },
      data: {
        panNumber: `ABCDE${String(1000 + idx)}F`,
        residencyStatus: ResidencyStatus.RESIDENT,
        tdsSection: "194J",
        tdsRateBps: 1000, // 10% (#781 §C — bps)
        msmeStatus: idx < 2 ? MsmeStatus.MICRO : MsmeStatus.NONE,
        udyamNumber:
          idx < 2 ? `UDYAM-KA-01-000000${idx + 1}` : null,
        writtenAgreementWithFamiliarise: true,
        providerCountry: "IN",
      },
    });
    await prisma.membership.create({
      data: {
        userId: user.id,
        organizationId: org.id,
        role: MemberRole.EXPERT,
        status: MemberStatus.ACTIVE,
        consultantProfileId: user.consultantProfile.id,
        payoutRecipient: PayoutRecipient.SELF,
        rateCardOverrideId: idx === 0 ? rateCard.id : null,
      },
    });
  }

  await prisma.orgAuditLog.create({
    data: {
      organizationId: org.id,
      // OrgAuditCategory.MEMBER is unrelated to MemberRole.LEARNER — this
      // category bucket describes "membership lifecycle events" across all
      // roles, not just learners.
      category: "MEMBER",
      action: "MEMBER_ADDED",
      description: `${agencyConsultants.length} consultants added to LearnPro panel`,
    },
  });

  console.log(
    `[15a]   ✓ LearnPro (HOST): ${agencyConsultants.length} consultants, RateCard 10/10/80`,
  );
}

// ---------------------------------------------------------------------------
// Shape 3: IIT Madras — HYBRID with WALLET funding + CREDIT_POOL program
// ---------------------------------------------------------------------------

async function seedIit(params: {
  owner: UserWithProfiles;
  internalProfessors: UserWithProfiles[];
  externalConsultants: UserWithProfiles[];
  students: UserWithProfiles[];
}) {
  const org = await createRootOrg({
    name: "Indian Institute of Technology Madras",
    slug: "iit-madras",
    canSponsor: true,
    canHost: true,
    gstin: "33AAACT5678M1Z9",
    gstStateCode: "TN",
    pan: "AAACT5678M",
    billingEmail: "dean-academics@iitm.ac.in",
    industry: "Higher Education",
    website: "https://iitm.ac.in",
    description: "Public research university; hybrid buyer+provider.",
    isPublic: true,
    directoryType: OrgDirectoryType.LEARNING_INSTITUTION,
    sizeBucket: OrgSizeBucket.ENTERPRISE_1000_PLUS,
  });

  // BillingAccount with WALLET funding (GLG-style)
  const billingAccount = await prisma.billingAccount.create({
    data: {
      ownerOrgId: org.id,
      billingEmail: "dean-academics@iitm.ac.in",
      currency: Currency.INR,
      fundingSource: FundingSource.WALLET,
      walletBalance: 0,
    },
  });
  await prisma.organization.update({
    where: { id: org.id },
    data: { billingAccountId: billingAccount.id },
  });

  // Contract with credit-pool program (1 credit = ₹1)
  const contract = await prisma.contract.create({
    data: {
      organizationId: org.id,
      billingAccountId: billingAccount.id,
      status: ContractStatus.ACTIVE,
      effectiveFrom: faker.date.recent({ days: 30 }),
      effectiveTo: faker.date.future({ years: 1 }),
      paymentTermsDays: 0, // wallet is prepaid
      // #768 lockdown — Contract.terms Json dropped.
    },
  });

  const program = await prisma.program.create({
    data: {
      contractId: contract.id,
      type: ProgramType.CREDIT_POOL,
      name: "IIT Student Coaching Pool",
      status: ProgramStatus.ACTIVE,
      coveredPlanTypes: ["CONSULTATION", "SUBSCRIPTION"],
      creditPoolConfig: {
        create: {
          cycle: "MONTHLY",
          creditBudgetPerCycle: 10_000, // 10k credits = ₹10k / month
        },
      },
    },
  });

  // #772 B3/B6 — wallet movements are double-entry journal postings; the org's
  // WALLET LedgerAccount is the source of truth and walletBalance is its derived
  // cache. Seed 3 confirmed top-ups (Dr CASH / Cr WALLET) + 5 booking debits
  // (Dr WALLET / Cr PLATFORM_FEE) so reconcile sees a balanced journal whose
  // WALLET balance equals the cache.
  const TOPUP_PAISE = 5_00_000 * 100; // ₹5L each
  const DEBIT_PAISE = 5_000 * 100; // ₹5K each
  const now = new Date();

  for (let i = 0; i < 3; i++) {
    const orderId = `order_iit_topup_${i + 1}_${faker.string.alphanumeric(8)}`;
    await prisma.walletTopUp.create({
      data: {
        billingAccountId: billingAccount.id,
        providerOrderId: orderId,
        providerPaymentId: `pay_${faker.string.alphanumeric(14)}`,
        amountPaise: TOPUP_PAISE,
        status: "CONFIRMED",
        confirmedAt: now,
        notes: `Razorpay top-up #${i + 1}`,
      },
    });
    await postLedgerTxn(prisma, {
      idempotencyKey: `topup:${orderId}`,
      kind: "TOPUP",
      postings: [
        {
          account: { kind: "CASH", currency: "INR" },
          direction: "DEBIT",
          amountPaise: TOPUP_PAISE,
        },
        {
          account: { kind: "WALLET", organizationId: org.id, currency: "INR" },
          direction: "CREDIT",
          amountPaise: TOPUP_PAISE,
        },
      ],
    });
  }

  for (let i = 0; i < 5; i++) {
    await postLedgerTxn(prisma, {
      idempotencyKey: `seed-booking:${billingAccount.id}:${i + 1}`,
      kind: "BOOKING",
      postings: [
        {
          account: { kind: "WALLET", organizationId: org.id, currency: "INR" },
          direction: "DEBIT",
          amountPaise: DEBIT_PAISE,
        },
        {
          account: { kind: "PLATFORM_FEE", currency: "INR" },
          direction: "CREDIT",
          amountPaise: DEBIT_PAISE,
        },
      ],
    });
  }

  await prisma.billingAccount.update({
    where: { id: billingAccount.id },
    data: { walletBalance: TOPUP_PAISE * 3 - DEBIT_PAISE * 5 },
  });

  // OWNER membership (dean / org admin; payoutRecipient=ORGANIZATION for internal salaried)
  if (params.owner.consultantProfile) {
    await prisma.membership.create({
      data: {
        userId: params.owner.id,
        organizationId: org.id,
        role: MemberRole.OWNER,
        status: MemberStatus.ACTIVE,
        departmentLabel: "Academic-Leadership",
        consultantProfileId: params.owner.consultantProfile.id,
        payoutRecipient: PayoutRecipient.ORGANIZATION,
      },
    });
  }

  // Internal professors (payoutRecipient=ORGANIZATION → salaried)
  for (const prof of params.internalProfessors) {
    if (!prof.consultantProfile) continue;
    await prisma.membership.create({
      data: {
        userId: prof.id,
        organizationId: org.id,
        role: MemberRole.EXPERT,
        status: MemberStatus.ACTIVE,
        consultantProfileId: prof.consultantProfile.id,
        payoutRecipient: PayoutRecipient.ORGANIZATION,
        departmentLabel: "Academic-Faculty",
      },
    });
  }

  // External consultants (payoutRecipient=SELF)
  for (const ext of params.externalConsultants) {
    if (!ext.consultantProfile) continue;
    await prisma.membership.create({
      data: {
        userId: ext.id,
        organizationId: org.id,
        role: MemberRole.EXPERT,
        status: MemberStatus.ACTIVE,
        consultantProfileId: ext.consultantProfile.id,
        payoutRecipient: PayoutRecipient.SELF,
        departmentLabel: "External-Panel",
      },
    });
  }

  // Students (MEMBER role) + program assignments
  const periodStart = new Date(now.getFullYear(), 0, 1);
  const periodEnd = new Date(now.getFullYear() + 1, 0, 1);

  for (const student of params.students) {
    const membership = await prisma.membership.create({
      data: {
        userId: student.id,
        organizationId: org.id,
        role: MemberRole.LEARNER,
        status: MemberStatus.ACTIVE,
        consulteeProfileId: student.consulteeProfile?.id ?? null,
        departmentLabel: "CSE-UG-2026",
      },
    });
    await prisma.programAssignment.create({
      data: {
        programId: program.id,
        membershipId: membership.id,
        periodStart,
        periodEnd,
      },
    });
  }

  // Payout account (hosting side)
  await prisma.organizationPayoutAccount.create({
    data: {
      organizationId: org.id,
      accountHolderName: "IIT Madras Research Funds",
      accountNumberEncrypted: Buffer.from("IIT-98765432100").toString("base64"),
      accountNumberLast4: "2100",
      bankName: "State Bank of India",
      ifscCode: "SBIN0001234",
      status: "VERIFIED",
      verifiedAt: faker.date.recent({ days: 90 }),
    },
  });

  console.log(
    `[15a]   ✓ IIT Madras (HYBRID, WALLET, CREDIT_POOL): wallet ₹${((TOPUP_PAISE * 3 - DEBIT_PAISE * 5) / 100).toLocaleString("en-IN")} remaining`,
  );
}

// ---------------------------------------------------------------------------
// Shape 4: Rahul (solo consultant) — personal org, canHost=true only
// ---------------------------------------------------------------------------

async function seedSoloConsultant(user: UserWithProfiles) {
  if (!user.consultantProfile) return;

  const org = await createRootOrg({
    name: `${user.name}'s Coaching`,
    slug: `${slugify(user.name)}-coaching-${faker.string.alphanumeric(4).toLowerCase()}`,
    canSponsor: false,
    canHost: true,
    status: OrgStatus.ACTIVE,
    industry: "Independent Coaching",
  });

  await prisma.membership.create({
    data: {
      userId: user.id,
      organizationId: org.id,
      role: MemberRole.OWNER,
      status: MemberStatus.ACTIVE,
      consultantProfileId: user.consultantProfile.id,
      payoutRecipient: PayoutRecipient.SELF,
    },
  });

  console.log(`[15a]   ✓ Solo consultant org: ${org.name}`);
}

// ---------------------------------------------------------------------------
// DPDP consent artifacts
// ---------------------------------------------------------------------------

async function seedConsentArtifacts(users: UserWithProfiles[]) {
  // Stamp the canonical runtime purpose codes that `checkConsent` (fail-closed)
  // gates on — mirror the signup hook (lib/auth.ts) so seeded users behave like
  // real signups. STREAM_DATA_PROCESSING is what actions/stream/chat/user.action.ts
  // checks before handing PII to Stream; without it every seeded user fails the
  // Stream upsert on dashboard load. Codes come from the single canonical
  // taxonomy (lib/compliance/purpose-codes.ts) the whole app now shares.
  // One artifact PER purpose code (mirror the signup hook in lib/auth.ts).
  // A single artifact bundling both codes would let a scoped withdrawal of
  // one code revoke the other, since withdrawConsent stamps the whole artifact
  // matching the target code. language "en-IN" for consistency with signup.
  for (const u of users) {
    for (const purposeCode of [
      PURPOSE_CODES.PRIMARY_PROCESSING,
      PURPOSE_CODES.STREAM_DATA_PROCESSING,
      // #701 — session-booking consent, gated fail-closed at org-sponsored
      // checkout. Mirror the signup hook so seeded users behave like signups.
      PURPOSE_CODES.SESSION_BOOKING,
    ] as const) {
      const draft = buildConsentArtifact({
        userId: u.id,
        dataFiduciary: "Familiarise Pvt Ltd",
        purposeCodes: [purposeCode],
        language: "en-IN",
        version: 1,
      });
      await prisma.consentArtifact.create({ data: draft });
    }
  }
  console.log(`[15a]   ✓ ConsentArtifact seeded for ${users.length} users`);
}

// ---------------------------------------------------------------------------
// Tour owner — dedicated ORG_WORKSPACE with deterministic credentials (#723)
// ---------------------------------------------------------------------------

const TOUR_OWNER_EMAIL = "tour-owner@familiarise.dev";

async function seedTourOwner(): Promise<void> {
  // Adopt the canonical Wipro org as this owner's primary org. Skip the
  // seed if Wipro didn't materialize (smaller seed mode) — the tour
  // matrix only needs an ORG_WORKSPACE attached to *some* seed org.
  const wipro = await prisma.organization.findUnique({
    where: { slug: "wipro" },
    select: { id: true, name: true },
  });
  if (!wipro) {
    console.warn(
      "[15a]   skipping tour-owner seed — Wipro org not found (smaller seed mode?)",
    );
    return;
  }

  const hashedPassword = await bcrypt.hash(SEED_PASSWORD, 12);

  // 1. User row (idempotent via email upsert)
  const user = await prisma.user.upsert({
    where: { email: TOUR_OWNER_EMAIL },
    update: { role: UserRole.ORG_WORKSPACE },
    create: {
      email: TOUR_OWNER_EMAIL,
      name: "Tour Owner",
      emailVerified: true,
      role: UserRole.ORG_WORKSPACE,
      onboardingCompleted: true,
      timezone: "Asia/Kolkata",
      country: "India",
    },
    select: { id: true },
  });

  // 2. BetterAuth credential account — keyed (userId, providerId='credential')
  // composite, so we look up first and only create when missing. Updating an
  // existing row also keeps the password hash fresh if SEED_PASSWORD rotates.
  const existingCred = await prisma.account.findFirst({
    where: { userId: user.id, providerId: "credential" },
    select: { id: true },
  });
  if (existingCred) {
    await prisma.account.update({
      where: { id: existingCred.id },
      data: { password: hashedPassword },
    });
  } else {
    await prisma.account.create({
      data: {
        userId: user.id,
        accountId: user.id,
        providerId: "credential",
        password: hashedPassword,
      },
    });
  }

  // 3. OrgWorkspaceProfile + User.orgWorkspaceProfileId link (mirror the runtime
  // lazy-create at app/api/organizations/route.ts:288).
  const orgWorkspace = await prisma.orgWorkspaceProfile.upsert({
    where: { userId: user.id },
    create: { userId: user.id },
    update: {},
    select: { id: true },
  });
  await prisma.user.updateMany({
    where: { id: user.id, orgWorkspaceProfileId: null },
    data: { orgWorkspaceProfileId: orgWorkspace.id },
  });

  // 4. OWNER membership in Wipro (idempotent — skip if already present)
  const existingMembership = await prisma.membership.findFirst({
    where: { userId: user.id, organizationId: wipro.id },
    select: { id: true },
  });
  if (!existingMembership) {
    await prisma.membership.create({
      data: {
        userId: user.id,
        organizationId: wipro.id,
        role: MemberRole.OWNER,
        status: MemberStatus.ACTIVE,
        departmentLabel: "Tour-Owner",
        payoutRecipient: PayoutRecipient.SELF,
      },
    });
  }

  console.log(
    `[15a]   ✓ Tour owner seeded: ${TOUR_OWNER_EMAIL} (password: ${SEED_PASSWORD}) — OWNER of ${wipro.name}`,
  );
}

// ---------------------------------------------------------------------------
// Derived-flag reconcile
// ---------------------------------------------------------------------------

async function reconcileSeededIsIndependent(): Promise<void> {
  const hosted = await prisma.membership.findMany({
    where: {
      role: MemberRole.EXPERT,
      status: MemberStatus.ACTIVE,
      organization: { canHost: true },
      consultantProfileId: { not: null },
    },
    select: { consultantProfileId: true },
    distinct: ["consultantProfileId"],
  });

  const ids = hosted
    .map((m) => m.consultantProfileId)
    .filter((id): id is string => Boolean(id));

  if (ids.length === 0) return;

  const { count } = await prisma.consultantProfile.updateMany({
    where: { id: { in: ids }, isIndependent: true },
    data: { isIndependent: false },
  });

  console.log(
    `[15a]   ✓ isIndependent reconciled for ${count} hosted consultant(s)`,
  );
}
