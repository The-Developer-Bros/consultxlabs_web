import "dotenv/config";
import prisma from "../lib/prisma";
import { printConfigSummary } from "./seedFiles/config";

// Phase 1: Core entities
import { createUsers } from "./seedFiles/1a-create-users";

// Phase 2: Professional background
import { createWorkExperiences } from "./seedFiles/2a-create-work-experiences";
import { createCertifications } from "./seedFiles/2b-create-certifications";
import { createConsultantEducation } from "./seedFiles/2c-create-consultant-education";
import { createConsulteeEducation } from "./seedFiles/2d-create-consultee-education";
import { createAchievements } from "./seedFiles/2e-create-achievements";

// Phase 3: Topics
import { createTopics } from "./seedFiles/3a-create-topics";

// Phase 4: Plans
import { createConsultationPlans } from "./seedFiles/4a-create-consultation-plans";
import { createSubscriptionPlans } from "./seedFiles/4b-create-subscription-plans";
import { createWebinarPlans } from "./seedFiles/4c-create-webinar-plans";
import { createClassPlans } from "./seedFiles/4d-create-class-plans";

// Phase 5: Availability
import { createSlotsOfAvailability } from "./seedFiles/5a-create-slots-of-availability";

// Phase 6: Appointments
import { createAppointments } from "./seedFiles/6a-create-appointments";
import { createDraftSessions } from "./seedFiles/6b-create-draft-sessions";
import { createRescheduleProposals } from "./seedFiles/6c-create-reschedule-proposals";

// Phase 7: Engagement
import { createWaitlistSubscribers } from "./seedFiles/7a-create-waitlist-subscribers";
import { createConsultantReviews } from "./seedFiles/7b-create-consultant-reviews";

// Phase 8: Payments
import { createDiscountCodes } from "./seedFiles/8a-create-discount-codes";
import { createPayments } from "./seedFiles/8b-create-payments";

// Phase 9: Support & Feedback
import { createFeedbacks } from "./seedFiles/9a-create-feedbacks";
import { createSupportTickets } from "./seedFiles/9b-create-support-tickets";

// Phase 11: Documents & Meetings
import { createAppointmentDocuments } from "./seedFiles/11a-create-appointment-documents";
import { createMeetingSessions } from "./seedFiles/11b-create-meeting-sessions";

// Phase 12: Payment Extensions
import { createRefunds } from "./seedFiles/12a-create-refunds";
import { createDisputes } from "./seedFiles/12b-create-disputes";

// Phase 13: Payout System
import { createPayoutAccounts } from "./seedFiles/13a-create-payout-accounts";
import { createConsultantEarnings } from "./seedFiles/13b-create-consultant-earnings";
import { createPayouts } from "./seedFiles/13c-create-payouts";
// 13d-create-invoices removed in #768 lockdown (legacy Invoice model dropped).

// Phase 14: Referrals & Collaborators
import { createReferralCodes } from "./seedFiles/14a-create-referral-codes";
import { createCollaborators } from "./seedFiles/14b-create-collaborators";

// Phase 15: Enterprise Organizations
import { createOrganizations } from "./seedFiles/15a-create-organizations";
import { createOrgCatalog } from "./seedFiles/15b-create-org-catalog";

// Phase 16: Statutory lookups (#778 §D)
import { createTdsRates } from "./seedFiles/16a-create-tds-rates";
import { createPlatformCancellationPolicy } from "./seedFiles/16b-create-cancellation-policy";

