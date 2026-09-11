/**
 * Seed Configuration System
 *
 * Controls data volume for different seeding scenarios:
 * - small: Quick dev iteration (default)
 * - medium: Pagination/search testing
 * - large: Performance testing
 *
 * Usage:
 *   SEED_MODE=small npx prisma db seed
 *   SEED_MODE=medium npx prisma db seed
 *   SEED_MODE=large npx prisma db seed
 */

export type SeedMode = "small" | "medium" | "large";

export interface UserVolumes {
  consultants: number;
  consultees: number;
  staff: number;
  admins: number;
}

export interface VolumeConfig {
  users: UserVolumes;
  // Phase 2: Professional background
  workExperiencesPerConsultant: { min: number; max: number };
  certificationsPerConsultant: { min: number; max: number };
  educationPerPerson: { min: number; max: number };
  // Phase 3: Topics
  topics: number;
  // Phase 4: Plans
  plansPerConsultant: number;
  classContentsPerPlan: { min: number; max: number };
  // Phase 5: Availability
  weeklySlotsPerConsultant: { min: number; max: number };
  customSlotsPerConsultant: { min: number; max: number };
  // Phase 6: Appointments
  appointments: {
    consultation: number;
    subscription: number;
    webinar: number;
    class: number;
  };
  // Phase 6b: authored-but-not-live group sessions (WebinarStatus/ClassStatus
  // DRAFT). Deliberately small — a draft is a work-in-progress, not a state a
  // catalog accumulates.
  draftSessions: { webinar: number; class: number };
  // Phase 6c: reschedule proposals. `resolved` rows land on appointments that
  // already carry an open one, which is what exercises the nullable-unique
  // openForAppointmentId without colliding.
  rescheduleProposals: {
    openConsultation: number;
    counteredSubscription: number;
    resolved: number;
  };
  // Phase 7: Engagement
  waitlistSubscribers: number;
  reviewsPercentage: number; // % of consultants that get reviews
  // Phase 8: Payments
  discountCodes: number;
  payments: number;
  // Phase 9: Support & Feedback
  feedbacks: number;
  supportTickets: number;
  responsesPerTicket: { min: number; max: number };
  // Phase 11: Documents & Meetings
  appointmentDocuments: number;
  meetingSessions: number;
  recordingsPerSession: number;
  // Phase 12: Payment Extensions
  refunds: number;
  disputes: number;
  // Phase 13: Payout System
  payoutAccountsPerConsultant: { min: number; max: number };
  earningsPercentage: number; // % of payments that generate earnings
  payoutsPercentage: number; // % of earnings that get paid out
  invoicesPercentage: number; // % of payments that get invoices
  // Phase 15: Enterprise Organizations
  organizations: {
    buyer: number;
    seatPack: number;
    invoiced: number;
    provider: number;
    hybrid: number;
  };
  membersPerOrg: { min: number; max: number };
  plansPerOrg: { min: number; max: number };
}

/**
 * Volume configurations for each seed mode
 */
