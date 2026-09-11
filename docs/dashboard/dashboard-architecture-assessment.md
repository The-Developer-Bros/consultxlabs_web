> **⚠️ SUPERSEDED on 2026-04-08.** PR #647 (feature/cleanup) addressed the bulk of this doc's admin/staff findings: the sidebar is unified via `CollapsibleSidebar`, System Jobs + Maintenance are removed from the staff dashboard, ~46 admin/staff API routes use shared `requirePrivilegedAuth` helpers, 5 route pairs use shared `lib/api/operators/*` utilities, and 5–7 dashboard page pairs use shared `components/dashboard/shared/*Page.tsx` components. The enterprise dashboard design section is being rewritten in PR2 as `docs/enterprise/00-canonical-design.md`. Retained for historical context — the admin/staff overlap audit that informed PR #647 is still readable here.

# Dashboard Architecture Assessment & Enterprise Dashboard Design

> Perspective: Senior Product Manager + Senior UI/UX Designer
> Date: 2026-03-23
> Scope: Admin, Staff, Consultant, Consultee dashboards + Enterprise dashboard design

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current Dashboard Landscape](#2-current-dashboard-landscape)
3. [Admin Dashboard Audit](#3-admin-dashboard-audit)
4. [Staff Dashboard Audit](#4-staff-dashboard-audit)
5. [Admin vs Staff Overlap Analysis](#5-admin-vs-staff-overlap-analysis)
6. [Consultant & Consultee Dashboard Notes](#6-consultant--consultee-dashboard-notes)
7. [Improvement Recommendations (Non-Enterprise)](#7-improvement-recommendations-non-enterprise)
8. [The Enterprise Dashboard Question: Separate vs Upgrade?](#8-the-enterprise-dashboard-question-separate-vs-upgrade)
9. [Enterprise Organization Dashboard Design](#9-enterprise-organization-dashboard-design)
10. [Unified Dashboard Architecture Vision](#10-unified-dashboard-architecture-vision)

---

## 1. Executive Summary

After a thorough code-level audit of all four dashboards, here are the five most critical findings:

1. **Admin and Staff dashboards are ~75% duplicated.** 13 out of 18 staff pages are clones of admin pages (tickets, feedback, users, payments, refunds, disputes, subscriptions, invoices, payouts, waitlists, announcements, system-jobs, maintenance). This is a maintenance nightmare — bug fixes need to happen in two places.

2. **Staff uses a completely different sidebar component** than admin and consultant. Admin/consultant use the shared `DashboardSidebar` with sectioned navigation. Staff has a custom collapsible sidebar with flat navigation and tooltips. This creates inconsistent UX and duplicated component logic.

3. **Staff has access to system-level operations it shouldn't.** System Jobs (manual cron triggers) and Maintenance Mode controls are admin-only operations currently exposed to all staff members. The `AdminLevel` enum (SUPER_ADMIN, ADMIN, MODERATOR) exists in the schema but is completely unused in the UI.

4. **Analytics is effectively non-existent.** Admin analytics is just 4 stat cards with counts. Staff "Metrics" is the same. Consultant analytics is a "Coming Soon" placeholder. No charting library, no time-series data, no trends, no comparisons. For a SaaS platform, this is a critical gap.

5. **Enterprise needs a NEW dashboard (Option C: Hybrid), not a retrofitted consultant dashboard.** The org admin's job (manage team, control billing, track progress) is fundamentally different from a consultant's job (teach, schedule, earn). Forcing these into one interface will compromise both.

---

## 2. Current Dashboard Landscape

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        /dashboard (root)                            │
│                    Role-based router/redirect                       │
├──────────────┬──────────────┬────────────────┬─────────────────────┤
│              │              │                │                     │
▼              ▼              ▼                ▼                     │
┌──────────┐ ┌──────────┐ ┌──────────────┐ ┌──────────────┐        │
│  ADMIN   │ │  STAFF   │ │  CONSULTANT  │ │  CONSULTEE   │        │
│          │ │          │ │              │ │              │        │
│ Sectioned│ │ CUSTOM   │ │ Sectioned    │ │ TOP NAV      │        │
│ Sidebar  │ │ Flat     │ │ Sidebar      │ │ (no sidebar) │        │
│ (shared) │ │ Sidebar  │ │ (shared)     │ │              │        │
│          │ │ +collapse│ │ +Stream.io   │ │              │        │
│ 16 pages │ │ 18 pages │ │ 14 pages     │ │ 8 pages      │        │
│          │ │          │ │ +verification│ │              │        │
└──────────┘ └──────────┘ └──────────────┘ └──────────────┘        │
│                                                                     │
│  MISSING: Organization/Enterprise Dashboard                         │
└─────────────────────────────────────────────────────────────────────┘
```

### Navigation Pattern Comparison

```
ADMIN (DashboardSidebar - shared)       STAFF (Custom sidebar)
┌─────────────────────────┐             ┌─────────────────────────┐
│ ◉ Overview              │             │ ◉ Home                  │
│ ◉ Announcements         │             │ ◉ Announcements         │
│ ── Support ──────────── │             │ ◉ Support Tickets       │
│   ◉ Support Tickets     │             │ ◉ User Feedback         │
│   ◉ User Feedback       │             │ ◉ Users                 │
│ ── Payments ─────────── │             │ ◉ Content Moderation  ← UNIQUE
│   ◉ All Payments        │             │ ◉ Appointments        ← UNIQUE
│   ◉ Approval Payments   │             │ ◉ Waitlists             │
│   ◉ Subscriptions       │             │ ◉ Payments              │
│   ◉ Refunds             │             │ ◉ Payouts               │
│   ◉ Disputes            │             │ ◉ Invoices              │
│ ── Payouts ──────────── │             │ ◉ Refunds               │
│   ◉ Pending Approval    │             │ ◉ Disputes              │
│   ◉ Processing          │             │ ◉ Subscriptions         │
│   ◉ Completed           │             │ ◉ Metrics               │
│   ◉ Consultant Earnings │             │ ◉ System Jobs         ← SHOULDN'T BE HERE
│ ◉ Invoices              │             │ ◉ Maintenance         ← SHOULDN'T BE HERE
│ ◉ Analytics             │             │ ◉ Settings              │
│ ◉ Users                 │             └─────────────────────────┘
│ ◉ Waitlists             │
│ ── System ───────────── │
│   ◉ System Jobs         │
│   ◉ Maintenance         │
└─────────────────────────┘

CONSULTANT (DashboardSidebar - shared)  CONSULTEE (Top nav - different)
┌─────────────────────────┐             ┌──────────────────────────────────────────┐
│ ◉ Home                  │             │ Home │ Appts │ Waitlists │ Resources │  │
│ ◉ Chats                 │             │ Messages │ Payments │ Referrals │ Support│
│ ◉ Appointments          │             └──────────────────────────────────────────┘
│ ── Services ─────────── │
│   ◉ Event Planner       │
│   ◉ Requests            │
│   ◉ Collaborations      │
│   ◉ Trials         │
│ ── Content ──────────── │
│   ◉ Recordings          │
│   ◉ Documents           │
│ ── Finance ──────────── │
│   ◉ Earnings            │
│   ◉ Referrals           │
└─────────────────────────┘
```

### Technology Stack (Dashboard-Specific)

| Technology | Usage | Status |
|-----------|-------|--------|
| React Query (TanStack) | Data fetching, caching, pagination | Solid |
| DashboardShell | Mobile sidebar drawer + desktop fixed layout | Shared (admin, consultant) |
| DashboardSidebar | Sectioned nav with role-based colors, 40+ icons | Shared (admin, consultant) |
| DashboardNavbar | Top bar with notifications + user dropdown | Shared |
| StatCard | 5 variants, trend indicators | Used everywhere |
| Framer Motion | Page transitions, skeleton loading | Used everywhere |
| Stream.io | Video + Chat | Consultant only |
| Novu | Notifications | All dashboards |
| Charts/Visualization | **NONE** | Critical gap |

---

## 3. Admin Dashboard Audit

### 3.1 Navigation Structure

**File**: `app/dashboard/admin/layout.tsx`

```
NAV_SECTIONS (8 sections, 16 pages):

[unnamed]     → Overview (home)
[unnamed]     → Announcements
"Support"     → Support Tickets, User Feedback
"Payments"    → All Payments, Approval Payments, Subscriptions, Refunds, Disputes
"Payouts"     → Pending Approval, Processing, Completed, Consultant Earnings
[unnamed]     → Invoices, Analytics, Users    ← PROBLEM: 3 unrelated pages dumped together
[unnamed]     → Waitlists                      ← PROBLEM: alone in its own section
"System"      → System Jobs, Maintenance
```

### 3.2 Feature Inventory

| Page | Implementation Status | Quality | Notes |
|------|----------------------|---------|-------|
| Home/Overview | Fully implemented | Good | Real-time stats, gateway status, recent payments/refunds. 2-min auto-refetch. |
| Announcements | Fully implemented | Good | Uses shared `AnnouncementsPage` component. CRUD with active/inactive toggle. |
| Support Tickets | Fully implemented | Very Good | Full threading, status workflow, internal notes, linked entities. Best-implemented page. |
| User Feedback | Fully implemented | Good | Star ratings, status workflow, detail dialogs. |
| All Payments | Fully implemented | Good | Multi-filter, pagination (20/page), gateway/status/type filters. |
| Approval Payments | Fully implemented | Good | Pending payment approval workflow. |
| Subscriptions | Fully implemented | Adequate | Basic subscription management. |
| Refunds | Fully implemented | Good | Status tracking, gateway filter, linked to original payment. |
| Disputes | Fully implemented | Very Good | Urgency flags, deadline tracking, 3-day warning banner. Best financial page. |
| Payouts (4 sub-pages) | Fully implemented | Good | Multi-stage workflow (pending → processing → completed). Summary cards. |
| Invoices | Fully implemented | Adequate | Uses shared `InvoicesPage` component. PDF generation missing. |
| **Analytics** | **Implemented but shallow** | **Poor** | **Just 4 stat cards (users, sessions, revenue, domains). No charts, no trends, no time range picker, no comparisons. Unacceptable for an admin dashboard.** |
| Users | Fully implemented | Good | Two tabs (all + pending verification), search, filter by role, detail modal, dropdown actions. |
| Waitlists | Fully implemented | Adequate | Basic waitlist management. |
| System Jobs | Fully implemented | Adequate | Manual job trigger panel. |
| Maintenance | Fully implemented | Adequate | Toggle degraded/offline mode. |

### 3.3 UX Issues

| Issue | Severity | Description |
|-------|----------|-------------|
| **Unnamed nav sections** | Medium | Invoices, Analytics, and Users are in an unnamed section. The admin has to visually scan the entire sidebar to find them. They're semantically unrelated — Users belongs in a "People" section, Analytics should be prominent, Invoices belongs with Payments/Payouts. |
| **Waitlists orphaned** | Low | Waitlists sits alone in its own unnamed section. Should be grouped with "Events" or "Operations." |
| **Analytics is a dead end** | High | Admin analytics shows counts with no drill-down, no date range, no comparison to previous period. A stat that says "Total Revenue: ₹X" without context (up/down, this month vs last month, by service type) is almost useless. |
| **No quick actions from home** | Medium | Home page shows recent payments and refunds but no quick action buttons (e.g., "Approve pending payouts," "View urgent disputes"). Admin has to navigate to each section. |
| **Payouts split into 4 separate pages** | Medium | Pending, Processing, Completed, and Earnings are 4 separate nav items. This is overkill — a single Payouts page with tab/filter states would be cleaner and reduce sidebar clutter. |
| **No search across entities** | Medium | Admin can search within individual pages (users, tickets, payments) but there's no global search. If an admin gets a complaint mentioning a payment ID, they have to know to go to the Payments page first. |
| **No audit log** | Medium | No visibility into who did what. If a staff member approves a payout, there's no log. Critical for financial compliance. |
| **Missing: Content Moderation** | High | Staff has a Content Moderation page (reports, profile verification). Admin doesn't — even though admin should have ultimate oversight. |
| **Missing: Appointments view** | Medium | Staff can see all appointments. Admin can't. Admin should have at minimum an appointments overview (today's sessions, upcoming, completion rates). |

### 3.4 What Works Well

- **Support Tickets** is the best-implemented feature — threading, internal notes, linked entities, status workflow. This is the gold standard for what other pages should aspire to.
- **Disputes** with urgency flags and deadline tracking shows good domain understanding.
- **Role-based redirects** in the layout — unauthorized users get redirected to their appropriate dashboard, not just a 403.
- **2-minute auto-refetch** on the home page keeps data fresh without manual refresh.
- **Error boundary** wraps children, preventing one page crash from killing the entire dashboard.

---

## 4. Staff Dashboard Audit

### 4.1 Navigation Structure

**File**: `app/dashboard/staff/[staffId]/layout.tsx`

```
sidebarItems (17 flat items + Settings):

Home, Announcements, Support Tickets, User Feedback, Users,
Content Moderation, Appointments, Waitlists, Payments, Payouts,
Invoices, Refunds, Disputes, Subscriptions, Metrics,
System Jobs, Maintenance, Settings
```

### 4.2 Feature Inventory

| Page | Implementation Status | Quality | Notes |
|------|----------------------|---------|-------|
| Home | Fully implemented | Good | Stats grid (open tickets, users assisted, pending reviews, resolved today), recent tickets, announcements, quick actions. |
| Announcements | Fully implemented | Good | Same shared component as admin. |
| Support Tickets | Fully implemented | Good | Same implementation as admin. |
| User Feedback | Fully implemented | Good | Same implementation as admin. |
| Users | Fully implemented | Good | Same implementation as admin. |
| **Content Moderation** | **Fully implemented** | **Good** | **UNIQUE to staff. Two tabs: Content Reports + Profile Verifications. Status workflow, action buttons (approve/reject/request info). This should also be accessible from admin.** |
| **Appointments** | **Fully implemented** | **Good** | **UNIQUE to staff. Tab view by status, filters by type/status/date. Detail modal. Should also be accessible from admin.** |
| Waitlists | Fully implemented | Adequate | Same as admin. |
| Payments | Fully implemented | Good | Same as admin (but single page vs admin's split). |
| Payouts | Fully implemented | Good | Same as admin. |
| Invoices | Fully implemented | Adequate | Same as admin. |
| Refunds | Fully implemented | Good | Same as admin. |
| Disputes | Fully implemented | Good | Same as admin. |
| Subscriptions | Fully implemented | Adequate | Same as admin. |
| Metrics | Implemented but shallow | Poor | Same problem as admin analytics — just stat cards. |
| **System Jobs** | **Fully implemented** | **N/A** | **Should NOT be accessible to staff. This triggers background cron jobs and cleanup tasks. A staff member should never need this.** |
| **Maintenance** | **Fully implemented** | **N/A** | **Should NOT be accessible to staff. Toggling maintenance mode can take the entire platform offline. This is a super-admin operation.** |
| Settings | Fully implemented | Good | Profile, notification preferences, timezone. |

### 4.3 UX Issues

| Issue | Severity | Description |
|-------|----------|-------------|
| **Custom sidebar component** | High | Staff uses a completely custom sidebar (`layout.tsx` lines 48-67) instead of the shared `DashboardSidebar` component. Different behavior (collapsible with tooltips), different styling, different nav structure (flat vs sectioned). This means sidebar bug fixes or improvements must be done in two places. |
| **17 flat items = information overload** | High | 17 nav items without any grouping or sections. The admin dashboard groups them into sections (Support, Payments, Payouts, System). Staff dumps them all flat. A staff member has to scan 17 items to find what they need. |
| **System Jobs + Maintenance exposed** | Critical | These should be admin-only. A MODERATOR-level staff member should not be able to trigger system cleanup jobs or put the platform in maintenance mode. No `AdminLevel` gating exists. |
| **No role-based feature filtering** | High | A MODERATOR-level staff member sees the exact same 17 items as a SUPER_ADMIN. The `AdminLevel` enum (SUPER_ADMIN, ADMIN, MODERATOR) exists in the schema but is completely unused. |
| **Home page has hardcoded announcements** | Low | The staff home page has announcement data that appears to be hardcoded or partially static, not fully API-driven. |

### 4.4 What Works Well

- **Content Moderation** is well-designed — two-tab interface (reports + verifications), action buttons with confirmation, comment/note input.
- **Appointments view** provides useful operational oversight for staff managing day-to-day support.
- **Quick action buttons** on the home page (View Open Tickets, Search Users, Review Content) are good — this pattern should be adopted by admin.
- **Collapsible sidebar** is a good UX idea (saves space) — but should be implemented in the shared component, not custom.

---

## 5. Admin vs Staff Overlap Analysis

### 5.1 Duplication Matrix

```
                           ADMIN    STAFF    DUPLICATED?
                           ─────    ─────    ──────────
Home/Overview               ✓        ✓       Different (good — different focus)
Announcements               ✓        ✓       SAME shared component ✓
Support Tickets              ✓        ✓       DUPLICATED (same code, different routes)
User Feedback                ✓        ✓       DUPLICATED
Users                        ✓        ✓       DUPLICATED
Content Moderation           ✗        ✓       Admin MISSING — should have it
Appointments                 ✗        ✓       Admin MISSING — should have overview
Waitlists                    ✓        ✓       DUPLICATED
Payments (All)               ✓        ✓       DUPLICATED (admin has 5 sub-pages)
Approval Payments            ✓        ✗       Admin only (correct)
Subscriptions                ✓        ✓       DUPLICATED
Refunds                      ✓        ✓       DUPLICATED
Disputes                     ✓        ✓       DUPLICATED
Payouts                      ✓        ✓       DUPLICATED (admin has 4 sub-pages)
Invoices                     ✓        ✓       DUPLICATED
Analytics/Metrics            ✓        ✓       DUPLICATED (both are weak)
System Jobs                  ✓        ✓       Staff SHOULDN'T have this
Maintenance                  ✓        ✓       Staff SHOULDN'T have this
Settings                     ✗        ✓       Admin MISSING (has no settings page)
```

**Duplication count: 11 pages are duplicated code** (same component logic, different routes).

### 5.2 What Should Be Where?

| Feature | Who needs it? | Reasoning |
|---------|--------------|-----------|
| **Announcements** | Both | Both create/view platform announcements. Already using shared component correctly. |
| **Support Tickets** | Both (staff as primary, admin as oversight) | Staff handles day-to-day tickets. Admin reviews escalations, bulk operations. Same UI, different default filters. |
| **User Feedback** | Both | Similar to tickets — staff triages, admin reviews. |
| **Users** | Both (admin has more power) | Staff views/searches users. Admin can also verify, suspend, change roles. |
| **Content Moderation** | Both | Staff does day-to-day moderation. Admin handles escalations and should see the same reports. Currently admin-blind to this. |
| **Appointments** | Both | Staff handles operational issues. Admin needs aggregate overview (today's sessions, completion rates). |
| **Payments/Refunds/Disputes** | Both (admin has approval authority) | Staff views and escalates. Admin approves refunds, handles disputes. |
| **Payouts** | Admin only | Payout approval is a financial authority operation. Staff should only see payout status for support context. |
| **Approval Payments** | Admin only | Payment approval requires admin authority. |
| **Invoices** | Both | Staff needs to find invoices for support. Admin manages the invoice system. |
| **Waitlists** | Both | Operational feature — both need visibility. |
| **Analytics/Metrics** | Both (different depth) | Staff sees support metrics (their tickets, response time). Admin sees platform-wide metrics (revenue, growth, health). |
| **System Jobs** | Admin only (SUPER_ADMIN) | Manual cron trigger — never needed by staff. |
| **Maintenance** | Admin only (SUPER_ADMIN) | Platform-wide operations — dangerous in wrong hands. |
| **Settings** | Both | Both need profile settings. Admin additionally needs platform settings (commission rates, feature flags). |

### 5.3 The Root Cause

The duplication happened because admin and staff were built as separate applications rather than a single application with permission-based feature visibility. The correct architecture is:

```
CURRENT (wrong):                        IDEAL:
┌──────────┐  ┌──────────┐             ┌─────────────────────────────┐
│  ADMIN   │  │  STAFF   │             │     INTERNAL DASHBOARD      │
│          │  │          │             │                             │
│ Tickets ─┼──┼─ Tickets │             │  Feature visibility based   │
│ Users   ─┼──┼─ Users   │             │  on AdminLevel:             │
│ Payments─┼──┼─ Payments│             │                             │
│ Refunds ─┼──┼─ Refunds │             │  MODERATOR: Support, Users, │
│ Disputes─┼──┼─ Disputes│             │    Moderation, Appointments │
│ ...11    │  │ ...more  │             │                             │
│ duplicate│  │ pages    │             │  ADMIN: + Payments, Payouts,│
│ pages    │  │          │             │    Analytics, Waitlists     │
└──────────┘  └──────────┘             │                             │
                                       │  SUPER_ADMIN: + System,     │
                                       │    Maintenance, Platform    │
                                       │    Settings                 │
                                       └─────────────────────────────┘
```

---

## 6. Consultant & Consultee Dashboard Notes

These are well-structured and not the focus of this assessment, but a few notes:

### Consultant Dashboard — What Works

- Clean 4-section navigation (Primary, Services, Content, Finance) — good information architecture
- Verification overlay blocks access until profile is verified (except settings page) — smart pattern
- Stream.io integration is properly memoized to prevent re-initialization on tab switches
- Earnings page with collaborator revenue-split display is sophisticated

### Consultant Dashboard — Issues

| Issue | Severity | Description |
|-------|----------|-------------|
| **Analytics is "Coming Soon"** | High | Consultants have no visibility into their performance — bookings over time, revenue trends, popular services, consultee demographics. This is core to the consultant experience. |
| **No calendar view** | Medium | Appointments page shows a list, but consultants think in terms of their calendar. A calendar view (week/month) would be the natural way to see their schedule. |
| **Earnings has no visualization** | Medium | Just a table. A consultant wants to see "Am I earning more this month?" at a glance — a simple line chart would answer this instantly. |
| **No way to see consultee feedback** | Medium | Consultant reviews exist in the schema but there's no dedicated page for consultants to view and respond to their reviews. |

### Consultant Dashboard — The Scope of the Home Counts

Every number on the consultant Home page is a personal (B2C) number, and that
is a deliberate consequence of ADR 19: the dashboards are split by the org-ness
of the underlying work, so a booking an organisation funds is reported on that
organisation's dashboard rather than here. `lib/data/consultant-dashboard.ts`
expresses this with a single `PERSONAL_ORG_PIN`, taken from the shared scope
projector in `lib/api/scope/parse.ts` so that "what personal means" has exactly
one definition on the platform, and it applies that pin to the earnings
aggregates, the session-completion rate and the active book.

The Pending Requests badge is part of that family. It is a `count()` rather than
the length of the list beside it, because the list is capped and a capped list
made the badge disagree with the "Needs you" card inches below it (#1101), and
as of #1345 it is built from the very predicates that "Needs you" uses:
`pendingConsultationWhere` and `pendingSubscriptionWhere` are exported from
`lib/data/needs-you.ts` and called with the personal scope. Sharing the builder
rather than re-typing the filter is what keeps the two numbers identical for a
consultant who also delivers through an organisation; before that change the
badge counted every `PENDING` request with no org filter at all, so one screen
could show three different totals for the same cohort. The third of those
totals was the mini request list, which relied on the list API's implicit
default; it now sends `orgScope=personal` explicitly, because that default only
resolves to personal for non-privileged callers and left an ADMIN or STAFF
consultant looking at an unfiltered list.

Two exceptions are intentional and should not be "fixed". The payout figures in
the Financial Summary are deliberately global, because payouts settle one
instrument across every context. The preview list under the badge keeps a
ninety-day bound that the badge does not, because a stale request is still worth
counting even when it is no longer worth showing.

### Consultee Dashboard — Notes

- Uses a completely different navigation pattern (top nav instead of sidebar). This is actually correct UX — consultees have fewer features and a top nav is less intimidating.
- Well-organized for its scope (appointments, waitlists, resources, messages, payments, referrals, support).
- Resources page for accessing plan materials is a nice touch.

---

## 7. Improvement Recommendations (Non-Enterprise)

These are changes to the existing dashboards that should happen regardless of enterprise plans.

### Priority 1: Critical (Do Before Launch)

#### 7.1 Merge Admin + Staff into Unified Internal Dashboard

**The single most impactful change.**

Instead of two separate dashboards with 11 duplicated pages, create one Internal Dashboard with `AdminLevel`-based visibility:

```
/dashboard/internal/[userId]/

Visibility by AdminLevel:

MODERATOR (day-to-day staff):
├── Home (support-focused: open tickets, pending reviews)
├── Support Tickets
├── User Feedback
├── Content Moderation
├── Users (view-only, no suspend/ban)
├── Appointments
├── Waitlists
└── Settings

ADMIN (management):
├── Everything MODERATOR has, plus:
├── Payments (all, approval)
├── Refunds
├── Disputes
├── Subscriptions
├── Invoices
├── Payouts
├── Analytics
└── Users (full actions: verify, suspend, change role)

SUPER_ADMIN (platform owner):
├── Everything ADMIN has, plus:
├── System Jobs
├── Maintenance Mode
├── Platform Settings (commission rates, feature flags)
└── Audit Log (who did what, when)
```

**Implementation**: Migrate staff sidebar to use shared `DashboardSidebar` with `NavSection[]`. Filter `NAV_SECTIONS` based on `adminLevel` from the session. Delete the custom staff sidebar code.

#### 7.2 Migrate Staff to Shared DashboardSidebar

The staff dashboard's custom sidebar (`app/dashboard/staff/[staffId]/layout.tsx`, lines 48-67) should be replaced with the shared `DashboardSidebar` component using sectioned navigation. This:

- Eliminates the duplicated sidebar component
- Brings consistent UX (same animations, same active state, same responsive behavior)
- Enables the collapsible feature to be added to the shared component (benefiting all dashboards)

#### 7.3 Remove System Jobs and Maintenance from Staff

Until the unified dashboard is built, immediately gate these behind an admin role check:

```typescript
// In staff layout, filter out system items for non-admin users
const filteredItems = sidebarItems.filter(item => {
  if (['system-jobs', 'maintenance'].includes(item.path)) {
    return userDetails?.role === 'ADMIN';
  }
  return true;
});
```

### Priority 2: High (Do Within First Month Post-Launch)

#### 7.4 Reorganize Admin Navigation

Current admin nav has unnamed sections with unrelated items dumped together. Proposed restructure:

```
CURRENT:                                PROPOSED:
[unnamed] Overview                      "Overview"
[unnamed] Announcements                   ├── Dashboard (home)
"Support"                                 └── Announcements
  ├── Support Tickets                   "Operations"
  └── User Feedback                       ├── Appointments        ← ADD (from staff)
"Payments"                                ├── Waitlists           ← MOVE here
  ├── All Payments                        ├── Content Moderation  ← ADD (from staff)
  ├── Approval Payments                   └── Announcements
  ├── Subscriptions                     "Support"
  ├── Refunds                             ├── Support Tickets
  └── Disputes                            └── User Feedback
"Payouts"                               "People"
  ├── Pending Approval                    └── Users
  ├── Processing                        "Finance"
  ├── Completed                           ├── Payments            ← SINGLE page with tabs
  └── Consultant Earnings                 ├── Payouts             ← SINGLE page with tabs
[unnamed]                                 ├── Refunds
  ├── Invoices                            ├── Disputes
  ├── Analytics                           ├── Invoices
  └── Users                               └── Subscriptions
[unnamed]                               "Insights"
  └── Waitlists                           └── Analytics
"System"                                "System" (SUPER_ADMIN only)
  ├── System Jobs                         ├── System Jobs
  └── Maintenance                         ├── Maintenance
                                          └── Platform Settings   ← NEW
```

Key changes:
- **Payments consolidated**: 5 items → 1 page with tabs/filters (All, Pending Approval)
- **Payouts consolidated**: 4 items → 1 page with tabs (Pending, Processing, Completed, Earnings)
- **Users gets its own "People" section** — it's an important feature buried in a dump section
- **Operations section added** — Appointments, Waitlists, and Moderation are operational tasks
- **Analytics elevated** to its own "Insights" section — signaling it's important

#### 7.5 Add Content Moderation to Admin

Admin is currently blind to content moderation. Port the staff's `moderation/page.tsx` to admin or (better) make it a shared component like `AnnouncementsPage`.

#### 7.6 Add Appointments Overview to Admin

Admin should see at minimum:
- Today's scheduled sessions (count + list)
- Completion rate (% of scheduled sessions that actually happened)
- Cancellation trends
- Top consultants by session count

### Priority 3: Medium (Do Within First 3 Months)

#### 7.7 Add a Charting Library

The platform needs time-series visualization. Recommended: **Recharts** (React-native, lightweight, works with TanStack Query).

Minimum charts needed:

**Admin Analytics:**
- Revenue over time (line chart, 30/90/365 day views)
- User signups over time (area chart)
- Sessions by type (bar chart: consultation vs subscription vs webinar vs class)
- Payment gateway distribution (pie/donut chart)
- Payout trends (line chart)

**Consultant Analytics (currently "Coming Soon"):**
- Earnings over time (line chart)
- Bookings by service type (bar chart)
- Rating trend (line chart)
- Consultee retention (returning vs new)

#### 7.8 Add Global Search to Admin Dashboard

Admin should be able to search across entities:
- "PAY-12345" → finds a payment
- "john@example.com" → finds a user
- "TKT-67890" → finds a support ticket

Implementation: A `Cmd+K` style search bar in `DashboardNavbar` that queries a unified search API.

#### 7.9 Add Audit Log

Track who did what:
- "Admin Kaustav approved payout PO-123 for ₹50,000"
- "Staff Shubham resolved ticket TKT-456"
- "Admin Kaustav put platform in maintenance mode"

Critical for financial compliance and debugging "who changed this?"

#### 7.10 Implement AdminLevel Feature Gating

Use the existing `AdminLevel` enum to conditionally render nav items and gate API routes:

```typescript
// Utility function
function canAccess(adminLevel: AdminLevel, feature: string): boolean {
  const permissions: Record<string, AdminLevel[]> = {
    'tickets':    ['MODERATOR', 'ADMIN', 'SUPER_ADMIN'],
    'moderation': ['MODERATOR', 'ADMIN', 'SUPER_ADMIN'],
    'payments':   ['ADMIN', 'SUPER_ADMIN'],
    'payouts':    ['ADMIN', 'SUPER_ADMIN'],
    'analytics':  ['ADMIN', 'SUPER_ADMIN'],
    'system':     ['SUPER_ADMIN'],
    'maintenance':['SUPER_ADMIN'],
    'settings':   ['SUPER_ADMIN'],
  };
  return permissions[feature]?.includes(adminLevel) ?? false;
}
```

---

## 8. The Enterprise Dashboard Question: Separate vs Upgrade?

### The Three Options

#### Option A: Separate Organization Dashboard

A completely new dashboard at `/dashboard/organization/[orgId]/` with its own layout, sidebar, and pages.

```
Pros:
+ Clean separation of concerns
+ Doesn't touch existing consultant code
+ Can be designed from scratch for org admin needs
+ Easy to feature-flag (entire route group)

Cons:
- More code to maintain (5th dashboard)
- Can't reuse consultant-specific components (recordings, scheduling)
- Org consultants might need to switch between consultant dashboard and org dashboard
- Yet another sidebar/layout pattern to maintain
```

#### Option B: Upgrade Consultant Dashboard

Add organization features to the existing consultant dashboard. If a consultant belongs to an org, they see extra nav items.

```
Pros:
+ Single dashboard — no context switching
+ Reuses all existing consultant components
+ Less code to maintain

Cons:
- Mixes two very different user needs (teach vs manage)
- Nav becomes bloated (14 items + 8 org items = 22 items)
- Permission logic becomes complex (org admin ≠ consultant)
- Not all org admins are consultants (HR might be org admin)
- Forces non-teaching org roles into a teaching-oriented UI
```

#### Option C: Hybrid — Separate Org Dashboard, with Consultant Dashboard "Org Aware" (RECOMMENDED)

Two changes:
1. A NEW Organization Dashboard for org admin work (team management, billing, analytics, settings)
2. The existing Consultant Dashboard gets subtle "org context" (org badge, org-branded header, link to org dashboard)

```
Pros:
+ Clean UX — each dashboard serves one primary job
+ Org admins who are also consultants can switch between dashboards
+ Non-teaching org roles (HR, L&D manager) have their own appropriate UI
+ Consultant dashboard stays focused and clean
+ Reuses shared components (DashboardShell, DashboardSidebar, StatCard)

Cons:
- Two dashboards to build (but org dashboard is much simpler than building from scratch — reuses shell)
- Need a "dashboard switcher" UI element
```

### Why Option C Wins

The fundamental insight is that **an org admin and a consultant have different jobs**:

| | Org Admin's Job | Consultant's Job |
|-|-----------------|------------------|
| **Primary goal** | Manage team access, control spending, track ROI | Teach, schedule, earn |
| **Key actions** | Invite members, review analytics, approve purchases, manage billing | Create plans, accept bookings, join calls, review documents |
| **Data they care about** | Seat utilization, team progress, org spend, engagement rates | Personal earnings, upcoming sessions, client feedback |
| **Frequency** | Weekly/monthly (admin is not their full-time job) | Daily (this is their work) |

Forcing these into one interface means:
- A consultant sees org management items they rarely need (noise)
- An HR manager using the org dashboard is forced into a teaching-oriented UI they don't understand
- Permission logic becomes "is this person an org admin AND a consultant?" — complex

**Option C keeps each interface focused on its primary user's job.**

### The Dashboard Switcher

For users who have multiple roles (e.g., a consultant who is also an org admin), add a simple dashboard switcher:

```
┌─────────────────────────────────────────────────────────┐
│  🔄 Dashboard Switcher (in DashboardNavbar)             │
│                                                         │
│  Current: Consultant Dashboard                          │
│  ─────────────────────────                              │
│  → Switch to: ABC Corp (Org Admin)                      │
│  → Switch to: Admin Dashboard (if platform admin)       │
└─────────────────────────────────────────────────────────┘
```

This is the pattern used by Slack (workspace switcher), Notion (workspace switcher), and Stripe (account switcher).

---

## 9. Enterprise Organization Dashboard Design

### 9.1 User Roles in the Org Dashboard

```
Org Dashboard Users (from BetterAuth Organization plugin):

OWNER       → Full access: billing, settings, team, analytics, SSO config
ADMIN       → Team management, analytics, content curation. No billing.
MANAGER     → View team progress, assign recordings. No team management.
MEMBER      → View-only: own progress, assigned content. No admin features.
```

### 9.2 Information Architecture

```
/dashboard/organization/[orgId]/

├── home/               ← Overview: seats, spend, active members, recent activity
├── team/               ← Member management: invite, remove, change roles
│   ├── members/        ← Member list with filters (role, department, status)
│   └── invitations/    ← Pending invitations, resend, revoke
├── content/            ← Recording library, collections, assignments
│   ├── library/        ← All recordings accessible to org
│   ├── collections/    ← Curated playlists by topic/role
│   └── assignments/    ← Assign content to members/teams
├── analytics/          ← Team engagement, completion rates, ROI
│   ├── engagement/     ← Who's using what, how often
│   ├── progress/       ← Completion tracking per member
│   └── reports/        ← Exportable reports (CSV/PDF)
├── billing/            ← Invoices, plan management, payment method
│   ├── plan/           ← Current plan, upgrade/downgrade
│   ├── invoices/       ← Invoice history, download PDFs
│   └── payment/        ← Payment method, billing email
├── bookings/           ← All sessions booked for org members
│   ├── upcoming/       ← Scheduled sessions
│   └── history/        ← Past sessions with feedback
└── settings/           ← Org profile, branding, SSO, integrations
    ├── profile/        ← Name, logo, description, domain
    ├── branding/       ← Colors, custom domain (enterprise plan)
    ├── sso/            ← SAML/OIDC config (enterprise plan)
    └── api/            ← API keys (enterprise plan)
```

### 9.3 Navigation Structure

```
NAV_SECTIONS for Organization Dashboard:

[primary]
  ├── Overview (home)
  └── Team

"Content"
  ├── Recording Library
  ├── Collections
  └── Assignments

"Insights"
  └── Analytics

"Finance"  (OWNER only)
  └── Billing

"Operations"
  └── Bookings

"Settings"  (OWNER + ADMIN only)
  └── Settings
```

### 9.4 Page-by-Page Breakdown

#### Home / Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ABC Corporation                                            [Settings] [?]  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ Active Seats │  │ This Month's │  │ Sessions     │  │ Completion   │   │
│  │   38 / 50    │  │ Spend        │  │ Booked       │  │ Rate         │   │
│  │ ▓▓▓▓▓▓▓▓░░  │  │ ₹24,500      │  │ 12           │  │ 87%          │   │
│  │   76% used   │  │ ↑ 15% vs last│  │ ↑ 3 vs last  │  │ ↑ 5% vs last │   │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘   │
│                                                                             │
│  ┌────────────────────────────────────┐  ┌────────────────────────────────┐ │
│  │ Recent Activity                    │  │ Quick Actions                  │ │
│  │                                    │  │                                │ │
│  │ • Priya Sharma watched "System     │  │  [+ Invite Member]             │ │
│  │   Design Fundamentals" (85%)       │  │  [📚 Create Collection]        │ │
│  │ • Rahul Verma booked a session     │  │  [📊 View Full Analytics]      │ │
│  │   with Dr. Anil Kumar (Mar 25)     │  │  [💳 View Billing]             │ │
│  │ • 3 new members joined this week   │  │                                │ │
│  │ • Invoice #ORG-INV-202603 ready    │  │                                │ │
│  └────────────────────────────────────┘  └────────────────────────────────┘ │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ Top Recordings This Month                    [View Library →]          ││
│  │                                                                        ││
│  │ 1. "System Design Fundamentals"  — 24 views, 89% avg completion       ││
│  │ 2. "Resume Building Workshop"    — 18 views, 76% avg completion       ││
│  │ 3. "Career Transition Strategy"  — 15 views, 92% avg completion       ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Team Management

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Team                                            [+ Invite Members]         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  [Members (38)]  [Pending Invitations (5)]  [Teams (3)]                     │
│  ───────────────────────────────────────────                                │
│                                                                             │
│  Search: [____________________]   Role: [All ▾]   Dept: [All ▾]           │
│                                                                             │
│  ┌─────────┬──────────────────┬──────────┬────────────┬──────────┬───────┐ │
│  │ Avatar  │ Name             │ Role     │ Department │ Sessions │  •••  │ │
│  ├─────────┼──────────────────┼──────────┼────────────┼──────────┼───────┤ │
│  │  (PS)   │ Priya Sharma     │ MEMBER   │ Engineering│ 12       │ [•••] │ │
│  │  (RV)   │ Rahul Verma      │ MEMBER   │ Product    │ 8        │ [•••] │ │
│  │  (AK)   │ Anita Kulkarni   │ MANAGER  │ HR         │ 3        │ [•••] │ │
│  │  (VG)   │ Vikram Gupta     │ ADMIN    │ L&D        │ 15       │ [•••] │ │
│  └─────────┴──────────────────┴──────────┴────────────┴──────────┴───────┘ │
│                                                                             │
│  ••• Menu: View Profile | Change Role | Remove from Org                     │
│                                                                             │
│  Page 1 of 4    [< Prev] [Next >]                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Analytics

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Analytics                              [Last 30 days ▾]  [Export CSV]      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ Member Engagement Over Time                                 [Line ▾]  ││
│  │                                                                        ││
│  │  Active ──                                                             ││
│  │  Members   │    ╱──╲                                                   ││
│  │     30 ──  │   ╱    ╲──╱──╲    ╱──╲                                   ││
│  │     20 ──  │  ╱              ╲╱    ╲──╱──╲                             ││
│  │     10 ──  │╱                              ╲                           ││
│  │         ───┼─────┬─────┬─────┬─────┬─────┬──                          ││
│  │            W1    W2    W3    W4    W5    W6                            ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                             │
│  ┌──────────────────────────────────┐  ┌──────────────────────────────────┐ │
│  │ Sessions by Type                 │  │ Top Members by Engagement       │ │
│  │                                  │  │                                  │ │
│  │  Consultation  ▓▓▓▓▓▓▓▓░░  45%  │  │  1. Priya S.   — 12 sessions   │ │
│  │  Webinar       ▓▓▓▓▓░░░░░  30%  │  │  2. Vikram G.  — 11 sessions   │ │
│  │  Class         ▓▓▓░░░░░░░  15%  │  │  3. Rahul V.   — 8 sessions    │ │
│  │  Recording     ▓▓░░░░░░░░  10%  │  │  4. Deepa M.   — 7 sessions    │ │
│  └──────────────────────────────────┘  └──────────────────────────────────┘ │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ ROI Summary                                                            ││
│  │                                                                        ││
│  │  Total Spend: ₹1,24,500    Sessions Completed: 47    Cost/Session: ₹2,648││
│  │  Avg Satisfaction: 4.6/5   Completion Rate: 87%      Members Active: 82%  ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Billing (OWNER Only)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Billing                                                    [Manage Plan]   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ Current Plan: BUSINESS                                                 ││
│  │                                                                        ││
│  │ 50 seats  •  ₹39,999/month  •  Renews: Apr 15, 2026  •  Active       ││
│  │                                                                        ││
│  │ Features: Admin dashboard, Analytics, Collections, Priority support    ││
│  │ Missing:  SSO, API access, Custom branding  → [Upgrade to Enterprise] ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                             │
│  [Plan Details]  [Invoices (12)]  [Payment Method]                          │
│  ─────────────────────────────────────────────                              │
│                                                                             │
│  Invoice History:                                                           │
│  ┌──────────────────┬──────────┬────────────┬──────────┬─────────┐         │
│  │ Invoice #        │ Date     │ Amount     │ Status   │ Action  │         │
│  ├──────────────────┼──────────┼────────────┼──────────┼─────────┤         │
│  │ ORG-INV-202603   │ Mar 2026 │ ₹39,999    │ Paid     │ [PDF↓]  │         │
│  │ ORG-INV-202602   │ Feb 2026 │ ₹39,999    │ Paid     │ [PDF↓]  │         │
│  │ ORG-INV-202601   │ Jan 2026 │ ₹39,999    │ Paid     │ [PDF↓]  │         │
│  └──────────────────┴──────────┴────────────┴──────────┴─────────┘         │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Settings (OWNER + ADMIN)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Settings                                                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  [Profile]  [Branding 🔒]  [SSO 🔒]  [API 🔒]  [Notifications]            │
│  ──────────────────────────────────────────────                              │
│                                                                             │
│  Organization Profile                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │  Logo:          [◉ Upload]                                             ││
│  │  Name:          [ABC Corporation________________]                      ││
│  │  Slug:          abc-corp (abc-corp.familiarise.com)                    ││
│  │  Industry:      [Technology ▾]                                         ││
│  │  Size:          [51-200 employees ▾]                                   ││
│  │  Website:       [https://abccorp.com____________]                      ││
│  │  Support Email: [hr@abccorp.com_________________]                      ││
│  │  Billing Email: [finance@abccorp.com____________]                      ││
│  │  GSTIN:         [27AAACB1234F1Z5_______________]                       ││
│  │                                                                        ││
│  │                                              [Save Changes]            ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                             │
│  🔒 = Enterprise plan only. [Upgrade to unlock]                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 9.5 Enterprise Dashboard — Role-Based Visibility

| Page | OWNER | ADMIN | MANAGER | MEMBER |
|------|-------|-------|---------|--------|
| Overview (home) | Full stats | Full stats | Team stats | Personal stats |
| Team → Members | Full CRUD | Full CRUD | View only | Hidden |
| Team → Invitations | Full CRUD | Full CRUD | Hidden | Hidden |
| Content → Library | Full access | Full access | Full access | Assigned only |
| Content → Collections | Create/Edit | Create/Edit | View | View assigned |
| Content → Assignments | Assign anyone | Assign anyone | Assign own team | Hidden |
| Analytics → Engagement | Org-wide | Org-wide | Team only | Personal only |
| Analytics → Progress | All members | All members | Team members | Self only |
| Analytics → Reports | Export all | Export all | Export team | Hidden |
| Billing → Plan | Full control | View only | Hidden | Hidden |
| Billing → Invoices | Download | View | Hidden | Hidden |
| Billing → Payment | Edit | Hidden | Hidden | Hidden |
| Bookings | All org | All org | Team only | Personal only |
| Settings → Profile | Edit | Edit | Hidden | Hidden |
| Settings → Branding | Edit (Enterprise) | View | Hidden | Hidden |
| Settings → SSO | Configure (Enterprise) | Hidden | Hidden | Hidden |
| Settings → API | Manage (Enterprise) | Hidden | Hidden | Hidden |

---

## 10. Unified Dashboard Architecture Vision

### 10.1 The Five Dashboards

After enterprise, the platform will have 5 dashboard contexts. Here's how they coexist:

```
┌───────────────────────────────────────────────────────────────────────────┐
│                         DASHBOARD ROUTER                                  │
│                       /dashboard (root)                                   │
│                                                                           │
│   Check user role + memberships → redirect to primary dashboard           │
│                                                                           │
├──────────┬──────────┬──────────────┬──────────────┬──────────────────────┤
│          │          │              │              │                      │
▼          ▼          ▼              ▼              ▼                      │
┌────────┐┌────────┐┌────────────┐┌────────────┐┌──────────────────────┐  │
│INTERNAL││CONSULT-││ CONSULTEE  ││ORGANIZATION││ DASHBOARD SWITCHER   │  │
│(admin +││ANT     ││            ││            ││                      │  │
│ staff) ││        ││ Top nav    ││ Sectioned  ││ Shows all dashboards │  │
│        ││Sectioned││ 8 items   ││ sidebar    ││ user has access to.  │  │
│Sectioned││sidebar ││           ││            ││ Lives in             │  │
│sidebar ││14 items ││ Personal  ││ Org admin  ││ DashboardNavbar.     │  │
│~15 items││        ││ learning  ││ focused    ││                      │  │
│        ││Teaching ││ journey   ││            ││ Example:             │  │
│Platform││focused  ││           ││ Team,      ││ "Consultant Dashboard"│  │
│ops     ││        ││           ││ billing,   ││ "ABC Corp (Admin)"    │  │
│focused ││        ││           ││ analytics  ││ "Admin Dashboard"     │  │
└────────┘└────────┘└────────────┘└────────────┘└──────────────────────┘  │
│                                                                           │
│ ALL USE:                                                                  │
│  • DashboardShell (mobile drawer + desktop fixed sidebar)                 │
│  • DashboardSidebar (sectioned nav, role-based colors, icon mapping)      │
│  • DashboardNavbar (notifications + user dropdown + dashboard switcher)   │
│  • StatCard, DataCard (shared metric components)                          │
│  • NovuProvider (notifications)                                           │
│  • DashboardErrorBoundary                                                 │
└───────────────────────────────────────────────────────────────────────────┘
```

### 10.2 Shared Component Reuse Map

```
Component                       Admin  Staff  Consultant  Consultee  Org
────────────────────────────── ────── ────── ────────── ────────── ───
DashboardShell                   ✓      ✗→✓      ✓          ✗        ✓
DashboardSidebar                 ✓      ✗→✓      ✓          ✗        ✓
DashboardNavbar                  ✓      ✗        ✓          ✓        ✓
StatCard                         ✓      ✓        ✓          ✗        ✓
DataCard                         ✓      ✓        ✓          ✓        ✓
AnnouncementsPage (shared)       ✓      ✓        ✗          ✗        ✗
InvoicesPage (shared)            ✓      ✓        ✗          ✗        ✓
NotificationInbox                ✓      ✓        ✓          ✓        ✓
UserDropdown                     ✓      ✗→✓      ✓          ✓        ✓
DashboardErrorBoundary           ✓      ✓        ✓          ✓        ✓

✗→✓ = Staff should migrate from custom to shared component
```

### 10.3 Role-to-Dashboard Access Matrix

A user might have access to multiple dashboards. The dashboard switcher shows all they can access:

```
User Role(s)                    Dashboards They Can Access
────────────────────────────── ──────────────────────────────────────────
Individual Consultee            Consultee
Individual Consultant           Consultant
Consultant + Org Member         Consultant + Organization (MEMBER view)
Consultant + Org Admin          Consultant + Organization (ADMIN view)
Org Owner (non-consultant)      Organization (OWNER view)
Org Member (non-consultant)     Organization (MEMBER view) + Consultee
Platform Staff (MODERATOR)      Internal (limited)
Platform Staff (ADMIN)          Internal (full)
Platform SUPER_ADMIN            Internal (full) + can view any dashboard
```

### 10.4 Color Coding System (Existing + Extended)

The `DashboardSidebar` already supports role-based colors:

```
Dashboard        Sidebar Color   Badge Color     Status
──────────────── ──────────────  ──────────────  ──────
Admin/Internal   Red (bg-red-*)  Red             Existing
Staff            Amber           Amber           Existing (needs migration)
Consultant       Emerald         Emerald         Existing
Consultee        Blue            Blue            Existing
Organization     Purple          Purple          NEW (proposed)
```

Purple for the org dashboard distinguishes it visually from all other dashboards and signals "business/corporate" without conflicting with existing role colors.

### 10.5 Implementation Priority Order

```
PHASE 1 (Pre-launch — 0-2 weeks):
├── Remove System Jobs + Maintenance from staff dashboard
├── Migrate staff sidebar to shared DashboardSidebar
└── Add Content Moderation + Appointments to admin dashboard

PHASE 2 (Month 1 post-launch — 2-4 weeks):
├── Reorganize admin nav into proposed structure
├── Consolidate Payments (5 items → 1 tabbed page)
├── Consolidate Payouts (4 items → 1 tabbed page)
├── Add Recharts for admin analytics (revenue, users, sessions)
└── Implement consultant analytics (replace "Coming Soon")

PHASE 3 (Month 2-3 — when first enterprise customer appears):
├── Merge admin + staff into unified Internal Dashboard with AdminLevel gating
├── Add dashboard switcher to DashboardNavbar
├── Build Organization Dashboard skeleton (home, team, settings)
└── Add global search (Cmd+K) to admin

PHASE 4 (Month 3-6 — as enterprise grows):
├── Build recording library + collections in org dashboard
├── Build org analytics with Recharts
├── Build org billing + invoice management
├── Add audit log to internal dashboard
└── Implement SSO configuration UI in org settings
```

---

## Appendix: Key File References

| File | What to Change | Priority |
|------|---------------|----------|
| `app/dashboard/staff/[staffId]/layout.tsx` | Replace custom sidebar with DashboardSidebar, filter nav by role | P1 |
| `app/dashboard/admin/layout.tsx` | Reorganize NAV_SECTIONS, add Moderation + Appointments | P1-P2 |
| `components/dashboard/DashboardSidebar.tsx` | Add collapsible support (currently only in staff's custom version) | P1 |
| `components/dashboard/DashboardNavbar.tsx` | Add dashboard switcher dropdown | P3 |
| `app/dashboard/admin/analytics/page.tsx` | Replace stat-only page with Recharts visualizations | P2 |
| `app/dashboard/consultant/[consultantId]/(features)/analytics/page.tsx` | Replace "Coming Soon" with real analytics | P2 |
| `app/dashboard/organization/` | NEW directory — entire org dashboard | P3-P4 |
| `components/dashboard/shared/` | Add more shared components (Moderation, Appointments) | P1-P2 |

---

## Appendix: Existing Competitor Dashboard Patterns (Reference)

For context, here's how competitors structure their admin-side dashboards:

**TopMate (primary competitor):**
- Single creator dashboard with sidebar
- Sections: Home, Services, Earnings, Audience, Integrations, Settings
- No enterprise/org dashboard (B2C only)
- Very simple — we're already more feature-rich

**Teachable (course platform with B2B):**
- School admin dashboard + Student dashboard (separate)
- Admin: Users, Courses, Sales, Emails, Settings
- Enterprise: Organization dashboard with seat management, SSO, usage reports
- Pattern: Separate dashboards for admin vs student vs org (matches our Option C)

**Thinkific (course platform with B2B):**
- Site admin + Org admin (separate dashboards)
- Org features: Group management, bulk enrollment, progress reports
- Pattern: Separate dashboards (matches our Option C)

**Key takeaway:** Platforms that successfully added B2B did it with a separate org dashboard, not by cramming features into the creator/student dashboard.
