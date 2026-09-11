import type { Metadata } from "next";

import UseCasePageLayout from "../UseCasePageLayout";
import type { UseCasePageData } from "../UseCasePageLayout";

export const metadata: Metadata = {
  title: "Long-Term 1:1 Mentorship in India | Familiarise",
  description:
    "Monthly mentorship plans set by the expert — one to twenty-four months, an agreed number of calls, chat in between. Try the fit first where a trial is offered. Cancel a session 24 hours ahead for a full refund.",
};

/**
 * Segment thesis: this is the only page selling a *commitment*, so it leads with
 * the comparison rather than the pitch — including the case for not buying it.
 * The one genuinely citable proof device on any of these pages lives here: the
 * duration-versus-outcome finding, quoted with its own limitation stated. Every
 * competitor in this category leans on unsourced outcome percentages instead.
 *
 * Sources for the framing:
 * - Duration drives mentoring outcomes and early-terminating matches can leave
 *   people worse off — Grossman & Rhodes, "The Test of Time" (2002), n=1,138,
 *   https://pubmed.ncbi.nlm.nih.gov/12002243/ and
 *   https://link.springer.com/article/10.1023/A:1014680827552
 * - Why relationships fail (mismatch, distancing/neglect, insufficient
 *   expertise) — Eby et al. (2004), https://scse.d.umn.edu/sites/scse.d.umn.edu/files/eby_and_mcmannus_2004.pdf
 *   and Straus et al. (2013), https://pubmed.ncbi.nlm.nih.gov/23165266/
 * - Cold outreach is a losing numbers game — Belkins 2025 LinkedIn outreach
 *   study, 15.1M touchpoints, 7.2% reply / 1.3% meeting:
 *   https://belkins.io/blog/linkedin-outreach-study (sales outreach, so it is
 *   used qualitatively here and no figure appears in the copy).
 */
