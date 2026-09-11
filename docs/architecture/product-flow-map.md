# Familiarise — Product Flow Map

Complete permutation map of every customer journey on the platform, with Mermaid diagrams. Written for a half-technical, half-business CEO reading.

---

## 1. The Four Products Inside One Platform

You are not building one product. You are building **four distinct commerce models** under one roof.

```mermaid
flowchart TD
    Platform["🏪 Familiarise Platform\n\"Shopify for Knowledge Businesses\""]

    Platform --> C["📞 Consultation\n1-on-1 · single session · 30–90 min"]
    Platform --> S["🔁 Subscription\n1-on-1 · recurring program · 4–32 sessions"]
    Platform --> W["📡 Webinar\nGroup live event · N learners · 1 session"]
    Platform --> CL["🎓 Class\nGroup structured course · 6–20 sessions"]

    C --> C1["Individual or Org buyer\nPersonal payment / Org wallet / Invoice"]
    S --> S1["Trial → conversion funnel\n3 allocation modes\nOrg program caps"]
    W --> W1["Capacity limited with waitlist\nCollaborator revenue splits\nRecording + certificates"]
    CL --> CL1["Multi-session curriculum\nTeaching assistants\nAsync content + live sessions"]
```

| Product | Who buys | Who delivers | Sessions | Key Mechanic |
|---|---|---|---|---|
| **Consultation** | Individual or Org | Solo expert | 1 | Approval gate + doc review |
| **Subscription** | Individual or Org | Solo expert | 4–32 over weeks | 3 allocation modes + trial funnel |
| **Webinar** | Many individuals or Org | Expert + co-hosts | 1 | Capacity + waitlist queue |
| **Class** | Many individuals or Org | Expert + TAs | 6–20 | Curriculum + collaborator splits |

---

## 2. The Cast of Characters

```mermaid
flowchart LR
    subgraph Supply["Supply Side"]
        Solo["Solo Consultant\nOwns plans, manages calendar"]
        Collab["Collaborating Consultant\nCo-host / TA / Guest Speaker\nEarns revenue share %"]
    end

    subgraph Demand["Demand Side"]
        Ind["Individual Learner\nPersonal card, no org"]
        OrgMember["Org-Sponsored Learner\nLEARNER role, budget from org program"]
        OrgAdmin["Org Admin\nOWNER / MAINTAINER / MANAGER\nManages budget + programs"]
    end

    subgraph Platform["Platform Roles"]
        Staff["Staff\nModeration + verification"]
        Admin["Admin\nFull platform control"]
        OrgOp["OrgWorkspaceProfile\nEnterprise operator"]
    end

    Ind -->|books| Solo
    OrgMember -->|books via org budget| Solo
    OrgAdmin -->|manages| OrgMember
    Collab -->|co-hosts with| Solo
```

---

## 3. Consultant Setup Flow (Supply Side)

```mermaid
flowchart TD
    Signup([Consultant signs up]) --> Wizard["Onboarding wizard\n/form/onboarding/"]
    Wizard --> Profile["Create ConsultantProfile\nname, bio, domain, education, socials"]
    Profile --> Verify["Upload verification docs\nresume, certifications"]
    Verify --> StaffReview{Staff reviews}
    StaffReview -- Approved --> Verified["✅ VERIFIED\nVisible in /explore/experts"]
    StaffReview -- Rejected --> NeedsInfo["NEEDS_INFO\nResubmit docs"]
    StaffReview -- Rejected hard --> Rejected(["❌ REJECTED"])

    Verified --> Plans["Create service plans\n/dashboard/consultant/planner/services/"]
    Plans --> ConsultPlan["ConsultationPlan\ntitle, price, duration, topics"]
    Plans --> SubPlan["SubscriptionPlan\nsessionsPerWeek, durationInMonths\ntrial toggle + price"]
    Plans --> WebinarPlan["WebinarPlan\nmaxParticipants, recording policy\ncertificate toggle"]
    Plans --> ClassPlan["ClassPlan\ncurriculum, number of sessions"]

    Plans --> Availability["Set availability\n/dashboard/consultant/settings/schedule/"]
    Availability --> Weekly["Weekly slots\ne.g. Every Mon 6–9pm IST\nstored as UTC minutes since midnight"]
    Availability --> Custom["Custom slots\none-off dates"]

    Plans --> ApprovalMode["Configure approval mode per plan"]
    ApprovalMode --> Direct["Direct booking\nlearner pays → confirmed instantly"]
    ApprovalMode --> NeedsApproval["Requires approval\nlearner requests → consultant approves → payment"]

    Plans --> CollabInvite["Invite collaborators (webinar/class only)\nset role + revenue share %"]
    CollabInvite --> CollabAccepts["Collaborator ACCEPTED\nearnings split at payout"]
```

