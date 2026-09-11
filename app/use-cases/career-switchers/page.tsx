import type { Metadata } from "next";

import UseCasePageLayout from "../UseCasePageLayout";
import type { UseCasePageData } from "../UseCasePageLayout";

export const metadata: Metadata = {
  title: "Career Switch Guidance for Indian Professionals | Familiarise",
  description:
    "Service to product, QA to SDET, engineering to PM, abroad or a GCC at home. Talk to someone who already made the switch you are considering. No cohort fee, no income-share agreement.",
};

/**
 * Segment thesis: a switch is not one decision, it is a choice among a small
 * number of well-worn routes — so the spine is a matrix, and the page carries a
 * pre-resignation checklist no other page has. The paperwork section exists
 * because notice periods, bonus clawbacks and background verification are where
 * Indian switches actually fail, well after the interviews are won.
 *
 * Framing sources (no figures used in copy, so nothing here needs to age well):
 * the abroad-versus-GCC shift is grounded in the 2025 collapse in F-1 issuance
 * to Indian students (https://www.forbes.com/sites/stuartanderson/2025/10/01/immigration-data-indicate-indian-student-enrollment-may-plummet/,
 * https://www.business-standard.com/immigration/us-visa-curbs-fallout-indian-students-in-us-drop-6-9-to-352-644-in-2026-126040300236_1.html)
 * set against continued Global Capability Centre expansion in India
 * (https://nasscom.in/knowledge-center/publications/india-gcc-landscape-report-5-year-journey,
 * https://www.businesstoday.in/jobs/story/at-5-1-lakh-jobs-indias-global-capability-centre-hiring-boom-scales-new-peak-540328-2026-07-01).
 */
