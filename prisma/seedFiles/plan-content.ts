/**
 * Realistic buyer-facing copy for seeded plans.
 *
 * Webinar and class plans used `faker.lorem.paragraph()` for their descriptions
 * and `faker.lorem.words(3)` for every curriculum module, and subscription
 * plans created no `subscriptionContents` at all — so the week-by-week roadmap
 * the profile page already rendered was permanently empty locally. Discovery
 * and detail surfaces therefore looked far thinner than the schema actually
 * supported, which is easy to mistake for a product gap rather than a seed gap.
 *
 * Everything here is deterministic given an index, so a given seeded plan reads
 * the same across runs and screenshots stay comparable.
 */

export const TARGET_AUDIENCE_POOL = [
  [
    "Engineers with 2-5 years of experience aiming for a senior title",
    "Anyone who has been passed over at the system-design round",
    "Not for absolute beginners — you should be shipping production code",
  ],
  [
    "Mid-career professionals planning a switch into tech",
    "People who have the skills but cannot get past the screening call",
    "Not a substitute for a bootcamp if you have never written code",
  ],
  [
    "First-time managers in their first six months",
    "Senior individual contributors deciding whether management is for them",
    "Not for experienced directors — the material will feel basic",
  ],
];

export const WHATS_INCLUDED_POOL = [
  [
    "Written feedback within 48 hours of every session",
    "A recording of each call, yours to keep",
    "A shared document tracking your goals week to week",
    "Async questions between sessions",
  ],
  [
    "A personalised roadmap built in session one",
    "Mock interviews with a written scorecard",
    "Resume and LinkedIn review",
    "Introductions where I can genuinely help",
  ],
  [
    "Session notes and action items after every call",
    "Templates and checklists used in the sessions",
    "Priority email support",
  ],
];

export const FAQ_POOL = [
  [
    {
      question: "What happens if I miss a session?",
      answer:
        "Reschedule up to 12 hours before and it does not count against your plan. Later than that, or a no-show, uses the session.",
    },
    {
      question: "Do I get the recordings?",
      answer:
        "Yes, when recording is enabled on the plan. Links are shared after each session and stay available for the duration of your plan.",
    },
    {
      question: "Can I get a refund?",
      answer:
        "Unused sessions are refundable pro-rata within the first two weeks. Completed sessions are not refundable.",
    },
  ],
  [
    {
      question: "How much time should I budget outside the sessions?",
      answer:
        "Plan for two to four hours a week. The sessions set direction; the work between them is where the progress happens.",
    },
    {
      question: "Is this suitable if I am not job hunting right now?",
      answer:
        "Yes. Most people start six to nine months before they intend to move, which is when the work is easiest to do well.",
    },
    {
      question: "Can I change my session slot each week?",
      answer:
        "Yes, slots are picked per session from my availability rather than fixed for the whole plan.",
    },
  ],
];

export const SUBSCRIPTION_ROADMAP = [
  {
    sectionLabel: "Week 1",
    title: "Baseline and goal setting",
    description:
      "We map where you are today against where you want to be, and agree the two or three things that actually move the needle.",
    contentType: "Video Call",
    outcomes: ["A written goal document", "An agreed 90-day target"],
  },
  {
    sectionLabel: "Week 2",
    title: "Gap analysis",
    description:
      "A hard look at the specific gaps between your current profile and the role you are targeting.",
    contentType: "Video Call",
    outcomes: ["A prioritised gap list"],
  },
  {
    sectionLabel: "Week 3",
    title: "Fundamentals deep dive",
    description:
      "We work through the highest-leverage fundamental you are missing, with problems to take away.",
    contentType: "Video Call",
    outcomes: ["Worked examples", "A practice set for the week"],
  },
  {
    sectionLabel: "Week 4",
    title: "First mock and review",
    description:
      "A full-length mock under realistic conditions, followed by a written scorecard.",
    contentType: "Review Session",
    outcomes: ["A scored mock", "Written feedback"],
  },
  {
    sectionLabel: "Week 5",
    title: "Applying the feedback",
    description:
      "We rework the weakest area from the mock until it stops being the weakest area.",
    contentType: "Video Call",
    outcomes: ["A measurable improvement on one axis"],
  },
  {
    sectionLabel: "Week 6",
    title: "Narrative and positioning",
    description:
      "Your story: why this role, why now, why you. We make it specific and true.",
    contentType: "Video Call",
    outcomes: ["A rehearsed two-minute narrative"],
  },
  {
    sectionLabel: "Week 7",
    title: "Second mock",
    description:
      "A second full mock to confirm the gains are real and repeatable under pressure.",
    contentType: "Review Session",
    outcomes: ["A second scorecard to compare against week 4"],
  },
  {
    sectionLabel: "Week 8",
    title: "Offer strategy and next steps",
    description:
      "Negotiation, timing, and what to do in the first ninety days of the new role.",
    contentType: "Q&A",
    outcomes: ["A negotiation plan", "A 90-day onboarding plan"],
  },
];

export const CLASS_CURRICULUM = [
  {
    sectionLabel: "Week 1",
    title: "Foundations and vocabulary",
    description:
      "The core concepts and the words practitioners actually use for them, so the rest of the course lands.",
    contentType: "Live Session",
  },
  {
    sectionLabel: "Week 1",
    title: "Workshop: your first end-to-end build",
    description:
      "A guided build so everyone has something working before we go deeper.",
    contentType: "Workshop",
  },
  {
    sectionLabel: "Week 2",
    title: "Going deeper on the hard parts",
    description:
      "The two or three areas where most people plateau, and how to get past them.",
    contentType: "Live Session",
  },
  {
    sectionLabel: "Week 2",
    title: "Code review clinic",
    description:
      "We review submissions from the cohort together and pull out the general lessons.",
    contentType: "Review Session",
  },
  {
    sectionLabel: "Week 3",
    title: "Real-world constraints",
    description:
      "What changes when there is legacy code, a deadline, and someone else's opinion.",
    contentType: "Live Session",
  },
  {
    sectionLabel: "Week 4",
    title: "Capstone and feedback",
    description:
      "You present what you built; the cohort and I give structured feedback.",
    contentType: "Capstone",
  },
];

export const PLAN_SUBTITLES = [
  "Get unstuck on the one thing holding your next promotion back",
  "A structured path from where you are to your next role",
  "Hands-on practice with feedback you can actually act on",
  "For engineers who can build but freeze in interviews",
  "Turn scattered effort into a plan you can follow",
];

export const CLASS_DESCRIPTIONS = [
  "A practical, cohort-based course built around building things rather than watching slides. Every week pairs a live session with work you do yourself, then a review where we look at what you produced together with the rest of the cohort.",
  "This course assumes you can already write working code and want to get materially better at design and judgement. Sessions are discussion-heavy, and you should expect to have your assumptions challenged in front of your peers.",
  "A guided run through the material most people try to learn alone from scattered blog posts. We do it in order, with someone to ask when you get stuck, and finish with something you can show.",
];

export const WEBINAR_DESCRIPTIONS = [
  "A focused single session on one topic, with the last twenty minutes kept for questions. Come with a specific problem and you will leave with a specific answer.",
  "An introductory session for people deciding whether this area is worth their time. Broad rather than deep, and honest about what the work is actually like day to day.",
  "A deep dive for practitioners who already know the basics and want the details that only come up in production.",
];

/** Deterministic pick so a given seed index always reads the same. */
export function pick<T>(pool: T[], index: number): T {
  return pool[index % pool.length];
}