---

## 4. The Booking State Machine

Every booking — regardless of service type — moves through this state machine.

```mermaid
stateDiagram-v2
    [*] --> PENDING : Request submitted or direct checkout

    PENDING --> APPROVED_PENDING_PAYMENT : Consultant approves
    PENDING --> REJECTED : Consultant declines
    PENDING --> EXPIRED : 30 days no action
    PENDING --> CANCELLED : Either party cancels

    APPROVED_PENDING_PAYMENT --> APPROVED : Payment webhook confirmed
    APPROVED_PENDING_PAYMENT --> EXPIRED : 7 days no payment
    APPROVED_PENDING_PAYMENT --> CANCELLED : Either party cancels

    APPROVED --> SCHEDULED : Slots allocated (subscriptions only)
    APPROVED --> COMPLETED : Auto-complete cron, 1hr after session
    SCHEDULED --> COMPLETED : Auto-complete cron

    APPROVED --> CANCELLED
    SCHEDULED --> CANCELLED

    COMPLETED --> [*]
    REJECTED --> [*]
    EXPIRED --> [*]
    CANCELLED --> [*]
```

Slot state runs in parallel:

```mermaid
stateDiagram-v2
    [*] --> Tentative : Created at checkout
    Tentative --> Confirmed : Payment webhook, isTentative set false
    Tentative --> Deleted : Cleanup cron, 7 days abandoned
    Confirmed --> COMPLETED
    Confirmed --> CANCELLED
    Confirmed --> RESCHEDULED
```

---

## 5. The Checkout Algorithm (500ms)

What actually happens when a consultee clicks "Pay Now":

```mermaid
sequenceDiagram
    participant C as Consultee
    participant FE as Frontend
    participant API as Checkout API
    participant Redis as Redis Lock
    participant DB as Database (Supabase)
    participant GW as Payment Gateway
    participant WH as Webhook Handler

    C->>FE: Click "Book Now"
    FE->>API: POST /api/checkout
    API->>API: Zod validation

    API->>Redis: Acquire distributed lock on slot
    alt Lock fails
        Redis-->>API: 409 Conflict
        API-->>FE: Try again
    end
    Redis-->>API: Lock acquired

    API->>DB: Re-validate inside lock (TOCTOU)
    Note over DB: Is slot still free?<br/>Is capacity available?<br/>No scheduling conflicts?

    API->>GW: Create payment intent (30-min TTL)
    GW-->>API: paymentIntentId + clientSecret

    API->>DB: SERIALIZABLE transaction
    Note over DB: Create Consultation/Subscription/Webinar/Class (PENDING)<br/>Create Appointment<br/>Create SlotOfAppointment (isTentative=true)<br/>Create Payment (PENDING) + PaymentLeg(s)

    API->>Redis: Release lock
    API-->>FE: paymentIntentId + clientSecret

    FE->>C: Render payment widget (Razorpay popup / Stripe Elements)
    C->>GW: Complete payment

    GW->>WH: Webhook: payment.succeeded
    WH->>WH: Idempotency check (WebhookEvent table)

    WH->>DB: Phase 1 — SERIALIZABLE transaction
    Note over DB: Payment.status → SUCCEEDED<br/>SlotOfAppointment.isTentative → false<br/>Event.status → APPROVED

    WH->>DB: Phase 2 — fire-and-forget
    Note over DB: Create ConsultantEarnings (80%)<br/>Create Invoice<br/>Trigger Novu notifications<br/>Create ActivityLog entry

    WH-->>C: Confirmation email + in-app notification
```

---

## 6. Slot Availability & The 30-Minute Atom