const data: UseCasePageData = {
  hero: {
    eyebrow: "For switchers with 3–10 years",
    titleLead: "Three years of experience,",
    titleAccent: "or one year lived three times.",
    subtitle:
      "Service to product, QA to development, engineer to PM, abroad or a global centre at home. Each of those is a known route with known costs. Talk to somebody who has already walked the one you are considering.",
    primaryCta: { label: "Find an expert", href: "/explore/experts" },
    secondaryCta: {
      label: "See career-switch experts",
      href: "/explore/experts?search=Career+Switching",
    },
    assurances: [
      "No cohort, no income-share agreement",
      "Cancel 24 hours ahead for a full refund",
      "Pay in ₹ by UPI, card or net banking",
    ],
    card: {
      title: "What the first call should settle",
      items: [
        "Whether the route you have picked is genuinely the shortest one from where you are standing.",
        "Which parts of your CV a screener will quietly discount, and what can be done about them.",
        "What the target interview loop actually tests — algorithms, low-level design, system design, or none of those.",
        "What the move really costs you: notice period, a possible title reset, and how long it takes in practice.",
      ],
      footnote:
        "Experts set their own price and session length, and both are on the profile. Nothing here asks you to join a cohort or sign an agreement.",
    },
  },

  pains: {
    eyebrow: "Why switches stall",
    title: "The switch rarely fails on ability",
    intro:
      "People who cannot make the jump are usually not the people who prepared least. They are the people who prepared for the wrong obstacle.",
    items: [
      {
        title: "Your CV is read as your employer, not as your work",
        description:
          "Screeners use the current company as a shortcut, and client confidentiality often stops you describing what you genuinely built. Years of real delivery compress into a line that looks identical to everyone else's line.",
      },
      {
        title: "The target loop tests things your job never asked of you",
        description:
          "Product interviews run algorithms, low-level design and system design, and hand out very little credit for tenure. You end up measured against a fresher on data structures and against a senior on architecture, in the same week.",
      },
      {
        title: "A long notice period makes you the inconvenient candidate",
        description:
          "A team that can hire somebody in thirty days frequently will. Whether a buyout is even permitted, and who pays for it, was settled in a contract you signed years ago and probably have not reread since.",
      },
      {
        title: "Nobody tells you what the switch actually costs",
        description:
          "Often a title reset, a flat or slightly lower first year, and six months of evenings. That can be an excellent trade — but it is one you should make with numbers in front of you rather than on optimism.",
      },
    ],
  },

  spine: {
    variant: "matrix",
    eyebrow: "Pick the road first",
    title: "Switches in India are not infinite. They are a handful of routes.",
    intro:
      "Each one has its own interview format, its own timeline and its own price. Choosing between them is an hour's conversation; preparing for the wrong one is six months.",
    items: [
      {
        icon: "branch",
        label: "Services → Product",
        title: "The most-attempted switch in Indian tech",
        description:
          "The blockers are remarkably consistent: rounds you have never practised, a CV that reads as maintenance, and a notice period that rules you out. All three are fixable, and the order you fix them in matters more than how hard you work at any one.",
      },
      {
        icon: "code",
        label: "Manual QA → SDET",
        title: "The pivot with the clearest ladder",
        description:
          "Automation, a real programming language and pipeline work convert an existing testing career rather than restarting it. The difficult part is convincing a screener the change has already happened — a portfolio problem well before it is a skills problem.",
      },
      {
        icon: "repeat",
        label: "Support / Ops → Development",
        title: "Closer than it feels from the inside",
        description:
          "You already understand the system's failure modes better than most of the people writing it. What is missing is shipped code with your name against it, and a story that frames the support years as domain depth rather than as time lost.",
      },
      {
        icon: "compass",
        label: "Engineering → Product",
        title: "A change of evidence, not just of title",
        description:
          "Lateral product roles are scarce, so most people move internally first and then move companies. Ask someone who did it what they actually showed to earn the change, because working closely with a product manager persuades nobody by itself.",
      },
      {
        icon: "chart",
        label: "Engineering → Data and ML",
        title: "Where the certificates stop working",
        description:
          "The market is saturated with courses and short of demonstrated work. Somebody who hires for these roles can tell you within an hour which projects on your CV count for something and which ones every other applicant also has.",
      },
      {
        icon: "globe",
        label: "Abroad, or a global centre at home",
        title: "The arithmetic has changed recently",
        description:
          "A master's abroad followed by a work visa is a longer and less certain path than it was a few years ago, while global companies keep expanding their own centres inside India. Both remain real options — they just deserve a conversation with somebody living the outcome rather than a forum thread.",
      },
    ],
    footnote:
      "If your route is not on this list, it still exists — these are simply the ones people ask about most.",
  },

  sessions: {
    eyebrow: "What you book",
    title: "Four sessions that do most of the work",
    intro:
      "Each of these is a single booking with a named person, at a price you can see before you commit.",
    items: [
      {
        icon: "route",
        title: "Route selection",
        description:
          "An hour spent deciding which switch you are actually making, before you spend half a year preparing for a different one. This is the cheapest session on the list and usually the highest-leverage.",
      },
      {
        icon: "file",
        title: "A CV rewrite aimed at one role",
        description:
          "Attach your CV to the booking and get it back marked up by somebody who screens for the role you want — not reworded by somebody who has never had to reject anyone.",
      },
      {
        icon: "video",
        title: "A real interview loop, not a friendly chat",
        description:
          "Algorithms, low-level design, system design or a product case, run by somebody who conducts those rounds and will tell you plainly at which point you would have been rejected.",
      },
      {
        icon: "wallet",
        title: "Offer, notice period and counter-offer strategy",
        description:
          "What to ask for, what to concede, and how to leave without damaging a reference you may well need again in five years.",
      },
    ],
  },

  checklist: {
    eyebrow: "The unglamorous part",
    title: "Run this before you resign",
    intro:
      "Switches fail on paperwork more often than on interviews, and paperwork failures happen after you have already won the offer.",
    items: [
      {
        title: "Read the notice-period clause itself, not your memory of it",
        description:
          "Confirm the length, whether a buyout is permitted, whether it is computed on basic or on gross, and whether your new employer will reimburse it. This single clause decides how many companies can realistically hire you.",
      },
      {
        title: "Check the clawback dates on every bonus you have accepted",
        description:
          "Joining and retention bonuses are typically repayable in gross if you leave inside the stated window, even though you were taxed on them. Resigning a few weeks early can be a remarkably expensive way to save a few weeks.",
      },
      {
        title: "Line up the documents your next background check will want",
        description:
          "Relieving letter, experience letter, recent payslips and Form 16. A clean exit is worth considerably more than a fast one, because a verification that comes back negative can withdraw an offer you have already accepted.",
      },
      {
        title: "Get it in writing before you resign anything",
        description:
          "A verbal confirmation and a completed background check are not the same thing as a signed letter with a joining date printed on it.",
      },
      {
        title: "Compare the offers on in-hand pay, not on the hike percentage",
        description:
          "A percentage flatters whichever number you happened to start from. Compare monthly take-home and real ownership, and treat variable pay as the conditional thing it is.",
      },
      {
        title: "Decide now what you will do if they counter-offer",
        description:
          "Decide it while it is still hypothetical. The moment it becomes real you will be flattered and under time pressure simultaneously, which is not a state anyone negotiates well in.",
      },
    ],
    footnote:
      "General practice, not legal advice. Your contract governs — and reading it alongside somebody who has negotiated a few is exactly what a session is for.",
  },

  comparison: {
    eyebrow: "The honest comparison",
    title: "Three ways to make a switch",
    intro:
      "All three have produced successful moves. They differ in how much you must commit before you discover whether yours is one of them.",
    alternatives: [
      "Doing it alone from forums and courses",
      "A cohort or pay-after-placement program",
    ],
    ourLabel: "Familiarise",
    rows: [
      {
        criterion: "What you pay",
        alternatives: [
          "Course fees, plus months spent preparing for the wrong route.",
          "A substantial fee, or a share of a salary you have not earned yet.",
        ],
        ours: "One expert's listed price, in rupees, visible before you book.",
      },
      {
        criterion: "What you sign",
        alternatives: [
          "Nothing.",
          "An agreement that attaches to your future income.",
        ],
        ours: "Nothing. No minimum term, no cohort, no agreement.",
      },
      {
        criterion: "Who guides you",
        alternatives: [
          "Strangers whose constraints have nothing in common with yours.",
          "Whoever the program has available in its pool.",
        ],
        ours: "The person you picked, whose identity and credentials our staff reviewed.",
      },
      {
        criterion: "How fast you learn it is wrong",
        alternatives: [
          "Months, sometimes a year.",
          "After the commitment has been made.",
        ],
        ours: "The first session, which is the entire point of the first session.",
      },
      {
        criterion: "Backing out",
        alternatives: ["Not applicable.", "Refund windows, clauses and notice."],
        ours: "Full refund up to 24 hours before the session, on terms fixed at checkout.",
      },
    ],
    footnote:
      "We will not tell you a switch takes a set number of months, and we will not quote you a success rate. Anybody who does is guessing about you specifically.",
  },

  categories: {
    eyebrow: "Where to start",
    title: "Find someone who has made your move",
    intro:
      "Every listing shows the price, the session length, and reviews left by people who actually completed a session.",
    links: [
      { label: "Career switching", href: "/explore/experts?search=Career+Switching" },
      { label: "System design", href: "/explore/experts?search=System+Design" },
      { label: "DSA", href: "/explore/experts?search=DSA" },
      { label: "Interview prep", href: "/explore/experts?search=Interview+Prep" },
      { label: "Machine learning", href: "/explore/experts?search=Machine+Learning" },
      { label: "Cloud architecture", href: "/explore/experts?search=Cloud" },
      { label: "DevOps", href: "/explore/experts?search=DevOps" },
      { label: "Business", href: "/explore/experts?search=Business" },
    ],
  },

  faqs: {
    eyebrow: "Before you book",
    title: "What switchers ask us first",
    intro: "Direct answers, none of which require a sales call.",
    items: [
      {
        question: "All six of my years are support work. Is it too late?",
        answer:
          "That is precisely what a first session is for, and the answer turns on the route rather than on the number of years. What a screener discounts, and what they can be persuaded to value, is specific enough that guessing at it is the expensive option.",
      },
      {
        question: "Will anyone actually tell me not to switch?",
        answer:
          "Some will, and that is worth paying for. You are not buying encouragement — and because experts here have their own careers, nobody has a program to sell you afterwards.",
      },
      {
        question: "Do I have to commit to months of mentoring?",
        answer:
          "No. A consultation is a single booking. Some experts also offer monthly subscription plans if you decide you want ongoing help, but nothing on this platform requires a minimum term or an income-share agreement.",
      },
      {
        question: "Can I share my current company's work?",
        answer:
          "Please don't. Bring the shape of the problem rather than the client's material — that is what an experienced reviewer works from in any case, and it keeps you on the right side of your own contract.",
      },
      {
        question: "What if the session turns out to be unhelpful?",
        answer:
          "Cancel at least 24 hours ahead and you are refunded in full. If the expert cancels, you are refunded in full whenever that happens. And because only people who completed a session can leave a review, the ratings you chose them on came from real bookings.",
      },
      {
        question: "I'm outside India. Can I book?",
        answer:
          "Yes. Prices are shown in your local currency and charged in rupees. Services to buyers outside India are zero-rated for GST as an export of services.",
      },
    ],
  },

  closing: {
    title: "Pick the route before you start running",
    description:
      "An hour with somebody who has already made the switch you are weighing up — including, if that is where it lands, the hour in which they talk you out of it.",
    primaryCta: { label: "Find an expert", href: "/explore/experts" },
    secondaryCta: {
      label: "Browse career-switch experts",
      href: "/explore/experts?search=Career+Switching",
    },
    reassurance:
      "No cohort. No income-share agreement. Cancel 24 hours ahead for a full refund.",
  },

  order: [
    "pains",
    "spine",
    "sessions",
    "checklist",
    "comparison",
    "categories",
    "faqs",
  ],
};

export default function CareerSwitchersPage() {
  return <UseCasePageLayout data={data} />;
}
