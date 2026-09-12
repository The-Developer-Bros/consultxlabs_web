# KPI Dashboard And Operating Cadence

**Purpose:** Make the first 90 days measurable without buying a heavy CRM.

## North Star

Monthly active consultants: consultants who complete at least one paid session in a calendar month.

Why:

- Signups are vanity.
- GMV is lagging.
- Active consultants show supply health and marketplace usefulness.

## CRM Fields

Use Google Sheets or Zoho CRM free tier.

Required columns:

- `lead_id`
- `name`
- `linkedin_url`
- `email`
- `x_url`
- `city_country`
- `current_role`
- `company`
- `expertise_area`
- `source`
- `proof_link`
- `existing_monetization_signal`
- `audience_signal`
- `score_expertise`
- `score_audience`
- `score_platform_fit`
- `score_activity`
- `total_score`
- `suggested_first_offer`
- `personalization_line`
- `status`
- `owner`
- `last_touch_date`
- `next_touch_date`
- `reply_status`
- `demo_date`
- `signup_date`
- `activation_date`
- `first_booking_date`
- `notes`

Status values:

- `new`
- `qualified`
- `message_drafted`
- `contacted`
- `connected`
- `replied`
- `demo_booked`
- `demo_completed`
- `signed_up`
- `activated`
- `first_booking`
- `review_collected`
- `nurture`
- `not_fit`
- `not_interested`

## Lead Scoring

Score each 1-5.

| Dimension | 1 | 3 | 5 |
| --- | --- | --- | --- |
| Expertise | Generic engineer | Senior in useful domain | Recognized mentor/speaker/specialist |
| Audience | No visible audience | Some posts or network | Engaged audience or existing demand |
| Platform fit | Only one vague use case | 1-2 clear offers | Multiple service formats fit |
| Activity | Inactive online | Occasional posts | Active in last 30 days |

Priority:

- 16-20: founder outreach.
- 12-15: intern drafted, founder reviewed.
- 8-11: nurture or content audience.
- Below 8: skip.

## Funnel Metrics

Track weekly.

| Funnel stage | Week 4 target | Week 8 target | Day 90 target |
| --- | ---: | ---: | ---: |
| Qualified leads in CRM | 300 | 700 | 1,000 |
| Outreach sent | 100 | 350 | 600 |
| Qualified replies | 15 | 50 | 90 |
| Demo calls booked | 10 | 25 | 35 |
| Demo calls completed | 7 | 18 | 28 |
| Consultant signups | 5 | 15 | 25 |
| Activated consultants | 3 | 10 | 15 |
| First paid bookings | 0-3 | 10 | 25 |
| Reviews | 0-2 | 6 | 15 |

## Channel KPIs

| Channel | Primary KPI | Minimum threshold |
| --- | --- | ---: |
| LinkedIn manual | Qualified reply rate | 12% target, 8% floor |
| Sales Navigator | Demo booked per InMail | 5%+ |
| Cold email | Qualified reply rate | 2% floor |
| X/Twitter | Qualified conversations | 3/month |
| Instagram | Qualified DMs or webinar signups | 2/month early |
| Facebook | Qualified comments/DMs | 2/month early |
| Reddit | Useful conversations or insights | 4/month |
| Webinars | Booking interest from attendees | 5-10% |
| SEO | Indexed profile/pages and impressions | Upward trend |
| Offline | Demo calls per event | 2+ |

## Weekly Dashboard

Create a single weekly report:

```text
WEEK OF:

SUPPLY FUNNEL
Qualified leads added:
Outreach sent:
Qualified replies:
Demo booked:
Demo completed:
Signups:
Activated consultants:

DEMAND / BOOKINGS
Webinar registrations:
Webinar attendees:
Booking interests:
Paid bookings:
GMV:
Reviews collected:

CHANNELS
Best channel:
Worst channel:
Highest quality reply:
Top objection:

OPERATIONS
Profiles completed:
Offers created:
Availability set:
Payout readiness:
Support issues:

NEXT WEEK
Top 10 prospects:
Experiments to start:
Experiments to stop:
Founder asks:
```

## Daily Standup

10 minutes async or live.

Sales / CS intern answers:

- How many leads added yesterday?
- How many messages drafted?
- Which replies need founder action?
- Which demos/onboardings are scheduled?
- Any CRM hygiene issues?

Marketing intern answers:

- What shipped yesterday?
- What proof asset is next?
- Which consultant profile needs work?
- What content generated conversation?

Founder answers:

- Which prospects get personal attention today?
- Which objections need new scripts?
- Which product issues block activation?

## Weekly Meeting

60 minutes every Friday.

Agenda:

1. Funnel review.
2. Channel review.
3. Objection review.
4. Consultant activation review.
5. Content/proof review.
6. Next week's top 20 targets.
7. Kill/scale decisions.

## Intern Scorecards

### Sales / CS Intern

Weekly targets:

- 100 qualified rows reviewed or enriched.
- 50 new qualified leads.
- 50 message drafts.
- 95% CRM completeness.
- All warm replies routed to founder within 1 business day.
- All onboarding checklists updated.

Quality bar:

- Personalization lines must be specific.
- Suggested offer must match expertise.
- No duplicate prospects.
- No spammy language.

### Marketing Intern

Weekly targets:

- 5 social posts.
- 1 consultant spotlight.
- 1 SEO draft or profile optimization batch.
- 1 webinar/proof asset if available.
- Competitor/content notes updated.

Quality bar:

- Copy must be specific to tech mentors or tech consultees.
- No unverifiable claims.
- No generic "unlock your potential" language.
- Every post has a clear audience and CTA.

## Scale Rules

Scale a channel when:

- It beats minimum KPI for 2 consecutive weeks.
- It produces qualified conversations, not just views.
- Founder can close or delegate the follow-up.
- Cost per activated consultant is below ₹2,000 excluding founder time.

Examples:

- LinkedIn beats 15% qualified reply rate for 100 messages: increase founder/intern volume carefully.
- Webinars produce 5+ booking interests twice: make webinars weekly.
- Cold email gets 5% reply with low bounce: add another 100 verified prospects.

## Kill Or Pause Rules

Pause a channel when:

- It misses the minimum threshold for 2 consecutive weeks.
- It damages trust or triggers moderation/spam issues.
- It consumes founder time without qualified conversations.
- It attracts low-fit prospects.

Do not kill SEO before 90 days. SEO is evaluated on indexing, impressions, and content quality early.

## First 90-Day Retrospective

At day 90, answer:

- Which channel recruited the best consultants?
- Which channel created first bookings?
- Which ICP converted fastest?
- Which offer type sold first?
- What objection appeared most?
- What product gap blocked activation?
- What proof asset converted best?
- Should we deepen tech or add an adjacent vertical?
- Should interns continue, convert, or be replaced?

