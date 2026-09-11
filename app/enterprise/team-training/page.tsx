import type { Metadata } from "next";

import EnterprisePageLayout from "../_components/EnterprisePageLayout";
import {
  EnterpriseComparison,
  EnterpriseFaqs,
  EnterpriseVerticalTimeline,
} from "../_components/EnterpriseSections";

export const metadata: Metadata = {
  title: "Team Training for Organisations | Familiarise Enterprise",
  description:
    "Licensed-seat programs so your whole team can book vetted Familiarise experts under one organisational plan — without individual expensing.",
};

const FAQS = [
  {
    question: "What is a licensed-seat program?",
    answer:
      "Your organisation buys a defined number of seats for a billing cycle. Assigned learners can book covered sessions without paying personally — utilisation and overage rules are set on the program contract.",
  },
  {
    question: "Who chooses the experts?",
    answer:
      "By default, learners can book across the Familiarise marketplace. If you need a shortlist, we can configure a consultant allowlist on the program.",
  },
  {
    question: "How is this different from corporate mentorship?",
    answer:
      "Team training is seat-based (everyone assigned has access for the cycle). Corporate mentorship uses a shared credit pool that staff draw down as they book — better when usage varies widely by role.",
  },
];

export default function TeamTrainingPage() {
  return (
    <EnterprisePageLayout
      hero={{
        eyebrow: "Enterprise · Team training",
        brandLine: "Familiarise Enterprise",
        titleLead: "Upskill a whole team with",
        titleAccent: "one seat plan.",
        subtitle:
          "Licensed seats cover your cohort so managers stop chasing receipts and learners book vetted experts under your organisation.",
        primaryCta: { label: "Talk to sales", href: "/contactus" },
        secondaryCta: {
          label: "All enterprise options",
          href: "/enterprise",
        },
        assurances: [
          "Licensed seats per cycle",
          "Organisation-funded bookings",
          "Managers assign who is covered",
        ],
        card: {
          title: "A typical team-training rollout",
          items: [
            "Define the cohort size and domains (engineering, product, leadership).",
            "Assign seats to learners in your organisation workspace.",
            "People book sessions; the program — not their wallet — pays.",
            "Finance settles via wallet top-up or invoice against the contract.",
          ],
          footnote:
            "Seat counts, covered session types, and overage behaviour are agreed during onboarding.",
        },
      }}
      faqsJsonLd={FAQS}
      closing={{
        title: "Want licensed seats for your team?",
        description:
          "Share headcount, domains, and cycle length. We will propose a seat program that fits how your L&D team actually runs.",
        primaryCta: { label: "Talk to sales", href: "/contactus" },
        secondaryCta: {
          label: "See corporate mentorship",
          href: "/enterprise/corporate-mentorship",
        },
        reassurance: "Sales-assisted setup for Indian organisations on INR.",
      }}
    >
      <EnterpriseComparison
        eyebrow="Seats vs credits"
        title="When licensed seats are the right call"
        intro="Equal access for a defined cohort — not a shared pool a few power users can drain."
        left={{
          label: "This page",
          title: "Team training",
          points: [
            "Predictable seat count for finance",
            "Every assigned learner has the same access",
            "Ideal for graduate batches and new-manager ramps",
            "Overage rules lock with the contract",
          ],
          href: "/contactus",
          ctaLabel: "Talk to sales",
        }}
        right={{
          label: "Alternative",
          title: "Corporate mentorship",
          points: [
            "Shared credit or wallet budget",
            "Usage can vary widely by role",
            "Staff choose experts as demand appears",
            "Better when only some people book heavily",
          ],
          href: "/enterprise/corporate-mentorship",
          ctaLabel: "Compare mentorship",
        }}
      />

      <EnterpriseVerticalTimeline
        eyebrow="Rollout"
        title="From seat count to first booking"
        intro="A single vertical path — not another three-up card row."
        steps={[
          {
            label: "Step 1",
            title: "Scope the cohort",
            description:
              "Seats, domains, and which session types the license covers for the cycle.",
          },
          {
            label: "Step 2",
            title: "Assign learners",
            description:
              "Owners and managers invite members and attach them to the licensed-seat program.",
          },
          {
            label: "Step 3",
            title: "Book under the org",
            description:
              "Assigned learners book as usual; funding resolves through the organisation program.",
          },
        ]}
      />

      <EnterpriseFaqs
        eyebrow="Questions"
        title="Team training FAQs"
        intro="Grounded in the licensed-seat program model Familiarise runs for sponsor organisations."
        items={FAQS}
      />
    </EnterprisePageLayout>
  );
}