```mermaid
flowchart TD
    ConsAvail["Consultant sets availability\ne.g. Mon 6–9pm IST"] --> UTCStore["Stored as UTC integers\ndayOfWeek = MONDAY\nstartTimeUtc = 750 mins\nendTimeUtc = 930 mins"]

    UTCStore --> SlotMath["SlotCalculationService\n30-minute atomic slots"]
    SlotMath --> Slots6["6 × 30-min slots per Monday\n(6–9pm = 3 hours)"]

    Slots6 --> DurationMap["Duration → slots consumed\n30 min = 1 slot\n60 min = 2 slots\n90 min = 3 slots"]

    DurationMap --> Conflict["validateNoConflicts()\nScans SlotOfAppointment where\nisTentative=false AND user includes consultantId"]
    Conflict --> Clean{No overlap?}
    Clean -- Yes --> Proceed["Slot available → proceed to checkout"]
    Clean -- No --> Block["409 Conflict → pick another time"]

    subgraph SubscriptionMath["Subscription slot math"]
        countWeeks["countWeeks(start, end)\nSunday–Saturday counting"]
        reqSlots["calculateRequiredSlots\nsessionsPerWeek × weeks"]
        slotsPerCall["getSlotsPerCall(durationMins)"]
    end
```

---

## 7. Consultation Journeys (All Variants)

```mermaid
flowchart TD
    Entry([Consultee finds consultant\n/explore/experts]) --> SelectPlan[Selects consultation plan]
    SelectPlan --> ApprovalCheck{Approval required?}

    ApprovalCheck -- No --> SlotPick[Picks slot from calendar]
    ApprovalCheck -- Yes --> RequestForm["Fills request form\nproposed time + description"]
    RequestForm --> PendingReq["POST /api/slots/request-for-approval\nConsultation PENDING"]
    PendingReq --> ConsReview{Consultant reviews}
    ConsReview -- Rejects --> Rejected(["❌ REJECTED"])
    ConsReview -- Approves --> PayLink["APPROVED_PENDING_PAYMENT\nPayment link sent to consultee"]
    PayLink --> TimedOut{Pays within 7 days?}
    TimedOut -- No --> Expired(["⏰ EXPIRED"])
    TimedOut -- Yes --> SlotPick

    SlotPick --> CheckoutFlow["Checkout: lock → validate → create tentative\nCreate payment intent"]

    subgraph PaymentSources["Payment source (pick one or combine)"]
        PersonalCard["💳 Personal card"]
        OrgWallet["🏢 Org wallet (pre-funded)"]
        OrgInvoice["📄 Org invoice (month-end)"]
        OrgLicense["🔑 Org license (flat annual)"]
        Credits["🎁 Referral credits + card"]
    end

    CheckoutFlow --> PaymentSources
    PaymentSources --> Gateway[Pay via Razorpay / Stripe]
    Gateway -- Fails --> Cleanup["PaymentIntentManager.cleanup()\ntentative slot deleted after 7d"]
    Gateway -- Succeeds --> Webhook["Webhook Phase 1: APPROVED\nslot confirmed"]
    Webhook --> DocCheck{Document review?}
    DocCheck -- Yes --> DocUpload["Consultee uploads resume/doc\nConsultant reviews async\nstatus: PENDING → APPROVED / NEEDS_REVISION"]
    DocCheck -- No --> Session
    DocUpload --> Session["🎥 Stream.io session"]
    Session --> AutoComplete["Cron: COMPLETED 1hr after session ends"]
    AutoComplete --> EarningsFlow["ConsultantEarnings created\nPayout scheduled (TDS deducted)"]
```

---

## 8. Subscription Journeys — Trial, Allocation, Org Cap