async function seed() {
  console.log("Starting seed process...");

  // Print configuration summary based on SEED_MODE
  printConfigSummary();

  const startTime = Date.now();

  try {
    // Phase 1: Core entities (users and profiles)
    console.log("\n[Phase 1] Creating users and profiles...");
    const users = await createUsers();
    const consultants = users.filter((user) => user.role === "CONSULTANT");
    const consultees = users.filter((user) => user.role === "CONSULTEE");
    const admins = users.filter((user) => user.role === "ADMIN");
    const staff = users.filter((user) => user.role === "STAFF");

    console.log(`  Created ${consultants.length} consultants`);
    console.log(`  Created ${consultees.length} consultees`);
    console.log(`  Created ${admins.length} admins`);
    console.log(`  Created ${staff.length} staff members`);

    // Phase 2: Professional background (for consultants)
    console.log("\n[Phase 2] Creating professional background data...");
    console.log("Creating work experiences...");
    await createWorkExperiences(consultants);

    console.log("Creating certifications...");
    await createCertifications(consultants);

    console.log("Creating consultant education records...");
    await createConsultantEducation(consultants);

    console.log("Creating consultee education history...");
    await createConsulteeEducation(consultees);

    console.log("Creating consultant achievements...");
    await createAchievements(consultants);

    // Phase 3: Topics (needed for webinars and classes)
    console.log("\n[Phase 3] Creating topics...");
    await createTopics();

    // Phase 4: Plans and offerings
    console.log("\n[Phase 4] Creating plans and offerings...");
    console.log("Creating consultation plans...");
    await createConsultationPlans(consultants);

    console.log("Creating subscription plans...");
    await createSubscriptionPlans(consultants);

    console.log("Creating webinar plans...");
    await createWebinarPlans(consultants);

    console.log("Creating class plans...");
    await createClassPlans(consultants);

    // Phase 5: Availability
    console.log("\n[Phase 5] Creating availability slots...");
    await createSlotsOfAvailability(consultants);

    // Phase 6: Appointments and bookings
    console.log("\n[Phase 6] Creating appointments (this may take a while)...");
    await createAppointments(consultees);

    // Drafts are instances with no appointment at all, so they follow the
    // booked ones rather than sharing their path.
    console.log("Creating draft webinars and classes...");
    await createDraftSessions();

    // Must follow createAppointments: a proposal releases slots that only
    // exist once the bookings do.
    console.log("Creating reschedule proposals...");
    await createRescheduleProposals();

    // Phase 7: Engagement data
    console.log("\n[Phase 7] Creating engagement data...");
    console.log("Creating waitlist subscribers...");
    await createWaitlistSubscribers();

    console.log("Creating consultant reviews...");
    await createConsultantReviews(consultants, consultees);

    // Phase 8: Payment-related data
    console.log("\n[Phase 8] Creating payment-related data...");
    console.log("Creating discount codes...");
    await createDiscountCodes();

    console.log("Creating payments...");
    await createPayments(users);

    // Phase 9: Support & Feedback
    console.log("\n[Phase 9] Creating support & feedback data...");
    console.log("Creating feedbacks...");
    await createFeedbacks(users);

    console.log("Creating support tickets...");
    await createSupportTickets(users);

    // Phase 11: Documents & Meetings
    console.log("\n[Phase 11] Creating documents & meeting sessions...");
    console.log("Creating appointment documents...");
    await createAppointmentDocuments();

    console.log("Creating meeting sessions...");
    await createMeetingSessions();

    // Phase 12: Payment Extensions
    console.log("\n[Phase 12] Creating payment extensions...");
    console.log("Creating refunds...");
    await createRefunds();

    console.log("Creating disputes...");
    await createDisputes();

    // Phase 13: Payout System
    console.log("\n[Phase 13] Creating payout system data...");
    console.log("Creating payout accounts...");
    await createPayoutAccounts();

    console.log("Creating consultant earnings...");
    await createConsultantEarnings();

    console.log("Creating payouts...");
    await createPayouts();

    // Phase 14: Referrals & Collaborators
    console.log("\n[Phase 14] Creating referrals & collaborators...");
    console.log("Creating referral codes...");
    await createReferralCodes();

    console.log("Creating collaborators...");
    await createCollaborators();

    // Phase 15: Enterprise Organizations
    console.log("\n[Phase 15] Creating enterprise organizations...");
    await createOrganizations(users);

    // Must follow createOrganizations: the catalog attaches to canHost orgs
    // and needs their ACTIVE EXPERT memberships to name a deliverer.
    console.log("Creating org-owned catalog plans...");
    await createOrgCatalog();

    // Phase 16: Statutory lookups
    console.log("\n[Phase 16] Seeding statutory TDS rates...");
    await createTdsRates();

    // #1499 — the platform refund ladder every booking falls back to. Appointment
    // seeds leave the FK null on purpose, which reads as this ladder anyway.
    console.log("Seeding the platform cancellation policy...");
    await createPlatformCancellationPolicy();

    // Summary
    const endTime = Date.now();
    const timeElapsed = (endTime - startTime) / 1000;
    console.log("\n" + "=".repeat(60));
    console.log("SEED COMPLETED SUCCESSFULLY");
    console.log("=".repeat(60));
    console.log(`\nTotal time: ${timeElapsed.toFixed(2)} seconds`);
    console.log("\nSummary:");
    console.log(`  - Users: ${users.length}`);
    console.log(`    - Consultants: ${consultants.length}`);
    console.log(`    - Consultees: ${consultees.length}`);
    console.log(`    - Staff: ${staff.length}`);
    console.log(`    - Admins: ${admins.length}`);
  } catch (error) {
    console.error("\n" + "=".repeat(60));
    console.error("SEED FAILED");
    console.error("=".repeat(60));
    console.error("Error during seed process:", error);
    throw error;
  }
}

seed()
  .catch((e) => {
    console.error("Error in seed function:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
