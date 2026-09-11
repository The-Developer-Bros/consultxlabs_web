import type { Metadata } from "next";

import UseCasePageLayout from "../UseCasePageLayout";
import type { UseCasePageData } from "../UseCasePageLayout";

export const metadata: Metadata = {
  title: "Career Guidance for Early-Career Professionals in India | Familiarise",
  description:
    "CTC versus in-hand, variable pay, clawbacks, notice periods and whether your role is actually compounding. Book an hour with someone five years ahead of you. Rupee pricing, full refund 24 hours ahead.",
};

/**
 * Segment thesis: this reader is not short of advice, they are short of
 * *information asymmetry relief* — chiefly about what an Indian offer actually
 * contains. So the spine is a decoder, and it runs before the pain section:
 * the page opens by being useful, which is the opposite of the category's
 * aspirational-imperative register ("Supercharge", "10X your career").
 *
 * Framing sources (no figures appear in the copy — the numbers that circulate
 * hardest here, "in-hand is 30% below CTC" and "switch hikes are 30–40%", have
 * no traceable primary source and are deliberately absent):
 * - Absence of a growth path, not pay alone, is a leading stated reason Indian
 *   professionals switch — https://www.businesstoday.in/jobs/story/almost-everyone-is-looking-to-switch-jobs-but-only-if-employers-meet-this-pay-demand-544684-2026-07-23
 * - Internal increments by sector, Aon's 32nd survey of 1,400+ organisations —
 *   https://www.aon.com/apac/in-the-press/asia-newsroom/2026/aon-survey-projects-slight-uptick-in-salaries-in-india-2026
 * - Deferred appraisal cycles in Indian IT —
 *   https://www.peoplematters.in/news/compensation-benefits/tcs-resumes-april-salary-hikes-after-delay-with-double-digit-raises-for-top-performers-49180
 * - Above-the-fold attention concentration, which is why the hero carries a
 *   content card rather than another screenful —
 *   https://www.nngroup.com/articles/scrolling-and-attention/
 */