const VOLUMES: Record<SeedMode, VolumeConfig> = {
  small: {
    users: {
      consultants: 30,
      consultees: 40,
      staff: 4,
      admins: 3,
    },
    workExperiencesPerConsultant: { min: 1, max: 3 },
    certificationsPerConsultant: { min: 1, max: 2 },
    educationPerPerson: { min: 1, max: 2 },
    topics: 50,
    plansPerConsultant: 2,
    classContentsPerPlan: { min: 2, max: 4 },
    weeklySlotsPerConsultant: { min: 3, max: 5 },
    customSlotsPerConsultant: { min: 1, max: 3 },
    appointments: {
      consultation: 75,
      subscription: 150,
      webinar: 75,
      class: 75,
    },
    draftSessions: { webinar: 3, class: 2 },
    rescheduleProposals: {
      openConsultation: 4,
      counteredSubscription: 2,
      resolved: 3,
    },
    waitlistSubscribers: 50,
    reviewsPercentage: 60,
    discountCodes: 5,
    payments: 100,
    feedbacks: 35,
    supportTickets: 20,
    responsesPerTicket: { min: 1, max: 3 },
    appointmentDocuments: 60,
    meetingSessions: 75,
    recordingsPerSession: 0.5,
    refunds: 15,
    disputes: 8,
    payoutAccountsPerConsultant: { min: 1, max: 2 },
    earningsPercentage: 70,
    payoutsPercentage: 50,
    invoicesPercentage: 80,
    organizations: {
      buyer: 2,
      seatPack: 1,
      invoiced: 1,
      provider: 2,
      hybrid: 1,
    },
    membersPerOrg: { min: 3, max: 6 },
    plansPerOrg: { min: 1, max: 2 },
  },

  medium: {
    users: {
      consultants: 80,
      consultees: 120,
      staff: 12,
      admins: 8,
    },
    workExperiencesPerConsultant: { min: 2, max: 5 },
    certificationsPerConsultant: { min: 1, max: 4 },
    educationPerPerson: { min: 1, max: 3 },
    topics: 100,
    plansPerConsultant: 3,
    classContentsPerPlan: { min: 3, max: 6 },
    weeklySlotsPerConsultant: { min: 4, max: 7 },
    customSlotsPerConsultant: { min: 2, max: 5 },
    appointments: {
      consultation: 200,
      subscription: 400,
      webinar: 200,
      class: 200,
    },
    draftSessions: { webinar: 6, class: 4 },
    rescheduleProposals: {
      openConsultation: 12,
      counteredSubscription: 5,
      resolved: 8,
    },
    waitlistSubscribers: 150,
    reviewsPercentage: 75,
    discountCodes: 15,
    payments: 500,
    feedbacks: 150,
    supportTickets: 80,
    responsesPerTicket: { min: 1, max: 5 },
    appointmentDocuments: 250,
    meetingSessions: 350,
    recordingsPerSession: 0.6,
    refunds: 60,
    disputes: 30,
    payoutAccountsPerConsultant: { min: 1, max: 3 },
    earningsPercentage: 75,
    payoutsPercentage: 60,
    invoicesPercentage: 85,
    organizations: {
      buyer: 4,
      seatPack: 2,
      invoiced: 2,
      provider: 2,
      hybrid: 1,
    },
    membersPerOrg: { min: 4, max: 8 },
    plansPerOrg: { min: 1, max: 3 },
  },

  large: {
    users: {
      consultants: 150,
      consultees: 250,
      staff: 25,
      admins: 15,
    },
    workExperiencesPerConsultant: { min: 2, max: 5 },
    certificationsPerConsultant: { min: 2, max: 5 },
    educationPerPerson: { min: 1, max: 3 },
    topics: 200,
    plansPerConsultant: 4,
    classContentsPerPlan: { min: 4, max: 8 },
    weeklySlotsPerConsultant: { min: 5, max: 10 },
    customSlotsPerConsultant: { min: 3, max: 7 },
    appointments: {
      consultation: 500,
      subscription: 1000,
      webinar: 500,
      class: 500,
    },
    draftSessions: { webinar: 12, class: 8 },
    rescheduleProposals: {
      openConsultation: 30,
      counteredSubscription: 12,
      resolved: 20,
    },
    waitlistSubscribers: 400,
    reviewsPercentage: 85,
    discountCodes: 30,
    payments: 1200,
    feedbacks: 400,
    supportTickets: 200,
    responsesPerTicket: { min: 1, max: 7 },
    appointmentDocuments: 600,
    meetingSessions: 800,
    recordingsPerSession: 0.7,
    refunds: 150,
    disputes: 80,
    payoutAccountsPerConsultant: { min: 1, max: 3 },
    earningsPercentage: 80,
    payoutsPercentage: 65,
    invoicesPercentage: 90,
    organizations: {
      buyer: 8,
      seatPack: 4,
      invoiced: 3,
      provider: 2,
      hybrid: 1,
    },
    membersPerOrg: { min: 5, max: 10 },
    plansPerOrg: { min: 2, max: 4 },
  },
};

