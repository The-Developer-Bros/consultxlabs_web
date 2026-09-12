# Product Subsystems And Selling Points

**Purpose:** Convert the app's real capabilities into honest sales language for consultants, consultees, and future organizations.

This document is based on the current app surface, Prisma schema, and existing docs. Use it as the source of truth for what the sales team can safely say.

## Core Product Map

| Subsystem | Product reality | Selling point |
| --- | --- | --- |
| Consultant profiles | `ConsultantProfile`, domains, subdomains, tags, reviews, verification, work/education/certifications at user level | "Build a credible expert profile with domain tags, credentials, reviews, and verification signals." |
| 1:1 consultations | `ConsultationPlan`, `Consultation`, request status, payment URL, cancellation tracking, appointment link | "Sell focused calls for system design, DSA, resume review, career strategy, code review, or startup tech advisory." |
| Subscriptions | `SubscriptionPlan`, `Subscription`, recurring schedule period, calls/week, total sessions, trial conversion | "Turn one-off advice into ongoing mentorship programs with recurring sessions." |
| Trial sessions | `TrialSession`, trial appointment, status, conversion to subscription | "Offer a free trial for high-trust mentorship without losing conversion tracking." |
| Webinars | `WebinarPlan`, `Webinar`, max participants, recording settings, waitlist | "Run live group sessions and convert attendees into 1:1 or subscription clients." |
| Classes | `ClassPlan`, `Class`, class content, multi-session scheduling, max participants | "Package structured multi-week learning, not just ad hoc calls." |
| Appointments | Unified `Appointment` model for consultations, subscriptions, webinars, classes, trials | "One scheduling backbone across every service format." |
| Availability | Weekly and custom slots, UTC-aware storage, booking allocation services | "Timezone-aware scheduling built for real calendars." |
| Documents | `AppointmentDocument`, review status, consultant response documents | "Let clients upload resumes, portfolios, architecture docs, or code notes before sessions, and respond with reviewed material." |
| Video and chat | Stream meeting and channel APIs, recordings, meeting sessions | "Integrated video and chat instead of external Zoom-link juggling." |
| Payments | Razorpay, Stripe, payment legs, discounts, refunds, disputes, invoices | "Payments, discounts, refunds, disputes, receipts, and invoices are part of the platform workflow." |
| Earnings and payouts | Consultant earnings, payout accounts, payout batches, TDS records, hold/release states | "Consultants can see earnings and payout status instead of reconciling money manually." |
| Referrals | Referral codes, referral credits, credit usage, referral landing route | "Referral credits can reduce acquisition cost and bring repeat bookings back into the platform." |
| Reviews | Consultant reviews and ratings | "Verified social proof can compound profile conversion." |
| Support/admin | Support tickets, moderation, refunds, disputes, system jobs, maintenance | "There is an operating layer behind sessions, not just a booking page." |
| Enterprise/org layer | Organizations, memberships, programs, billing accounts, contracts, wallets, invoices, SSO settings, audit logs | "Future-ready for sponsored learning, company experts, GST-style invoicing, org programs, and SSO." |

## Consultant-Facing Claims

Use these claims in sales scripts, landing pages, and onboarding:

- "You can sell more than calls: 1:1 consultations, ongoing subscriptions, webinars, and classes."
- "Your client journey can happen inside Familiarise: booking, payment, reminders, video, chat, document review, and reviews."
- "The 10% commission is paying for the operating layer: scheduling, payments, video, document workflows, support, trust signals, and admin."
- "You do not need to leave your existing platform on day one. Start by running one offer on Familiarise and compare conversion, workflow, and client experience."
- "Familiarise is built for Indian professional services, with Razorpay and compliance-oriented payout/invoice foundations."

Do not say:

- "We will bring you guaranteed clients."
- "You will earn more automatically."
- "We are cheaper than everyone in every case."
- "We replace your audience-building work."
- "Payouts are instant" unless product operations explicitly support it.

## Consultee-Facing Claims

Use these for demand-side campaigns after credible supply exists:

- "Book Indian tech mentors for system design, DSA, resume review, career strategy, mock interviews, and startup tech advice."
- "Upload context before the session so the expert can review your resume, portfolio, or technical notes."
- "Choose one-off help or longer mentorship."
- "Attend free or paid webinars before booking deeper 1:1 guidance."
- "Payments, scheduling, video, chat, and documents stay in one place."

Do not say:

- "Guaranteed job."
- "Guaranteed referral."
- "Guaranteed interview conversion."
- "Official FAANG mentorship" unless the mentor and employer relationship permits that wording.

## Organization-Facing Claims

Use only in founder-led conversations until B2B motion is intentionally activated:

- "Familiarise has an organization layer for sponsored learning and expert programs."
- "The model can support buyer organizations, provider organizations, or hybrid organizations."
- "The schema supports memberships, programs, billing accounts, contracts, invoices, rate cards, SSO settings, audit logs, and HRIS stubs."
- "The first few B2B deals should be design partnerships with manual support."

Do not say:

- "Fully self-serve enterprise is ready" unless that has been tested end to end.
- "We support every HRIS/SSO scenario today."
- "We are an LMS replacement." The better phrase is "expert-led mentoring and consultation layer."

## Feature-To-Offer Translation

| Tech mentor offer | Product features to use | Suggested price floor |
| --- | --- | ---: |
| System design mock interview | Consultation, appointment, document upload, review, video | ₹1,499-₹4,999 |
| Resume and LinkedIn review | Consultation, document upload, consultant response document | ₹799-₹2,499 |
| SDE career strategy call | Consultation, notes, review request | ₹999-₹2,999 |
| 4-week interview mentorship | Subscription, trial session, recurring appointments, chat | ₹4,999-₹19,999 |
| Live system design webinar | Webinar, waitlist, recording, email follow-up | Free to ₹499 |
| Multi-week backend class | Class, class content, appointments, recordings, materials | ₹3,999-₹24,999 |
| Startup CTO office hours | Consultation or subscription, document review, recurring support | ₹2,999-₹15,000 |

## Proof Assets To Collect

Every activated consultant should produce at least three proof assets:

1. Public profile with headline, expertise tags, proof points, and one paid offer.
2. One LinkedIn post announcing the offer and explaining who it helps.
3. One short testimonial, review, or session outcome after the first booking.

The marketing intern should turn these into:

- Consultant spotlight posts.
- Short clips or carousels.
- SEO profile blurbs.
- Webinar recap posts.
- Case study snippets after 3+ successful sessions.

## Messaging Guardrails

Use "business platform for expert services" more than "marketplace" when selling consultants. "Marketplace" makes people expect discovery. "Business platform" makes the operating value clear.

Use "tech mentor launch cohort" more than "all experts welcome." This keeps supply quality high.

Use "10% platform fee" or "10% commission" consistently. Avoid "only 10%" in contexts where competitors may also claim 10%; explain what is included in the 10%.

