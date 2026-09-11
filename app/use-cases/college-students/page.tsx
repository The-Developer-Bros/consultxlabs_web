import type { Metadata } from "next";

import UseCasePageLayout from "../UseCasePageLayout";
import type { UseCasePageData } from "../UseCasePageLayout";

export const metadata: Metadata = {
  title: "Career Guidance for College Students in India | Familiarise",
  description:
    "Placement season, off-campus hunting, and the job-vs-GATE-vs-CAT-vs-GRE fork — talk 1:1 with people who have already run them. Rupee pricing on the profile, full refund 24 hours ahead.",
};

/**
 * Segment thesis: the student's problem is a *calendar*, not a skills gap — the
 * decisions that matter (internship→PPO, eligibility, resume, drive formats,
 * the higher-studies fork) are date-bound, so the spine is a timeline. Positioned
 * against the two real substitutes for Indian students: free advice, and
 * cohort/ISA programs. No outcome statistics anywhere — see the comparison
 * footnote, which makes that refusal the differentiator.
 *
 * Framing sources (deliberately none of them quoted as figures in the copy, so
 * nothing on this page can go stale or be challenged):
 * - Tier-2/3 placement contraction and the entry-level experience paradox —
 *   https://www.thequint.com/jobs/campus-placement-jobs-fall-economic-crisis-unemployment-iit-iim-ai-degrees
 * - Employers shifting from marks to demonstrable "proof of work" —
 *   https://www.business-standard.com/industry/news/nearly-73-employers-plan-to-hire-freshers-in-first-half-of-2026-report-126021800516_1.html
 * - Season shape, Day 0 / slots / dream-offer rules as students describe them —
 *   https://home.iitd.ac.in/show.php?id=804&in_sections=News and college
 *   placement policies such as https://www.tce.edu/placement/categories
 * - Buyers now distrust flawless social proof, which is why this page has none —
 *   https://www.powerreviews.com/how-fake-reviews-destroy-consumer-trust/
 */