```mermaid
flowchart TD
    SubEntry([Consultee views SubscriptionPlan]) --> TrialCheck{Trial offered?}

    TrialCheck -- Yes, wants trial --> TrialReq["POST /api/trials\nTrialSession PENDING"]
    TrialReq --> ConsApproves{Consultant approves?}
    ConsApproves -- No --> TrialRejected(["❌ Trial REJECTED"])
    ConsApproves -- Yes --> TrialSession["Free 30/60 min session\nStream.io"]
    TrialSession --> TrialCron["Cron: Trial COMPLETED 1hr after session"]
    TrialCron --> Converts{Converts to paid?}
    Converts -- No --> Dropout(["📉 Dropout tracked in analytics"])
    Converts -- Yes --> DirectSub
    TrialCheck -- No --> DirectSub

    DirectSub["Pays upfront e.g. ₹10,000\nChooses scheduling period"] --> PayConfirm["Webhook confirms payment"]
    PayConfirm --> AllocMode{Allocation mode?}

    AllocMode -- Auto --> AutoAlloc["Consultant clicks auto-allocate\nRedis lock acquired\nSystem scores + picks best N slots\nsessionsPerWeek × weeks in period"]
    AllocMode -- Manual --> ManualAlloc["Consultant hand-picks slot IDs\nPATCH /api/events/subscriptions/{id}/allocate"]
    AllocMode -- Requested --> ReqSlots["Consultee proposed times at checkout\nConsultant approves\nuseRequestedSlots()"]

    AutoAlloc --> SlotsCreated["N Appointments created\nCalendar populated for both parties"]
    ManualAlloc --> SlotsCreated
    ReqSlots --> SlotsCreated

    SlotsCreated --> OrgCapCheck{Org program cap?}
    OrgCapCheck -- No cap --> Sessions
    OrgCapCheck -- Under cap --> Sessions["Weekly sessions over program period"]
    OrgCapCheck -- Over cap --> OverageBehavior{overage behavior}
    OverageBehavior -- BLOCK --> Blocked(["🚫 Booking blocked"])
    OverageBehavior -- CHARGE_MEMBER --> MemberPays["Member's personal card charged\nfor overage sessions"]
    OverageBehavior -- CHARGE_ORG --> OrgCharged["Accrued to org overage invoice"]
    MemberPays --> Sessions
    OrgCharged --> Sessions

    Sessions --> AllComplete["All sessions COMPLETED\nCertificate issued if enabled"]
    Converts -- Yes --> ConvertMark["Trial marked CONVERTED\nlinked via convertedToSubscriptionId"]
    ConvertMark --> DirectSub
```

---

## 9. Waitlist Flow (Webinar & Class)

```mermaid
stateDiagram-v2
    [*] --> WAITING : Joins waitlist (POST /api/waitlist)

    WAITING --> NOTIFIED : Spot opens, 48h window starts
    WAITING --> CANCELLED : User leaves queue

    NOTIFIED --> BOOKED : Pays within 48h
    NOTIFIED --> EXPIRED : 48h passes, no response
    NOTIFIED --> SKIPPED : User declines spot

    EXPIRED --> WAITING : Re-queued, next notified
    SKIPPED --> WAITING : Re-queued, next notified

    BOOKED --> [*]
    CANCELLED --> [*]
```

```mermaid
flowchart TD
    WebinarFull["Webinar / Class at capacity\ncurrentParticipants >= maxParticipants"] --> WaitlistOpt{Join waitlist?}
    WaitlistOpt -- Yes --> Queue["WAITING\nQueue position: count ahead by priority + time"]
    WaitlistOpt -- No --> Exit(["Exit"])

    Queue --> SpotOpens["Another registrant cancels\nhandleSlotOpening() triggers"]
    SpotOpens --> NotifyFirst["First in queue: WAITING → NOTIFIED\nEmail: spot available, 48h to respond"]
    NotifyFirst --> Respond{Responds within 48h?}
    Respond -- Yes, pays --> Booked["BOOKED\nSlot confirmed, position rebalanced"]
    Respond -- No --> ExpiredEntry["EXPIRED\nCron removes, next in queue NOTIFIED"]
    Respond -- Declines --> Skipped["SKIPPED\nRe-queued at back"]
```

---

## 10. Webinar & Class Group Session Flow