/**
 * Gets the current seed mode from environment variables
 * Defaults to 'small' if not specified or invalid
 */
const VALID_SEED_MODES: readonly SeedMode[] = ["small", "medium", "large"];

function isSeedMode(value: string): value is SeedMode {
  return VALID_SEED_MODES.includes(value as SeedMode);
}

export function getSeedMode(): SeedMode {
  const mode = process.env.SEED_MODE?.toLowerCase();
  if (mode && isSeedMode(mode)) {
    return mode;
  }
  return "small";
}

/**
 * Gets the volume configuration for the current seed mode
 */
export function getVolumeConfig(): VolumeConfig {
  return VOLUMES[getSeedMode()];
}

/**
 * Gets the total number of users for the current mode
 */
export function getTotalUsers(): number {
  const { users } = getVolumeConfig();
  return users.consultants + users.consultees + users.staff + users.admins;
}

/**
 * Gets the total number of appointments for the current mode
 */
export function getTotalAppointments(): number {
  const { appointments } = getVolumeConfig();
  return (
    appointments.consultation +
    appointments.subscription +
    appointments.webinar +
    appointments.class
  );
}

/**
 * Main configuration object - use this in seed files
 */
export const config = {
  mode: getSeedMode(),
  volumes: getVolumeConfig(),
  batchSize: parseInt(process.env.SEED_BATCH_SIZE || "50", 10),
  logInterval: parseInt(process.env.SEED_LOG_INTERVAL || "10", 10),
};

/**
 * Prints configuration summary at seed start
 */
export function printConfigSummary(): void {
  const mode = getSeedMode();
  const volumes = getVolumeConfig();
  const totalUsers = getTotalUsers();
  const totalAppointments = getTotalAppointments();

  console.log("=".repeat(60));
  console.log(`SEED MODE: ${mode.toUpperCase()}`);
  console.log("=".repeat(60));
  console.log("Volume Configuration:");
  console.log(`  Users: ${totalUsers} total`);
  console.log(`    - Consultants: ${volumes.users.consultants}`);
  console.log(`    - Consultees: ${volumes.users.consultees}`);
  console.log(`    - Staff: ${volumes.users.staff}`);
  console.log(`    - Admins: ${volumes.users.admins}`);
  console.log(`  Appointments: ${totalAppointments} total`);
  console.log(`    - Consultation: ${volumes.appointments.consultation}`);
  console.log(`    - Subscription: ${volumes.appointments.subscription}`);
  console.log(`    - Webinar: ${volumes.appointments.webinar}`);
  console.log(`    - Class: ${volumes.appointments.class}`);
  console.log(
    `    - Drafts: ${volumes.draftSessions.webinar} webinar, ${volumes.draftSessions.class} class`,
  );
  const proposals = volumes.rescheduleProposals;
  console.log(
    `  Reschedule proposals: ${proposals.openConsultation} open, ${proposals.counteredSubscription} countered, ${proposals.resolved} resolved`,
  );
  console.log(`  Payments: ${volumes.payments}`);
  console.log(`  Topics: ${volumes.topics}`);
  const orgs = volumes.organizations;
  console.log(
    `  Organizations: ${orgs.buyer + orgs.seatPack + orgs.invoiced + orgs.provider + orgs.hybrid} total`,
  );
  // Counter keys (buyer / seatPack / invoiced / provider) are kept as-is
  // to avoid cascading the rename into the shared Volumes type; only the
  // human-readable log labels are refreshed to the Arch-4 vocabulary.
  console.log(
    `    - SPONSOR: PERSONAL: ${orgs.buyer}, WALLET: ${orgs.seatPack}, INVOICE: ${orgs.invoiced}`,
  );
  console.log(`    - HOST: ${orgs.provider}, HYBRID: ${orgs.hybrid}`);
  console.log("=".repeat(60));
}

/**
 * Helper to get a random number within a range config
 */
export function getRandomInRange(range: { min: number; max: number }): number {
  return Math.floor(Math.random() * (range.max - range.min + 1)) + range.min;
}