const data: UseCasePageData = {
  hero: {
    eyebrow: "For students in India",
    titleLead: "Placement season is a calendar.",
    titleAccent: "Not a lottery.",
    subtitle:
      "Talk to the people who have sat on the other side of the table — at the companies visiting your campus, and at the ones that never will. One call, one price, in rupees.",
    primaryCta: { label: "Find an expert", href: "/explore/experts" },
    secondaryCta: {
      label: "See interview-prep experts",
      href: "/explore/experts?search=Interview+Prep",
    },
    assurances: [
      "Cancel 24 hours ahead for a full refund",
      "Pay in ₹ by UPI, card or net banking",
      "No cohort fee, no income-share agreement",
    ],
    card: {
      title: "What a first session usually gets used for",
      items: [
        "Working out which companies on your campus list are worth a Day-1 slot, and which are a distraction.",
        "A resume read by someone who has actually screened resumes for that role — not a template, not a checklist.",
        "One mock round in the format you will really face: DSA, system design, case, guesstimate or HR.",
        "An honest answer on job versus GATE, CAT, GRE or UPSC, from someone who picked one of them.",
      ],
      footnote:
        "Experts set their own price and their own session length. Both are on the profile before you book, and the shortest consultation on the platform is 30 minutes.",
    },
  },

  pains: {
    eyebrow: "The real blockers",
    title: "What actually stops students — and it isn't effort",
    intro:
      "The parts of placement season that decide the outcome are mostly invisible from inside a campus, which is why working harder at the visible parts changes so little.",
    items: [
      {
        title: "The shortlist is decided before you walk in",
        description:
          "Sixty percent throughout, a CGPA cutoff, branch eligibility and active-backlog rules filter you out of drives long before anybody interviews you. Which of those constraints can still be worked around, and which are final, is the most useful thing to establish early — and nobody on campus is especially incentivised to tell you.",
      },
      {
        title: "Off-campus is a completely different game",
        description:
          "If the companies you want do not visit your college, the route is referrals, cold applications and a profile that survives a keyword filter before a human sees it. That is a learnable skill with its own tactics, and it is not on anyone's syllabus.",
      },
      {
        title: "Your seniors' advice has quietly expired",
        description:
          "Hiring bars, interview formats and the fresher market move faster than campus lore does. Advice from a batch that placed three years ago describes a market that no longer exists, delivered with total confidence.",
      },
      {
        title: "You are deciding job versus higher studies on vibes",
        description:
          "CAT, GATE, GRE and UPSC each want a year of your life, and each application window closes before you feel ready to commit. Most students make that call on the opinion of whoever spoke to them last.",
      },
    ],
  },

  spine: {
    variant: "timeline",
    eyebrow: "The year, laid out",
    title: "Where an hour of someone else's experience actually changes things",
    intro:
      "Almost all the leverage in placement season sits in the months before the drive, not the week of it. These are the points where a single conversation redirects what you do next.",
    items: [
      {
        label: "Pre-final year",
        title: "The summer internship, and the PPO it can become",
        description:
          "A pre-placement offer is the cheapest route through the entire season, and it is won a year before the season begins. Getting shortlisted for the internship is a different exercise from getting placed, and it rewards planning that most students start far too late.",
      },
      {
        label: "Before the season opens",
        title: "Eligibility, registration and the dream-offer rules",
        description:
          "Criteria, registrations and your placement cell's own rulebook land before anything else. This is when to work out which companies you are eligible for, what counts as a dream or super-dream offer at your college, and at what point accepting one puts you out of placement altogether.",
      },
      {
        label: "Run-up to the drives",
        title: "Resume, projects and the keyword filter",
        description:
          "Your resume gets about as much attention as it takes to scroll past it. This is the window to rewrite it around outcomes rather than coursework, and to finish the one project you can defend under questioning.",
      },
      {
        label: "Drive season",
        title: "Day 0, Day 1, and the slots after them",
        description:
          "Aptitude, DSA, system design, case rounds and HR, in formats that differ by company and by role. Practising the wrong round is worse than not practising at all, and a mock with somebody who has actually conducted that round tells you where you stand within an hour.",
      },
      {
        label: "After the campus route",
        title: "Off-campus, and the higher-studies fork",
        description:
          "If the campus process does not land, the off-campus one runs on referrals, timing and volume — and it carries a stigma it does not deserve, given how many people it is the default route for. Running in parallel are the CAT, GATE, GRE and UPSC calendars, each of which wants a decision rather than a maybe.",
      },
    ],
    footnote:
      "Calendars differ by college and by year. Treat this as the shape of the season, not as your institute's official schedule.",
  },

  sessions: {
    eyebrow: "What you book",
    title: "Specific sessions, not open-ended mentoring",
    intro:
      "You are booking a named person for a defined block of time to do one concrete thing. Everything below is a real session type on the platform.",
    items: [
      {
        icon: "file",
        title: "Resume and profile review",
        description:
          "Attach your resume and portfolio to the booking beforehand. Experts can return documents with review notes, so the call itself is spent on the conversation rather than on reading.",
      },
      {
        icon: "video",
        title: "A mock round in your actual format",
        description:
          "DSA, system design, case, guesstimate or HR — booked with someone who has run that round professionally, and who will tell you where you stand rather than being encouraging.",
      },
      {
        icon: "target",
        title: "Campus-list strategy",
        description:
          "Which drives to sit, which to skip, and where your first slot goes. An hour on this before the season is worth more than a month of preparation aimed at the wrong companies.",
      },
      {
        icon: "compass",
        title: "The higher-studies fork",
        description:
          "Job now, GATE, CAT, GRE or UPSC. Book people who took each of those roads and can describe what it actually cost them, before the forms close on you.",
      },
    ],
  },

  comparison: {
    eyebrow: "Be honest about the alternatives",
    title: "You have three options. Here they are, without the spin.",
    intro:
      "Free advice and paid programs both work for some people. This is where each of them puts the risk, and where we put it.",
    alternatives: ["Free advice online", "Cohort and pay-after-placement programs"],
    ourLabel: "Familiarise",
    rows: [
      {
        criterion: "What it costs",
        alternatives: [
          "Nothing, plus the cost of acting on advice that did not apply to you.",
          "A program fee, or a share of a salary you have not earned yet.",
        ],
        ours: "The expert's own price, in rupees, shown on their profile before you book.",
      },
      {
        criterion: "What you commit to",
        alternatives: [
          "Nothing.",
          "Fixed cohorts, minimum months, or an agreement signed before you start.",
        ],
        ours: "One session. No minimum, no lock-in, nothing to sign.",
      },
      {
        criterion: "Who you get",
        alternatives: [
          "Whoever answers the cold message.",
          "Whoever the program assigns you from its pool.",
        ],
        ours: "The person you choose, after reading their profile, credentials and reviews.",
      },
      {
        criterion: "If it turns out to be useless",
        alternatives: [
          "You lost an evening.",
          "A refund window measured in days, after a large upfront payment.",
        ],
        ours: "Cancel 24 hours ahead for a 100% refund. The policy is fixed at checkout and cannot change afterwards.",
      },
      {
        criterion: "Reaching an actual human",
        alternatives: [
          "Depends on a cold message landing.",
          "Usually a callback from a sales team before anything else.",
        ],
        ours: "Pick a slot and book it. No brochure, no callback, no counsellor.",
      },
    ],
    footnote:
      "We do not publish a placement rate. Nobody in this category can substantiate one, and we would rather you judged us on the profile in front of you.",
  },

  categories: {
    eyebrow: "Where to start",
    title: "Browse by what you need this month",
    intro:
      "Every listing shows the expert's price, session length and reviews before you commit to anything.",
    links: [
      { label: "Interview prep", href: "/explore/experts?search=Interview+Prep" },
      { label: "DSA", href: "/explore/experts?search=DSA" },
      { label: "System design", href: "/explore/experts?search=System+Design" },
      { label: "Data science", href: "/explore/experts?search=Data+Science" },
      { label: "Technology", href: "/explore/experts?search=Technology" },
      { label: "Business", href: "/explore/experts?search=Business" },
      { label: "Creative Arts", href: "/explore/experts?search=Creative+Arts" },
      { label: "Education", href: "/explore/experts?search=Education" },
    ],
  },

  faqs: {
    eyebrow: "Before you book",
    title: "The questions students actually ask us",
    intro:
      "Short answers, and none of them require you to speak to anyone first.",
    items: [
      {
        question: "How much does a session cost?",
        answer:
          "Each expert sets their own price, and it is shown on their profile in rupees before you book. Our commission is already inside that number, so there is no separate booking fee. Buyers in India see 18% GST added at checkout because Indian law requires it; buyers outside India are zero-rated as an export of services.",
      },
      {
        question: "I'm from a tier-2 or tier-3 college. Is this for me?",
        answer:
          "Particularly. On-campus hiring is the part of the process your college controls. Off-campus is the part you control, and it is the part almost nobody is taught. Here you choose an expert by what they have done and where they have worked, not by which campus they visit.",
      },
      {
        question: "What if the session isn't useful?",
        answer:
          "Cancel at least 24 hours before the start time and you are refunded in full. If your expert cancels, you are refunded in full regardless of timing. The cancellation terms are recorded against your booking at checkout, so nothing about them can be changed after you have paid.",
      },
      {
        question: "What if the expert doesn't turn up?",
        answer:
          "Report it from the booking itself. Our team reviews the session's attendance record and can arrange a full refund or a reschedule. We deliberately do not automate that decision, because a genuine connectivity failure and a no-show look identical to a script.",
      },
      {
        question: "Can I send my resume before the call?",
        answer:
          "Yes. Documents attach to the booking, and the expert can return them with review notes. That way the session is spent discussing the work rather than reading it.",
      },
      {
        question: "Are the experts actually verified?",
        answer:
          "Experts submit identity and credential documents, and a member of our staff reviews them individually before a profile is marked Verified. Separately, only someone who has completed a session with that expert can leave a review — so the ratings you are reading came from real bookings.",
      },
      {
        question: "Can I reschedule if a drive clashes?",
        answer:
          "Yes, up to 24 hours before the session starts, at no extra cost. Inside 24 hours the slot is already committed on the expert's calendar and can no longer be moved.",
      },
    ],
  },

  closing: {
    title: "Start with one hour, not one year",
    description:
      "Pick someone whose path you would want, read what people who actually met them said, and book a slot. No brochure, no callback, nothing to sign.",
    primaryCta: { label: "Find an expert", href: "/explore/experts" },
    secondaryCta: {
      label: "Browse interview prep",
      href: "/explore/experts?search=Interview+Prep",
    },
    reassurance:
      "Cancel 24 hours ahead for a full refund. Pay in ₹ by UPI, card, net banking or wallet.",
  },

  order: ["pains", "spine", "sessions", "comparison", "categories", "faqs"],
};

export default function CollegeStudentsPage() {
  return <UseCasePageLayout data={data} />;
}