```mermaid
flowchart TD
    Browse([Browse /explore/programs]) --> EventPage["View webinar or class detail\nseats remaining, schedule, price"]

    EventPage --> CapCheck{Seats available?}
    CapCheck -- Yes --> Enroll["Register / Enroll\n/checkout/plans/webinar/{planId}"]
    CapCheck -- No --> WaitlistFlow["→ Waitlist flow (see above)"]

    Enroll --> Checkout["Checkout: Redis lock → re-check capacity\nCreate Webinar + Appointment (shared) + SlotOfAppointment + Payment"]
    Checkout --> Pay["Pay via gateway"]
    Pay --> Webhook["Webhook: isTentative → false\nparticipant count++"]

    Webhook --> AllPartners["All N registrants share\nONE Appointment row\nONE SlotOfAppointment\n(many-to-one, not N separate bookings)"]
    AllPartners --> Reminders["Reminders: 24h before + 1h before"]
    Reminders --> JoinNow["'Join Now' active 5 min before\nStream.io group room"]

    JoinNow --> CollabCheck{Collaborators?}
    CollabCheck -- Yes --> CollabRoom["Co-host / TA in room\nRevenue split on each payment\nOwner: e.g. 80%, Guest: 20%"]
    CollabCheck -- No --> SoloRoom["Solo consultant hosts"]
    CollabRoom --> Session["Group session runs"]
    SoloRoom --> Session

    Session --> RecordingPolicy{Recording policy?}
    RecordingPolicy -- STREAM_S3 --> TempRecording["Stream S3\n2-week retention, then expired"]
    RecordingPolicy -- SUPABASE_PERMANENT --> PermRecording["Supabase storage\nPermanent, participant access"]
    TempRecording --> PostSession
    PermRecording --> PostSession

    PostSession["Post-session"] --> CertCheck{Certificate enabled?}
    CertCheck -- Yes --> Cert["Certificate auto-issued"]
    CertCheck -- No --> Review["Prompt: leave a review"]
    Cert --> Review
```

---

## 11. Trial Session Lifecycle

```mermaid
stateDiagram-v2
    [*] --> PENDING : Consultee requests trial (POST /api/trials)

    PENDING --> SCHEDULED : Consultant approves, slot created
    PENDING --> REJECTED : Consultant declines
    PENDING --> CANCELLED : Either party cancels

    SCHEDULED --> COMPLETED : Cron 1hr after session ends

    COMPLETED --> CONVERTED : Consultee buys subscription from same consultant

    CONVERTED --> [*]
    COMPLETED --> [*]
    REJECTED --> [*]
    CANCELLED --> [*]
```

---

## 12. Enterprise Organization Types

```mermaid
flowchart TD
    Org["Organization"] --> SponsorQ{canSponsor?}
    Org --> HostQ{canHost?}

    SponsorQ -- Yes + canHost No --> Sponsor["SPONSOR\ne.g. Wipro, IIT Madras\nPays for employee sessions"]
    HostQ -- Yes + canSponsor No --> Host["HOST (canHost)\ne.g. LearnPro — behind ENABLE_HOST_ORGS\nHosts consultants, earns revenue share"]
    SponsorQ & HostQ -- Both Yes --> Hybrid["HYBRID\nLarge corp with internal training\nBoth pays AND earns"]

    Sponsor --> FundingSource["FundingSource"]
    FundingSource --> WALLET["WALLET\nPre-funded credit pool\ne.g. ₹5L top-up\nDebit per booking\n(auto-top-up below minBalancePaise)"]
    FundingSource --> INVOICE["INVOICE\nAccrual at booking\nMonth-end roll-up\nGST-compliant e-invoice"]
    FundingSource --> LICENSE["LICENSE\nFlat annual fee\ne.g. ₹2L per 100 seats\nUnlimited sessions"]

    Host --> RateCard["RateCard (basis points)\nplatformBps + orgBps + consultantBps = 10000"]
    RateCard --> Example["Example: 10% platform\n15% org\n75% consultant"]
    Example --> OrgEarnings["OrganizationEarnings\nWeekly batch payout to org bank"]

    Hybrid --> Both["Both funding AND hosting\napply simultaneously"]
```

---

## 13. Enterprise Program & Budget Cap Flow

