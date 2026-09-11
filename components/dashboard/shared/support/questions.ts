export interface FAQ {
  id: string;
  question: string;
  answer: string;
  category: string;
}

export const faqs: FAQ[] = [
  // Profile & Account
  {
    id: "profile-setup",
    question: "How do I set up my consultant profile?",
    answer:
      "Your consultant profile includes your headline, experience, work history, education, certifications, and domain expertise. You can add these details along with your availability schedule and service offerings.",
    category: "Profile",
  },
  {
    id: "domain-expertise",
    question: "How can I specify my domain expertise?",
    answer:
      "You can select your primary domain and multiple sub-domains, along with relevant tags to showcase your expertise areas. This helps consultees find you more easily.",
    category: "Profile",
  },

  // Scheduling
  {
    id: "availability-setup",
    question: "How do I set my availability?",
    answer:
      "You can choose between weekly recurring slots or custom time slots. For weekly slots, set your available days and times. For custom slots, specify individual date-time slots.",
    category: "Scheduling",
  },
  {
    id: "timezone-handling",
    question: "How are different time zones handled?",
    answer:
      "Your availability times in Settings are shown in your local timezone, which is automatically detected from your browser. All slots are stored in UTC internally. Consultees see your slots converted to their own timezone. If your times appear incorrect, ensure your browser's timezone setting is correct.",
    category: "Scheduling",
  },
  {
    id: "view-appointments",
    question: "How do I view my appointments?",
    answer:
      "Go to the Home tab to see your upcoming appointments at a glance. Each appointment shows the consultee name, service type, scheduled time, and meeting link. You can also filter appointments by status.",
    category: "Scheduling",
  },
  {
    id: "cancel-reschedule",
    question: "Can I cancel or reschedule an appointment?",
    answer:
      "Yes, you can cancel an upcoming appointment from your Home tab. Cancellations trigger a refund to the consultee. Rescheduling is handled by cancelling the existing appointment and having the consultee book a new slot.",
    category: "Scheduling",
  },
  {
    id: "slot-allocation-requests",
    question: "What are slot allocation requests?",
    answer:
      "Slot allocation requests appear when a consultee books a service that requires your confirmation. You can approve or decline these requests from the Home tab. Pending requests show the consultee's details and requested time slot.",
    category: "Scheduling",
  },

  // Services
  {
    id: "service-types",
    question: "What types of services can I offer?",
    answer:
      "You can offer four types of services: one-on-one consultations, subscription-based mentoring, webinars for larger groups, and structured classes.",
    category: "Services",
  },
  {
    id: "consultation-setup",
    question: "How do I set up consultation plans?",
    answer:
      "Create consultation plans by specifying duration, price, language, level, prerequisites, and learning outcomes. You can create multiple plans for different needs.",
    category: "Services",
  },

  // Meetings
  {
    id: "meeting-platforms",
    question: "What meeting platforms are supported?",
    answer:
      "We support multiple platforms including Zoom, Google Meet, Microsoft Teams, and our built-in streaming solution. You can also use a custom platform if needed.",
    category: "Meetings",
  },
  {
    id: "recording-feature",
    question: "Can I record sessions?",
    answer:
      "Recording is available for webinars and classes. The recordings are stored securely and can be accessed by participants later.",
    category: "Meetings",
  },

  // Payments
  {
    id: "payment-methods",
    question: "What payment methods are supported?",
    answer:
      "We support Stripe and Razorpay for secure payment processing. Familiarise charges a 20% platform fee — you receive 80% of each payment. Payouts become available after a hold period: 24 hours for consultations and classes, 48 hours for webinars, and 7 days for subscriptions. Minimum payout amount is ₹500.",
    category: "Payments",
  },
  {
    id: "discount-codes",
    question: "Can I offer discounts?",
    answer:
      "Yes, you can create discount codes with either percentage-based or fixed-amount discounts for your services.",
    category: "Payments",
  },

  // Earnings & Payouts
  {
    id: "track-earnings",
    question: "How do I track my earnings?",
    answer:
      "The Earnings tab shows your total earnings, pending payouts, and completed payouts. Each entry includes the service type, consultee name, amount, platform fee, and your net earning. You can filter by date range and service type.",
    category: "Earnings & Payouts",
  },
  {
    id: "when-paid",
    question: "When do I get paid?",
    answer:
      "Payouts become available after a hold period that varies by service type: 24 hours for consultations and classes, 48 hours for webinars, and 7 days for subscriptions. Once available, payouts are processed to your connected payment account. The minimum payout amount is ₹500.",
    category: "Earnings & Payouts",
  },
  {
    id: "earning-statuses",
    question: "What does each earning status mean?",
    answer:
      "Earnings go through several statuses: 'On Hold' means the hold period has not yet passed, 'Available' means the earning is ready for payout, 'Paid' means the payout has been processed, and 'Refunded' means the payment was reversed due to a cancellation.",
    category: "Earnings & Payouts",
  },
  {
    id: "payout-not-showing",
    question: "Why is my payout not showing?",
    answer:
      "Payouts require a minimum balance of ₹500. If your available balance is below this threshold, the payout will not appear. Also ensure the hold period for your earnings has passed — consultations and classes have a 24-hour hold, webinars 48 hours, and subscriptions 7 days.",
    category: "Earnings & Payouts",
  },

  // Referrals
  {
    id: "referral-program",
    question: "How does the referral program work?",
    answer:
      "You have a unique referral code and link visible in the Referrals tab. When someone signs up using your referral link and completes a qualifying action, both you and the referred user earn credits that can be applied toward future purchases.",
    category: "Referrals",
  },
  {
    id: "referral-qualified",
    question: "What does 'Qualified' mean for a referral?",
    answer:
      "A referral becomes 'Qualified' once the referred user completes the required qualifying action (e.g., making their first purchase). Until then, the referral shows as 'Pending'. Only qualified referrals earn credits.",
    category: "Referrals",
  },
  {
    id: "referral-credits",
    question: "How do referral credits work?",
    answer:
      "Referral credits are added to your account when a referral qualifies. You can apply credits at checkout to reduce the amount you pay. Credits are tracked per-payment and can be partially used. If a payment is refunded, the credits used for that payment are restored.",
    category: "Referrals",
  },
  {
    id: "share-referral-link",
    question: "How do I share my referral link?",
    answer:
      "Go to the Referrals tab to find your unique referral code and shareable link. You can copy the link directly or share it via social media. The tab also shows your referral statistics including total referrals, qualified referrals, and credits earned.",
    category: "Referrals",
  },

  // Recordings
  {
    id: "access-recordings",
    question: "How do I access my recordings?",
    answer:
      "Go to the Recordings tab to see all your recorded sessions. Each recording shows the session title, date, duration, and a link to watch or download. Recordings are organized by date and can be filtered by service type.",
    category: "Recordings",
  },
  {
    id: "sync-from-stream",
    question: "What is 'Sync from Stream'?",
    answer:
      "The 'Sync from Stream' button fetches recordings from your streaming provider (e.g., the built-in streaming solution) and links them to the corresponding session. Use this if a recording does not appear automatically after a session ends.",
    category: "Recordings",
  },
  {
    id: "recording-session-types",
    question: "Which session types support recordings?",
    answer:
      "Recordings are available for webinars and classes conducted through the built-in streaming platform. One-on-one consultations conducted via external platforms (Zoom, Google Meet, etc.) are not automatically recorded through Familiarise.",
    category: "Recordings",
  },

  // Documents
  {
    id: "document-review",
    question: "How does document review work?",
    answer:
      "Consultees can submit documents for your review. These appear in the Documents tab. You can view the submitted document, add your feedback or response document, and update the review status. Each document entry shows the consultee, submission date, and current status.",
    category: "Documents",
  },
  {
    id: "document-statuses",
    question: "What are the document statuses?",
    answer:
      "Documents go through several statuses: 'Submitted' means the consultee has uploaded a document for review, 'In Review' means you have started reviewing it, and 'Completed' means you have finished and provided your feedback or response.",
    category: "Documents",
  },
  {
    id: "upload-response-documents",
    question: "Can I upload response documents?",
    answer:
      "Yes, you can upload response documents as part of your review. This is useful for providing annotated versions, written feedback, or supplementary materials. The consultee will be notified when your response is available.",
    category: "Documents",
  },

  // Collaborations
  {
    id: "how-collaborations-work",
    question: "How do collaborations work?",
    answer:
      "Collaborations let you partner with other consultants to co-deliver services. You can invite collaborators to a service, assign roles, and split revenue. Collaboration requests appear in the Collaborations tab where you can accept or decline invitations.",
    category: "Collaborations",
  },
  {
    id: "collaboration-roles",
    question: "What collaboration roles are available?",
    answer:
      "Collaborators can have different roles such as co-host, guest speaker, or assistant. The service owner assigns roles when creating the collaboration. Each role determines the collaborator's permissions and visibility during the session.",
    category: "Collaborations",
  },
  {
    id: "collaboration-revenue",
    question: "How is revenue shared in collaborations?",
    answer:
      "Revenue sharing is configured when setting up the collaboration. The service owner specifies the percentage split for each collaborator. After the platform fee is deducted, the net revenue is distributed according to the agreed split.",
    category: "Collaborations",
  },

  // Trials
  {
    id: "how-trials-work",
    question: "How do trials work?",
    answer:
      "You can offer trial sessions to let potential consultees experience your services before committing. You set the trial price on each subscription plan — we recommend charging at least ₹100–₹200, since paid trials get far fewer no-shows — though you can still make a trial free. Consultees request a trial from your profile, and you can approve or decline the request from the Home tab or the relevant service section.",
    category: "Trials",
  },
  {
    id: "manage-trial-requests",
    question: "How do I manage trial requests?",
    answer:
      "Trial requests appear alongside your regular appointment requests. You can approve or decline them based on your availability. Approved trials are scheduled like regular sessions.",
    category: "Trials",
  },
  {
    id: "after-trial-completed",
    question: "What happens after a trial is completed?",
    answer:
      "After a trial session, the consultee can choose to book a full subscription with you. Trial sessions help build trust and showcase your expertise, often leading to long-term client relationships.",
    category: "Trials",
  },
];

// Helper function to get FAQs by category
export function getFAQsByCategory(category: string): FAQ[] {
  return faqs.filter((faq) => faq.category === category);
}

// Helper function to search FAQs
export function searchFAQs(query: string): FAQ[] {
  const lowercaseQuery = query.toLowerCase();
  return faqs.filter(
    (faq) =>
      faq.question.toLowerCase().includes(lowercaseQuery) ||
      faq.answer.toLowerCase().includes(lowercaseQuery),
  );
}
