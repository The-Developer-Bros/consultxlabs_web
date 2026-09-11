import type { Metadata } from "next";

import EnterprisePageLayout from "./_components/EnterprisePageLayout";
import {
  EnterpriseCapabilities,
  EnterpriseFaqs,
  EnterpriseHowItWorks,
  EnterprisePaths,
} from "./_components/EnterpriseSections";

export const metadata: Metadata = {
  title: "Familiarise for Enterprise | Team training & sponsored mentorship",
  description:
    "Sponsor expert sessions for your people, run licensed-seat training or credit-pool mentorship, and bill through wallet or invoice — built for Indian organisations on Familiarise.",
};

const FAQS = [
  {
    question: "Who is Familiarise Enterprise for?",
    answer:
      "Indian organisations that want to sponsor learning for their own staff — startups, mid-sized companies, and training firms. You fund seats or credits; your people book vetted experts on the same marketplace individuals already use.",
  },
  {
    question: "How does billing work?",
    answer:
      "Organisations can fund programs with a prepaid wallet, invoice terms with purchase orders, or licensed seats under a contract. Pricing and commercial terms are set with our team for your cohort size — there is no self-serve enterprise checkout on this page.",
  },
  {
    question: "Can we use the whole marketplace or only our own experts?",
    answer:
      "Sponsor programs can fund bookings across the open Familiarise marketplace by default. If you need a curated panel, that can be configured per program. Public organisations that host their own experts are listed separately in the organisations directory.",
  },
  {
    question: "Is GST invoicing supported?",
    answer:
      "Yes for design-partner customers on domestic INR contracts. We issue GST-compliant organisation invoices; e-invoice (IRN) requirements for larger turnovers are handled case by case during onboarding.",
  },
];

export default function EnterpriseLandingPage() {
  return (
    <EnterprisePageLayout
      hero={{
        eyebrow: "For teams & organisations",
        brandLine: "Familiarise Enterprise",
        titleLead: "Expert access for your",
        titleAccent: "whole organisation.",
        subtitle:
          "Sponsor sessions, run structured training or mentorship programs, and settle with wallet or invoice — without asking every employee to expense a personal booking.",
        primaryCta: { label: "Talk to sales", href: "/contactus" },
        secondaryCta: {
          label: "Browse organisations",
          href: "/explore/enterprise/organisations",
        },
        assurances: [
          "Organisation pays — your people book",
          "Licensed seats or credit pools",
          "Wallet and invoice funding",
        ],
        card: {
          title: "What an enterprise engagement usually covers",
          items: [
            "A program with seats or credits assigned to your learners.",
            "Bookings against the Familiarise expert marketplace (or a curated allowlist).",
            "One commercial relationship for finance — wallet top-ups or invoices with PO matching.",
            "Roles for owners, managers, and learners so ops stay inside your organisation.",
          ],
          footnote:
            "Host networks that sell their own experts on Familiarise are a separate path — start from the public organisations directory or talk to sales.",
        },
      }}
      faqsJsonLd={FAQS}
      closing={{
        title: "Ready to bring Familiarise to your team?",
        description:
          "Tell us about your organisation, headcount, and whether you need seats, credits, or both. We will map the right program shape.",
        primaryCta: { label: "Talk to sales", href: "/contactus" },
        secondaryCta: {
          label: "Explore Familiarise",
          href: "/explore/experts",
        },
        reassurance:
          "Design-partner onboarding for Indian organisations on INR contracts.",
      }}
    >
      {/* Paths first — the landing's job is to fork the two sponsor products. */}
      <EnterprisePaths
        eyebrow="Choose a path"
        title="Two sponsor programs that match how teams learn"
        intro="Pick the shape that fits your L&D motion. Both sit on Familiarise organisations, memberships, and funding sources."
        paths={[
          {
            eyebrow: "Licensed seats",
            title: "Team training",
            description:
              "Flat-fee seats for a defined cohort — ideal when a whole team needs structured access for a cycle.",
            href: "/enterprise/team-training",
            ctaLabel: "See team training",
            icon: "graduation",
          },
          {
            eyebrow: "Credit pool",
            title: "Corporate mentorship",
            description:
              "A shared budget your people draw down as they book 1:1 mentorship — ideal when demand is uneven across roles.",
            href: "/enterprise/corporate-mentorship",
            ctaLabel: "See corporate mentorship",
            icon: "wallet",
          },
        ]}
      />

      <EnterpriseHowItWorks
        eyebrow="How it works"
        title="From conversation to first sponsored booking"
        intro="Enterprise is sales-assisted today so commercial terms, seat counts, and funding match your finance process."
        steps={[
          {
            title: "Tell us the shape",
            description:
              "Headcount, domains, seat vs credit preference, and whether you need wallet prepaid or invoice terms.",
          },
          {
            title: "We stand up your organisation",
            description:
              "Owners and managers get an org workspace; learners receive assignments under the program you chose.",
          },
          {
            title: "Your people book",
            description:
              "Staff book experts as usual — the organisation funds the session through the program, not their personal card.",
          },
        ]}
      />

      <EnterpriseCapabilities
        eyebrow="Also included"
        title="Procurement and discovery rails"
        intro="Beyond the two program shapes — billing and marketplace discovery your ops team will ask about."
        features={[
          {
            icon: "fileCheck",
            title: "Invoicing for procurement",
            description:
              "Purchase orders, GST-compliant organisation invoices, and Net terms — not a corporate card and a pile of receipts.",
          },
          {
            icon: "shield",
            title: "Host expert networks",
            description:
              "Agencies and institutions that already run experts appear in the public directory when they opt in.",
            href: "/explore/enterprise/organisations?type=EXPERT_NETWORK",
          },
          {
            icon: "users",
            title: "Team training",
            description:
              "Licensed seats so every assigned learner can book without individual expensing.",
            href: "/enterprise/team-training",
          },
          {
            icon: "briefcase",
            title: "Corporate mentorship",
            description:
              "Credit pools so staff choose 1:1 experts while you control the budget.",
            href: "/enterprise/corporate-mentorship",
          },
        ]}
      />

      <EnterpriseFaqs
        eyebrow="Questions"
        title="Before you talk to sales"
        intro="Straight answers grounded in what ships for design-partner customers today."
        items={FAQS}
      />
    </EnterprisePageLayout>
  );
}