```mermaid
flowchart TD
    Contract["Contract\nDRAFT → ACTIVE\ncommercial agreement"] --> Programs["Programs under contract"]
    Programs --> LSeat["LICENSED_SEAT\ne.g. 4 sessions per learner per quarter"]
    Programs --> CPool["CREDIT_POOL\ne.g. ₹5L shared, resets quarterly"]

    LSeat --> Assign["Member assigned to program\nProgramAssignment ACTIVE\nengagementsUsed = 0 (LICENSED_SEAT)\nconsumedPaise = 0 (CREDIT_POOL)\nfirst assignment ⇒ Program.configLockedAt stamped"]
    CPool --> Assign

    Assign --> MemberBooks["Member starts checkout"]
    MemberBooks --> Preview["Pre-checkout overage preview\nresolveOverageDecision(): would this booking exceed the cap?"]
    Preview --> CapCheck{"Under cap?\nengagementsUsed < coveredEngagementsPerCycle\nor consumedPaise < creditsPerCycle×100"}

    CapCheck -- Yes --> Allowed["Booking proceeds\nBookingUtilization row created\nengagementsUsed++ / consumedPaise+="]
    CapCheck -- No --> Breaker{"Circuit breaker\nmaxOveragePerCyclePaise hit?"}
    Breaker -- "Yes (cumulative cap blown)" --> Blocked
    Breaker -- No --> OverageBehavior{overage behavior}

    OverageBehavior -- BLOCK --> Blocked(["🚫 Booking rejected\nMember shown budget exhausted"])
    OverageBehavior -- CHARGE_MEMBER --> MemberCard["OverageEvent PENDING\nMember's personal card charged\n(marginal = basePaise + surchargePaise)\nsweep cron times out abandoned charges → FAILED"]
    OverageBehavior -- CHARGE_ORG --> OrgOverage["OverageEvent ACCRUED\nbasePaise + overageSurchargeBps markup\nrolled into org invoice line item"]

    Allowed --> Settlement["Settlement at period end"]
    MemberCard --> Settlement
    OrgOverage --> Settlement

    Settlement --> WalletSettle["WALLET: debit from BillingAccount"]
    Settlement --> InvoiceSettle["INVOICE: OrganizationInvoice\nDRAFT → ISSUED (with IRN) → PAID"]
    Settlement --> LicenseSettle["LICENSE: no per-booking charge\nflat annual only"]

    InvoiceSettle --> GST["GST applied\nCGST + SGST (same state)\nor IGST (interstate)"]
    GST --> MSME["MSME payment deadline\n15 days (MICRO) or 45 days (SMALL/MEDIUM)"]

    Settlement --> CycleEnd{"Cycle period ended?\n(advance-program-cycles cron)"}
    CycleEnd -- "Contract ACTIVE + autoRenew" --> Roll["ROLL: mint successor ACTIVE assignment\nold row → ROLLED, rolledToAssignmentId set\ncap resets for the new period"]
    CycleEnd -- "autoRenew off / contract inactive / clamped past effectiveTo" --> Close["CLOSE: assignment → CLOSED\nno successor (coverage lapses)"]
```