const data: UseCasePageData = {
  hero: {
    eyebrow: "For 0–5 years of experience",
    titleLead: "The first five years compound.",
    titleAccent: "So do the mistakes.",
    subtitle:
      "Nobody at work is paid to tell you what your offer really contains, whether your role is going anywhere, or what you are worth on the open market. Book an hour with someone who will.",
    primaryCta: { label: "Find an expert", href: "/explore/experts" },
    secondaryCta: {
      label: "See top-rated experts",
      href: "/explore/experts?sort=rating",
    },
    assurances: [
      "The expert's price is on their profile, in ₹",
      "Cancel 24 hours ahead for a full refund",
      "No callback, no counsellor, no brochure",
    ],
    card: {
      title: "What people actually bring to a first session",
      items: [
        "Is this offer really better than my current one, once variable pay and the joining-bonus clawback come out of it?",
        "My title has not moved in two years. Is that the team, the company, or me?",
        "What has to be on my CV in the next six months for the companies I want to take my call?",
        "How do I ask for a raise here without it becoming the reason I get managed out?",
      ],
      footnote:
        "Consultations start at 30 minutes. If one call turns into an ongoing arrangement, some experts also run monthly subscription plans — reachable from the same profile.",
    },
  },

  spine: {
    variant: "decoder",
    eyebrow: "Start with something useful",
    title: "Read your offer letter the way the person who wrote it does",
    intro:
      "An Indian offer is quoted as one large number you will never see in your bank account. Here is what that number is made of, and which parts of it are promises rather than pay.",
    items: [
      {
        label: "CTC",
        title: "Cost to company, not cost to you",
        description:
          "Everything your employer budgets for you, including their own provident-fund contribution and the gratuity they set aside. It is an accounting figure on their side. Your in-hand pay is what survives after those line items, your own PF share and income tax.",
      },
      {
        label: "Variable pay",
        title: "The conditional part, quoted as if it were certain",
        description:
          "Counted at 100% in the CTC and paid at whatever the company's performance and your rating decide. The question worth asking is what it actually paid out last cycle across the whole team, not what it is capable of paying out.",
      },
      {
        label: "Joining bonus",
        title: "A loan with a clawback clause attached",
        description:
          "Typically repayable in full if you leave within a stated period. It inflates your first-year CTC and quietly raises the cost of your next move. Read the recovery clause before you read the headline number.",
      },
      {
        label: "Retention bonus",
        title: "Priced to get you past your restless year",
        description:
          "Paid on a date rather than on performance. It is worth counting only to the extent that you intend to still be sitting there when that date arrives.",
      },
      {
        label: "ESOPs and RSUs",
        title: "Worth nothing until three separate things are true",
        description:
          "There has to be a vesting date you actually reach, a liquidity event or buyback that lets you sell, and a strike price that makes exercising worthwhile. In an unlisted company, ask about all three before you value them at the number on the sheet.",
      },
      {
        label: "Notice period",
        title: "The clause that decides what your next job can be",
        description:
          "A long notice period narrows the set of employers willing to wait for you. Whether a buyout is permitted, and who pays for it, is negotiable when you join and almost never negotiable afterwards.",
      },
      {
        label: "Hike percentage",
        title: "A ratio, not an outcome",
        description:
          "It is measured against your current CTC, so the identical rupee offer is a brilliant hike or an insulting one purely depending on where you started. Compare offers in absolute in-hand terms and real ownership, never in percentages.",
      },
    ],
    footnote:
      "General mechanics, not tax or legal advice. The specifics of your own offer are exactly what a session is for.",
  },

  pains: {
    eyebrow: "Why this keeps happening",
    title: "The structural reasons nobody tells you any of this",
    intro:
      "None of these are personal failings. They are what happens when the people best placed to advise you are the people with the least incentive to.",
    items: [
      {
        title: "Nobody at work is measured on your trajectory",
        description:
          "Your manager is assessed on delivery. Senior engineers are assessed on their own scope. Where a formal mentorship programme exists at all, it tends to pair you with whoever had spare capacity that quarter. The most consequential decisions of your twenties end up being made with no counsel at all.",
      },
      {
        title: "Three years of experience, or one year lived three times",
        description:
          "Maintenance work, a ticket queue and a stack that has not moved since you joined. It reads as three years on a CV and interviews like one — and the gap only becomes visible at the exact moment it is most expensive, in a room full of strangers.",
      },
      {
        title: "You are negotiating without a second data point",
        description:
          "What people are paid reaches you as rumour, and in any appraisal conversation the other side knows the market better than you do. With no independent reference point, you end up negotiating against yourself and calling it realism.",
      },
      {
        title: "Everyone else appears to know exactly what they are doing",
        description:
          "They do not, but that is unverifiable from inside your own head. The thing that actually resolves it is one candid conversation with somebody senior enough to describe how uncertain they were at your level, and specific enough to be believed.",
      },
    ],
  },

  sessions: {
    eyebrow: "What you book",
    title: "One person, one hour, one decision",
    intro:
      "These are the sessions this segment books most, and each one is a defined block of time with a named outcome rather than an open-ended chat.",
    items: [
      {
        icon: "wallet",
        title: "Offer and counter-offer review",
        description:
          "Bring both offers, or the one you are still negotiating. Work through variable pay, clawbacks, equity and notice terms with someone who has sat on the hiring side of those conversations.",
      },
      {
        icon: "chart",
        title: "An honest read on whether your role is compounding",
        description:
          "Whether the work you are doing is building a career or maintaining one, and what specifically would have to change over the next two quarters for the answer to differ.",
      },
      {
        icon: "target",
        title: "Skill-gap session against a named target role",
        description:
          "Not a generic roadmap. Name the role and the kind of company, then work backwards to what is missing from your profile today and in what order to fix it.",
      },
      {
        icon: "message",
        title: "The conversation you have been avoiding",
        description:
          "The raise ask, the team-change ask, the pushback on scope. Rehearse it with someone who has been on the receiving end of that conversation many times and can tell you how it lands.",
      },
    ],
  },

  comparison: {
    eyebrow: "The honest comparison",
    title: "Free forums, a monthly retainer, or an hour with one person",
    intro:
      "All three are legitimate. They differ in who carries the risk and how much you have to commit before you find out whether it works.",
    alternatives: [
      "Anonymous salary forums and cold LinkedIn messages",
      "A monthly mentorship retainer",
    ],
    ourLabel: "Familiarise",
    rows: [
      {
        criterion: "What you get",
        alternatives: [
          "Anecdotes from strangers with no context on your situation.",
          "A recurring relationship, billed whether or not this month needed one.",
        ],
        ours: "One expert, for a defined session, on the specific decision in front of you.",
      },
      {
        criterion: "What you commit to",
        alternatives: [
          "Nothing, other than the time.",
          "A monthly fee, usually with a multi-month minimum.",
        ],
        ours: "A single booking. Move to a monthly plan later only if you decide you want one.",
      },
      {
        criterion: "Who it comes from",
        alternatives: [
          "Unverified, unattributable, and impossible to follow up with.",
          "Whoever the platform matches or assigns you.",
        ],
        ours: "Someone you chose, whose identity and credential documents our staff reviewed.",
      },
      {
        criterion: "Backing out",
        alternatives: [
          "Not applicable.",
          "Notice periods, part-months and partial refunds.",
        ],
        ours: "Full refund up to 24 hours before the session, on terms fixed at checkout.",
      },
      {
        criterion: "Paperwork",
        alternatives: [
          "None, and nothing you can put through expenses.",
          "Varies by provider.",
        ],
        ours: "A tax invoice, paid in ₹ by UPI, card, net banking or wallet.",
      },
    ],
    footnote:
      "If ongoing mentorship is genuinely what you want, it exists here too — as a subscription with an agreed number of calls, on the same expert's profile. It simply is not the only way in.",
  },

  categories: {
    eyebrow: "Where to start",
    title: "Find someone who has already done the next bit",
    intro:
      "Every listing shows price, session length and reviews from people who actually completed a session.",
    links: [
      { label: "System design", href: "/explore/experts?search=System+Design" },
      { label: "Interview prep", href: "/explore/experts?search=Interview+Prep" },
      { label: "Machine learning", href: "/explore/experts?search=Machine+Learning" },
      { label: "Cloud", href: "/explore/experts?search=Cloud" },
      { label: "DevOps", href: "/explore/experts?search=DevOps" },
      { label: "Technology", href: "/explore/experts?search=Technology" },
      { label: "Business", href: "/explore/experts?search=Business" },
      {
        label: "Personal development",
        href: "/explore/experts?search=Personal+Development",
      },
    ],
  },

  faqs: {
    eyebrow: "Before you book",
    title: "Fair questions",
    intro: "None of these require you to speak to a salesperson first.",
    items: [
      {
        question: "I have exactly one question. Is a whole session overkill?",
        answer:
          "No, and it is the most common reason people book. Consultations start at 30 minutes, and both the price and the length are on the expert's profile before you commit to anything.",
      },
      {
        question: "Will my employer find out?",
        answer:
          "There is nothing for them to find out. You book as an individual and we never contact an employer about a booking.",
      },
      {
        question: "How is this different from a monthly mentorship plan?",
        answer:
          "A consultation is a single booking at a fixed price. A subscription is a monthly plan with an agreed number of calls, which some experts offer alongside their one-off sessions. Start with the one-off, and move to a plan only once it has earned its keep.",
      },
      {
        question: "Can I expense it?",
        answer:
          "You receive a tax invoice for the booking, with GST charged as Indian law requires for buyers in India. Whether your employer reimburses it is between you and them — but the paperwork will not be the reason they say no.",
      },
      {
        question: "How do I know the price is fair?",
        answer:
          "You do not have to take our word for it. Experts set their own prices and you can see them side by side before booking. Our commission is already inside the listed price, so nothing is added at checkout beyond statutory GST.",
      },
      {
        question: "What if I pick the wrong person?",
        answer:
          "Cancel at least 24 hours before the start time, get a full refund, and book someone else. If the expert cancels on you, you are refunded in full no matter when it happens.",
      },
    ],
  },

  closing: {
    title: "Compounding starts with one honest conversation",
    description:
      "An hour with someone a few years ahead of you, about the decision actually in front of you. Priced in rupees, on their profile, before you book anything.",
    primaryCta: { label: "Find an expert", href: "/explore/experts" },
    secondaryCta: {
      label: "See top-rated experts",
      href: "/explore/experts?sort=rating",
    },
    reassurance:
      "No callback. No brochure. Cancel 24 hours ahead for a full refund.",
  },

  order: ["spine", "pains", "sessions", "comparison", "categories", "faqs"],
};

export default function EarlyCareerPage() {
  return <UseCasePageLayout data={data} />;
}