const data: UseCasePageData = {
  hero: {
    eyebrow: "For ongoing mentorship",
    titleLead: "Advice fades.",
    titleAccent: "A relationship compounds.",
    subtitle:
      "One call answers the question you have today. A monthly plan is for the year in which the questions keep changing — and someone who already knows your context answers them.",
    primaryCta: { label: "Find a mentor", href: "/explore/experts" },
    secondaryCta: {
      label: "See top-rated experts",
      href: "/explore/experts?sort=rating",
    },
    assurances: [
      "Where an expert offers a trial session, it is free",
      "Plans run one to twenty-four months — you choose",
      "Cancel a session 24 hours ahead for a full refund",
    ],
    card: {
      title: "What ongoing buys that a single call cannot",
      items: [
        "No re-explaining. By the third session they know your team, your manager and your constraints.",
        "Course correction between decisions rather than post-mortems after them.",
        "Somebody who remembers what you said you would do last month, and asks about it.",
        "Chat between sessions, so a small blocking question does not have to wait three weeks.",
      ],
      footnote:
        "Each expert sets their own plan: the number of calls, the session length, the term and the monthly price are all on their profile before you commit to anything.",
    },
  },

  comparison: {
    eyebrow: "Read this before the pitch",
    title: "Ongoing mentorship is not always the right purchase",
    intro:
      "It is the most expensive thing on this platform and the one that most often goes unused. Here is the honest comparison, including the cases where you should buy something else.",
    alternatives: [
      "A single consultation",
      "An informal mentor you found yourself",
    ],
    ourLabel: "A subscription here",
    rows: [
      {
        criterion: "Best for",
        alternatives: [
          "One decision you can name today.",
          "Occasional generous advice, on their schedule.",
        ],
        ours: "A stretch of months in which the questions keep changing.",
      },
      {
        criterion: "Context",
        alternatives: [
          "The first ten minutes go on explaining yourself.",
          "Varies with how much of your situation they retain.",
        ],
        ours: "Accumulates across sessions and is carried forward.",
      },
      {
        criterion: "Between sessions",
        alternatives: ["Nothing.", "Whenever they happen to have time."],
        ours: "A dedicated chat channel, plus documents and materials shared on the plan.",
      },
      {
        criterion: "What you commit to",
        alternatives: [
          "A single booking.",
          "Nothing — and there is no obligation on their side either.",
        ],
        ours: "A term you choose, from one month to twenty-four.",
      },
      {
        criterion: "Cost",
        alternatives: [
          "The session price, shown before you book.",
          "Free, and priced accordingly in reliability.",
        ],
        ours: "A monthly price the expert sets, visible before you subscribe.",
      },
    ],
    footnote:
      "If your question is a single question, book the single session. We would much rather sell you an hour that works than a year that does not.",
  },

  pains: {
    eyebrow: "Why mentorship usually fails",
    title: "The failure modes are well documented, and none of them are effort",
    intro:
      "Research on mentoring relationships keeps finding the same causes of breakdown: mismatch, neglect, and a mentor who quietly disengages. Almost none of it is about the mentee not trying.",
    items: [
      {
        title: "Advice without follow-through is entertainment",
        description:
          "The insight lands, the week resumes, and nothing actually changes. What converts advice into a different outcome is not a better insight — it is somebody expecting an answer from you next month.",
      },
      {
        title: "Cold outreach is a numbers game you are set up to lose",
        description:
          "The senior people you want are precisely the ones with no spare time, and an unpaid request from a stranger sits at the bottom of every inbox. Paying for the time is not a lesser version of a real mentorship; it is the thing that makes the calendar entry exist at all.",
      },
      {
        title: "Informal mentorships expire without anyone deciding to end them",
        description:
          "No cadence, no written goal, and a slow drift into we-should-catch-up-sometime. Both sides feel vaguely guilty, and neither of them is the one who reschedules.",
      },
      {
        title: "Your problems move faster than a distant advisor can track",
        description:
          "What you need in month one is not what you need in month six. Somebody who only knows the surface of your situation keeps carefully answering the question you have already outgrown.",
      },
    ],
    footnote:
      "The most rigorous evidence here comes from youth mentoring rather than careers, so treat it as suggestive: tracking 1,138 matched pairs over eighteen months, Grossman and Rhodes found that longer relationships produced the largest gains — and that relationships ending very early left participants measurably worse off than no mentoring at all. It is the strongest argument we know of both for committing properly and for checking the fit before you do.",
  },

  spine: {
    variant: "cadence",
    eyebrow: "How an arc actually runs",
    title: "The first few months, honestly described",
    intro:
      "This is the shape most ongoing engagements take. Your expert sets the actual cadence and session count — what follows is the pattern, not a promise.",
    items: [
      {
        label: "Session zero",
        title: "The trial, where the expert offers one",
        description:
          "A short introductory session so both of you can test the fit before money changes hands. Not every expert enables it; where they do it is free, and it is much the cheapest way to avoid committing to the wrong person.",
      },
      {
        label: "First month",
        title: "Context in, goals out",
        description:
          "You stop explaining and they start noticing. What the first month should produce is two or three concrete goals with dates attached, rather than a pleasant general sense of direction.",
      },
      {
        label: "Middle months",
        title: "The unglamorous part, where it actually works",
        description:
          "Progress reviews, course corrections, and the specific conversations you have been avoiding. Chat between sessions absorbs the small blocking questions so the calls stay on the large ones.",
      },
      {
        label: "Ongoing",
        title: "Renew, change, or stop",
        description:
          "Plans run for the term you chose. If it is not earning its place, stopping is the correct answer — and a mentor worth having will usually say so before you do.",
      },
    ],
  },

  sessions: {
    eyebrow: "What a plan includes",
    title: "Everything on one platform, not five",
    intro:
      "No Zoom links pasted into a chat you cannot find later, and no documents lost in an email thread.",
    items: [
      {
        icon: "video",
        title: "Scheduled 1:1 calls",
        description:
          "An agreed number of calls at a length the expert defines, on the platform's own video rather than a link posted somewhere and subsequently lost.",
      },
      {
        icon: "message",
        title: "Chat between sessions",
        description:
          "A dedicated channel for the questions that cannot wait three weeks but do not deserve an entire call of their own.",
      },
      {
        icon: "file",
        title: "Documents and materials",
        description:
          "Attach work for review and get it back annotated. Experts can also share materials against the plan, so the useful things accumulate in one place.",
      },
      {
        icon: "users",
        title: "Their classes and webinars",
        description:
          "Many experts also run group programs. Those are separate bookings, but they come from the same person you have already decided to trust.",
      },
    ],
  },

  categories: {
    eyebrow: "Where to start",
    title: "Find someone worth a standing calendar entry",
    intro:
      "Every profile shows the plan's price, term and session count, plus reviews left only by people who actually completed a session.",
    links: [
      { label: "Technology", href: "/explore/experts?search=Technology" },
      { label: "Business", href: "/explore/experts?search=Business" },
      { label: "Education", href: "/explore/experts?search=Education" },
      { label: "Health", href: "/explore/experts?search=Health" },
      { label: "Creative Arts", href: "/explore/experts?search=Creative+Arts" },
      {
        label: "Personal development",
        href: "/explore/experts?search=Personal+Development",
      },
      { label: "System design", href: "/explore/experts?search=System+Design" },
      { label: "Interview prep", href: "/explore/experts?search=Interview+Prep" },
    ],
  },

  faqs: {
    eyebrow: "Before you subscribe",
    title: "The questions worth asking first",
    intro:
      "Especially the ones about getting out again, which is the part nobody advertises.",
    items: [
      {
        question: "How do I try someone before committing to months?",
        answer:
          "Where an expert has enabled a trial session it is free and short — often around half an hour — and its only job is to test the fit. Where they have not, book a single consultation with them first; it does the same work at a price you can see up front.",
      },
      {
        question: "How long do plans run, and who decides?",
        answer:
          "The expert does. They set the term — anywhere from one month to twenty-four — along with the number of calls, the session length and the monthly price. All of it is visible on their profile before you subscribe.",
      },
      {
        question: "What if my mentor stops showing up?",
        answer:
          "Report it from the booking. Our team reviews the attendance record for that session and can arrange a full refund or a reschedule. If the expert cancels a session outright, that session is refunded in full regardless of when they cancel.",
      },
      {
        question: "Can I change mentors?",
        answer:
          "Yes. Plans are per expert, so you end one and start another — there is nothing to transfer and nobody whose permission you need.",
      },
      {
        question: "Are the sessions recorded?",
        answer:
          "Not the 1:1 ones. Recording exists only for group formats — webinars and classes — and only when the expert has switched it on for that plan. Nothing about a private mentoring call is recorded by default.",
      },
      {
        question: "Is this cheaper than a course?",
        answer:
          "It is a different purchase, so compare it honestly rather than on price. A course sells you a syllabus; a mentor sells you attention on your particular situation. If what you actually need is the syllabus, buy the course — it will be cheaper and it will work.",
      },
      {
        question: "How are experts vetted?",
        answer:
          "They submit identity and credential documents, and a member of our staff reviews them individually before the profile is marked Verified. We do not run criminal background checks, and we would rather say so than imply a check we do not perform.",
      },
    ],
  },

  closing: {
    title: "Start with the fit, not the commitment",
    description:
      "Take the trial where it is offered, or book a single session first. Turn it into a plan only once the person has proved they are worth a standing entry in your calendar.",
    primaryCta: { label: "Find a mentor", href: "/explore/experts" },
    secondaryCta: {
      label: "See top-rated experts",
      href: "/explore/experts?sort=rating",
    },
    reassurance:
      "Plans run for a term you choose. Sessions cancel 24 hours ahead for a full refund.",
  },

  order: ["comparison", "pains", "spine", "sessions", "categories", "faqs"],
};

export default function MentorshipPage() {
  return <UseCasePageLayout data={data} />;
}