> **v2 (#777/#779).** Caps now reset automatically: the `advance-program-cycles`
> cron rolls each `ProgramAssignment` into a fresh successor (`ROLLED` → new
> `ACTIVE`) when the governing contract is `ACTIVE` + `autoRenew`, else `CLOSED`
> (`lib/enterprise/cycle-engine.ts`). Overage is split into `basePaise` +
> `surchargePaise` (`overageSurchargeBps`) and capped by a per-cycle circuit
> breaker (`maxOveragePerCyclePaise`) that forces `BLOCK` once cumulative overage
> is exceeded. Money config locks (`Program.configLockedAt`) the moment the first
> assignment exists.

---

## 14. Revenue & Earnings Split

```mermaid
flowchart TD
    Payment["Payment SUCCEEDED\ne.g. ₹10,000 gross"] --> PlatformCut["Platform commission: 20%\n₹2,000"]
    Payment --> ConsultantGross["Consultant share: 80%\n₹8,000"]

    ConsultantGross --> CollabCheck{Collaborators on this event?}
    CollabCheck -- No --> OwnerFull["Owner earns 100% of consultant share\nConsultantEarnings: role=OWNER\n₹8,000"]
    CollabCheck -- Yes --> SplitByShare["Split by sharePercentage\ne.g. Guest Speaker = 20%"]
    SplitByShare --> Owner["Owner: 80% of consultant share\nConsultantEarnings: role=OWNER, ₹6,400"]
    SplitByShare --> Collaborator["Collaborator: 20% of consultant share\nConsultantEarnings: role=COLLABORATOR, ₹1,600"]

    Owner --> HoldPeriod["Earnings HELD\nduring dispute window"]
    Collaborator --> HoldPeriod
    OwnerFull --> HoldPeriod

    HoldPeriod --> Ready["Earnings READY for payout"]
    Ready --> TDS["TDS deducted — Section 194J\nPAN verified, GSTIN checked"]
    TDS --> Payout["Payout batch\nRazorpay or Stripe\nto PayoutAccount (bank / UPI)"]
    Payout --> Paid["Status: PAID\nSettlementLedgerEntry created"]

    OrgHostCheck{Org-hosted consultant?} -- Yes --> OrgEarnings["OrganizationEarnings row\nWeekly batch OrganizationPayout\nto org bank account"]
```

---

## 15. Full End-to-End User Journey

```mermaid
flowchart TD
    Entry([User enters Familiarise]) --> RoleCheck{Who are you?}

    RoleCheck -- Individual learner --> Explore["/explore/experts\nor /explore/programs"]
    RoleCheck -- Org-sponsored learner --> OrgCatalog["Org-curated service catalog\n(OrgPlanVisibility: ORG_ONLY)"]
    RoleCheck -- Consultant --> OnboardWizard["Onboarding wizard\n→ create plans → set availability"]

    Explore --> SearchFilter["Search by domain, price, rating, language\nFilter by service type"]
    OrgCatalog --> SearchFilter
    SearchFilter --> Profile["Consultant profile page\n/explore/experts/{consultantId}"]

    Profile --> ServiceChoice{Which service format?}
    ServiceChoice -- Quick help --> C["Consultation\n30–90 min · 1 session"]
    ServiceChoice -- Deep program --> S["Subscription\n4–32 sessions · weeks long"]
    ServiceChoice -- Live event --> W["Webinar\nGroup · fixed time"]
    ServiceChoice -- Structured course --> CL["Class\nGroup · multi-week"]

    C --> ApprovalGate{Approval required?}
    ApprovalGate -- No --> Pay
    ApprovalGate -- Yes --> RequestApproval["Submit request\nConsultant approves → payment link"]
    RequestApproval --> Pay

    S --> TrialGate{Trial available?}
    TrialGate -- Yes, want trial --> FreeTrial["Free session → COMPLETED"]
    FreeTrial --> Liked{Liked it?}
    Liked -- Yes --> Pay
    Liked -- No --> Exit(["Exit"])
    TrialGate -- No --> Pay

    W --> CapGate{Spots available?}
    CL --> CapGate
    CapGate -- Yes --> Pay
    CapGate -- No --> Waitlist["Join waitlist\n→ notified when spot opens\n48h window"]
    Waitlist --> Pay

    Pay["Complete payment\n💳 Card / 🏢 Org wallet / 📄 Invoice / 🔑 License / 🎁 Credits"] --> Session["🎥 Live session on Stream.io"]
    Session --> PostSession["Recording + materials\nCertificate if enabled"]
    PostSession --> Review["⭐ Leave review"]
    Review --> Repeat{Book again?}
    Repeat -- Yes --> Profile
    Repeat -- No --> Done(["Done"])
```

---

## 16. Background Automation (No Human Needed)

```mermaid
flowchart LR
    subgraph Hourly["⏰ Hourly"]
        AC["auto-complete-appointments\nCompletes sessions 1hr after end time"]
        PWE["process-waitlist-expirations\nNOTIFIED → EXPIRED\nnext in queue notified"]
    end

    subgraph Every2h["⏰ Every 2 hours"]
        CTS["cleanup-tentative-slots\nDeletes abandoned tentative slots\n7+ days old"]
    end

    subgraph Daily["📅 Daily"]
        ESR["expire-stale-requests\nPENDING → EXPIRED after 30 days\nAPPROVED_PENDING_PAYMENT → EXPIRED after 7 days"]
    end

    subgraph Scheduled["📬 Scheduled"]
        AR["appointment-reminders\n24h + 1h before session"]
    end

    subgraph Periodic["🔄 Periodic"]
        SPE["sync-payment-earnings\nSafety net: creates missing earnings rows"]
    end

    subgraph MonthEnd["📊 Month-end"]
        GOI["generate-org-invoices\nRolls up INVOICE_ACCRUAL payments\nto OrganizationInvoice with GST"]
    end

    subgraph Nightly["🌙 Nightly"]
        DBA["data-breach-alert\n72h DPDP Act compliance check"]
        GDC["gst-drift-check (FF-6)\nDetects GST calculation drift"]
    end
```

---

## 17. The Permutation Matrix

Every journey is a combination of these axes:

| Axis | Options |
|---|---|
| **Service type** | Consultation · Subscription · Webinar · Class |
| **Approval mode** | Direct · Requires approval |
| **Allocation mode** (subscription only) | Auto · Manual · Requested slots |
| **Trial** (subscription only) | None · Trial no-convert · Trial converts |
| **Payment source** | Personal card · Org wallet · Org invoice · Org license · Credits+card · Wallet+card |
| **Capacity** | Available · Waitlist→enrolls · Waitlist→expires |
| **Collaboration** | Solo consultant · With co-host/TA (revenue split) |
| **Document review** | None · Consultee uploads · Consultant responds |
| **Recording** | None · Stream 2-week · Supabase permanent |
| **Org program cap** | None · Under cap · Overage BLOCK · Overage CHARGE\_MEMBER · Overage CHARGE\_ORG |

**~3,000+ distinct end-to-end paths.** ~15–20 primary journeys cover 90% of real usage. The rest are edge cases handled automatically by the state machine + cron jobs.

---

## 18. Competitive Moat (Why This Is Hard to Copy)

```mermaid
flowchart TD
    Competitor["Competitor starting today"] --> B1["Booking state machine\n8 states, 4 service types"]
    Competitor --> B2["Two-phase commit checkout\nRedis distributed locks\nTOCTOU race condition guards"]
    Competitor --> B3["3-mode slot allocation\nauto scoring algorithm\nconcurrency guards"]
    Competitor --> B4["Priority waitlist queue\n48h expiry + re-queue logic"]
    Competitor --> B5["Multi-leg payments\ncard + wallet + credits + org invoice\n4 gateways"]
    Competitor --> B6["India compliance\nGST CGST/SGST/IGST\nTDS 194J withholding\ne-invoice IRN\nMSME 15/45-day rules"]
    Competitor --> B7["Enterprise billing stack\nContract → Program → ProgramAssignment\n3 overage behaviors\nimmutable 3-ledger accounting"]
    Competitor --> B8["Trial-to-conversion funnel\nunique constraint per consultee+consultant pair\nauto-conversion detection at checkout"]

    B1 & B2 & B3 & B4 & B5 & B6 & B7 & B8 --> Timeline["2–3 years to rebuild\nwith India compliance expertise"]
    Timeline --> Moat["By then: verified expert roster\n+ learner trust\n= real switching costs"]
```

---

## Key Files Reference

| Area | Path |
|---|---|
| Schema | `prisma/schema.prisma` |
| Booking architecture | `docs/booking/01-architecture.md` |
| Booking lifecycle | `docs/booking/06-booking-lifecycle.md` |
| Slot math | `docs/booking/03-slot-math-and-calculations.md` |
| Trial sessions | `docs/booking/09-trial-sessions.md` |
| Waitlist system | `docs/booking/11-waitlist-system.md` |
| Checkout + payment | `docs/booking/10-checkout-payment-integration.md` |
| Enterprise overview | `docs/enterprise/00-foundations/01-overview.md` |
| Enterprise scenarios | `docs/enterprise/60-scenarios-and-verdicts/01-scenarios-and-examples.md` |
| Funding & programs | `docs/enterprise/00-foundations/03-funding-and-programs.md` |
| Enterprise readiness | `docs/enterprise/90-audits/01-readiness-audit.md` |
| Slot allocation engine | `utils/slotAllocation/SlotAllocationService.ts` |
| Checkout orchestration | `lib/payments/operations/checkout.ts` |
| Webhook handlers | `lib/payments/webhooks/handlers.ts` |
| Explore pages | `app/explore/` |
| Checkout pages | `app/checkout/plans/` |
| Consultant dashboard | `app/dashboard/consultant/[consultantId]/` |
| Org dashboard | `app/dashboard/organization/` |
