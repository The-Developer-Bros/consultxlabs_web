import type { Metadata } from "next";

import EnterprisePageLayout from "../_components/EnterprisePageLayout";
import {
  EnterpriseAlternatingRows,
  EnterpriseFaqs,
  EnterpriseHowItWorks,
} from "../_components/EnterpriseSections";

export const metadata: Metadata = {
  title: "Corporate Mentorship Programs | Familiarise Enterprise",
  description:
    "Sponsored credit-pool mentorship so your staff book 1:1 sessions with Familiarise experts while the organisation controls the budget.",
};

const FAQS = [
  {
    question: "What is a credit-pool program?",
    answer:
      "Your organisation funds a shared pool of credits (or rupee budget) for a cycle. Assigned learners draw from that pool when they book — you control top-ups, assignments, and overage behaviour.",
  },
  {
    question: "Can people choose their own mentors?",
    answer:
      "Yes. That is the point of the open marketplace pitch: staff pick experts that match their role and goals. Programs can optionally restrict bookings to an allowlisted panel.",
  },
  {
    question: "How is this different from team training?",
    answer:
      "Corporate mentorship is pay-as-you-go against a pool. Team training is licensed seats with equal access for a cohort. Many organisations start with mentorship credits when demand is uneven across teams.",
  },
];

export default function CorporateMentorshipPage() {
  return (
    <EnterprisePageLayout
      hero={{
        eyebrow: "Enterprise · Corporate mentorship",
        brandLine: "Familiarise Enterprise",
        titleLead: "Structured mentorship your",
        titleAccent: "organisation funds.",
        subtitle:
          "A credit pool for 1:1 expert sessions — your people choose who to learn from, and finance keeps a single budget instead of a trail of personal expenses.",
        primaryCta: { label: "Talk to sales", href: "/contactus" },
        secondaryCta: {
          label: "All enterprise options",
          href: "/enterprise",
        },
        assurances: [
          "Shared credit or wallet budget",
          "Staff choose their experts",
          "Organisation pays at booking",
        ],
        card: {
          title: "A typical mentorship program",
          items: [
            "Fund a credit pool or wallet balance for the cycle.",
            "Assign eligible learners (and optionally managers who oversee utilisation).",
            "People book 1:1 consultations or subscriptions against the pool.",
            "Low-balance alerts and overage rules keep spend inside the plan you agreed.",
          ],
          footnote:
            "Credit sizing and renewal are set on the program contract during onboarding.",
        },
      }}
      faqsJsonLd={FAQS}
      closing={{
        title: "Ready for organisation-funded mentorship?",
        description:
          "Tell us team size, monthly session volume, and domains. We will size a credit pool that matches how your people actually book.",
        primaryCta: { label: "Talk to sales", href: "/contactus" },
        secondaryCta: {
          label: "See team training",
          href: "/enterprise/team-training",
        },
        reassurance: "Sales-assisted setup for Indian organisations on INR.",
      }}
    >
      <EnterpriseAlternatingRows
        eyebrow="Why credits"
        title="When a shared budget beats equal seats"
        intro="Fund demand, not empty seats — laid out as a narrative, not another feature grid."
        rows={[
          {
            icon: "wallet",
            title: "Budget you can see",
            description:
              "Top up a wallet or invoice against the program; learners draw down as they book, with alerts before the pool runs dry.",
          },
          {
            icon: "briefcase",
            title: "Choice without chaos",
            description:
              "Staff pick experts for their role — career, technical depth, leadership — under one organisational sponsor.",
          },
          {
            icon: "users",
            title: "Assignment control",
            description:
              "Managers decide who is eligible. Unassigned staff stay on personal bookings; assigned staff use the org program.",
          },
          {
            icon: "fileCheck",
            title: "Procurement path",
            description:
              "Invoice funding and PO matching for teams that cannot put learning on a personal card.",
          },
        ]}
      />

      <EnterpriseHowItWorks
        eyebrow="Rollout"
        title="From budget to first mentorship session"
        intro="Three steps from the sales conversation to a sponsored 1:1 on the calendar."
        steps={[
          {
            title: "Size the pool",
            description:
              "Expected sessions per month, domains, and whether funding is prepaid wallet or invoice.",
          },
          {
            title: "Assign learners",
            description:
              "Invite members and attach them to the credit-pool program in the organisation workspace.",
          },
          {
            title: "Book and draw down",
            description:
              "Learners book experts; the organisation funds the session and utilisation updates on the program.",
          },
        ]}
      />

      <EnterpriseFaqs
        eyebrow="Questions"
        title="Corporate mentorship FAQs"
        intro="Grounded in the credit-pool program model Familiarise runs for sponsor organisations."
        items={FAQS}
      />
    </EnterprisePageLayout>
  );
}
