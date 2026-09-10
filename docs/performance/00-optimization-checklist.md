# Performance Optimization Checklist

> **Note:** This checklist documents the React Query migration completed in January 2025.
> For current real-time dashboard and caching strategies, see [`realtime-caching-strategy.md`](./realtime-caching-strategy.md).
>
> **Update (2026-06-17):** The route-level caching, bundle-optimization, and loading-boundary items below were substantially addressed by the navigation-performance round in PR #887. That round is documented in full — including the per-route loading boundaries, client-router cache tuning, bundle trimming, bounded dashboard queries, additive indexes, and slow-query observability — in [`01-navigation-performance.md`](./01-navigation-performance.md), which is now the canonical record for navigation and bundle performance. The statuses in Phase 3 and Phase 4 have been updated accordingly; see that document for the details and the deferred follow-ups.

## 🎯 Overview

This document tracks the complete dashboard performance optimization project to eliminate 10+ second load times and multiple-click navigation issues.

## 📊 Performance Goals

- **Before**: 10+ seconds load time, multiple clicks needed for navigation
- **Target**: 2-3 seconds initial load, instant tab switching
- **Method**: React Query + API consolidation + smart caching

---

## ✅ Phase 1: Critical Bug Fixes (COMPLETED)

### 🐛 Bug Fixes

- [x] **Fixed toISOString error in planner page** - `getStartTime()` function now properly handles Date conversion
  - **Files Updated**:
    - `utils/appointmentHelpers.ts` - Enhanced type safety for date handling
    - `HomeTab.tsx` - Fixed both instances of unsafe toISOString calls
    - `AppointmentsTab.tsx` - Fixed unsafe toISOString call
    - `PaginatedAppointments.tsx` - Fixed unsafe toISOString call
  - **Issue**: Date objects from API were sometimes strings, causing runtime errors
  - **Solution**: Added proper type conversion and null checking

---

## 🔄 Phase 2: React Query Migration (IN PROGRESS)

### ✅ Completed Pages

- [x] **Consultant Dashboard - Home** (`/home`)
  - Hook: `useConsultantDashboard`
  - API: `/api/dashboard/consultant/[consultantId]`
  - **Performance**: Consolidated 3 API calls → 1 optimized call
- [x] **Consultant Dashboard - Appointments** (`/appointments`)
  - Hook: `useAppointments`
  - Component: `AppointmentsPageWithQuery.tsx`
- [x] **Consultant Dashboard - Chats** (`/chats`)
  - Hook: `useConsultantDetails`
  - Component: `ChatsPageWithQuery.tsx`
- [x] **Consultant Dashboard - Documents** (`/documents`)
  - Hook: `useDocuments`
  - Component: `DocumentsPageWithQuery.tsx`
- [x] **Consultant Dashboard - Help** (`/help`)
  - Hook: `useHelp`
  - Component: `HelpPageWithQuery.tsx`
- [x] **Consultant Dashboard - Requests** (`/requests`)
  - Hook: `useRequests`
  - API: `/api/bookings/*` (self-fetched by the tab; the old `/api/dashboard/consultant/[consultantId]/requests` endpoint was deleted)
  - **Performance**: Consolidated 6 API calls → 1 optimized call
- [x] **Consultant Dashboard - Settings** (`/settings`)
  - Hook: Direct React Query in page
  - Uses: `fetchConsultantData`
- [x] **Consultee Dashboard - Home** (`/home`)
  - Hook: `useConsulteeEvents`
  - API: `/api/dashboard/consultee/[consulteeId]`
  - **Performance**: Consolidated 4 API calls → 1 optimized call
- [x] **Consultee Dashboard - Appointments** (`/appointments`)
  - Hook: `useConsulteeEvents`
  - API: `/api/dashboard/consultee/[consulteeId]/events`
  - **Performance**: Consolidated 4 API calls → 1 optimized call
- [x] **Consultee Dashboard - Feedback** (`/feedback`)
  - Hook: `useFeedback` + `useSupportTickets`
  - Enhanced error handling and loading states
- [x] **Consultee Dashboard - History** (`/history`)
  - Hook: `useConsulteeEvents`
  - Reuses consolidated events data
- [x] **Consultee Dashboard - Messages** (`/messages`)
  - Added error boundaries and consistent structure
- [x] **Consultee Dashboard - Policy** (`/policy`)
  - Added error boundaries and consistent structure
- [x] **Consultee Dashboard - Settings** (`/settings`)
  - Added error boundaries and consistent structure

- [x] **Consultant Dashboard - Planner** (`/planner`)
  - Hook: `usePlanner` + mutations
  - API: `/api/dashboard/consultant/[consultantId]/planner`
  - **Performance**: Consolidated webinars + classes + participant counts into 1 optimized call
  - **Features**: React Query mutations for delete operations, optimistic updates

### 🎉 All Pages Completed! (15/15)

### 📈 Expected Performance Improvements Per Page

- **API Calls**: Reduce from 2-4 calls per page → 1 optimized call
- **Caching**: 2min stale time + 5min garbage collection
- **Loading**: Proper skeleton loaders instead of basic spinners
- **Error Handling**: Comprehensive error boundaries with retry

---

## 🎨 Phase 3: Enhanced UI/UX (IN PROGRESS)

### ✅ Completed Components

- [x] **Global React Query Provider** - Configured with optimal caching
- [x] **Dashboard Error Boundaries** - Custom error UI with retry functionality
- [x] **Skeleton Loaders** - Comprehensive loading states matching actual UI
- [x] **Prefetching System** - Smart navigation hover prefetching
- [x] **Pagination Components** - Reusable pagination for large datasets

### 🔄 Pending Enhancements

- [x] **Add skeleton loaders to all components** — Delivered as route-level `loading.tsx` boundaries in PR #887. The application now has roughly 99 boundaries (up from 12), each re-rendering a shared dashboard or generic skeleton so navigation paints an instant, layout-matched fallback. See [`01-navigation-performance.md`](./01-navigation-performance.md) for the full breakdown.
- [ ] **Apply error boundaries to all pages** (15 pages remaining)
- [ ] **Implement optimistic updates for mutations**

---

## 🚀 Phase 4: Advanced Performance Features (LARGELY ADDRESSED)

Most of the items in this phase were delivered by the navigation-performance round in PR #887. The route-level caching and bundle-optimization sub-sections are now substantially complete; the remaining open items (behavior-driven prefetching and a service worker) are genuinely future work. The canonical record of what shipped, and why, is [`01-navigation-performance.md`](./01-navigation-performance.md).

### Caching Strategy

- [x] **Route-level caching** - Instant tab switching — Delivered via `experimental.staleTimes { dynamic: 30, static: 180 }` in `next.config.mjs`, which lets the Next.js client router hold a navigated page's RSC payload (~30s for dynamic segments) so re-navigation is instant with no network round trip. See [`01-navigation-performance.md`](./01-navigation-performance.md).
- [x] **Background synchronization** - Auto-refresh stale data — Covered by the React Query stale-time and refetch configuration applied across the dashboard pages.
- [ ] **Smart prefetching** - Based on user behavior patterns — Hover-based prefetching ships today (see [`02-dashboard-prefetching.md`](./02-dashboard-prefetching.md)); behavior-pattern-driven prefetching remains future work.

### Bundle Optimization

- [x] **Code splitting** - Lazy load heavy components — Delivered in PR #887. The Stream SDKs and their stylesheets now ship only in a lazily loaded chunk via an SDK-free `StreamProvider` shell, and `recharts` is lazy-loaded on the admin payouts page. See [`01-navigation-performance.md`](./01-navigation-performance.md).
- [x] **Bundle analysis** - Identify and reduce large dependencies — Delivered in PR #887 via `experimental.optimizePackageImports` for barrel libraries, dead-dependency removal (npm, swr, axios, cmdk, react-day-picker, tweetnacl), and dependency consolidation. See [`01-navigation-performance.md`](./01-navigation-performance.md).
- [ ] **Service worker** - Offline caching capabilities — Not yet attempted.

---

## 📊 Performance Metrics

### Network Requests

- **Before**: 4 parallel API calls per dashboard load
- **After**: 1 consolidated API call per dashboard load
- **Improvement**: 75% reduction in network requests

### Load Times (Target)

- **Initial Load**: 10s → 2-3s (70% improvement)
- **Tab Navigation**: 10s → <1s (90% improvement)
- **Re-navigation**: Multiple clicks → Instant

### React Query vs SWR Benefits

- ✅ **Better caching** - Automatic background updates
- ✅ **DevTools** - Built-in debugging capabilities
- ✅ **Optimistic updates** - Better UX during mutations
- ✅ **Error handling** - Automatic retries and error states
- ✅ **Memory management** - Automatic garbage collection

---

## 🧪 Testing & Validation

### Performance Benchmarks

- [ ] **Before/after load time measurements**
- [ ] **Network request analysis**
- [x] **Bundle size comparison** — Tracked with `@next/bundle-analyzer` (pinned to `^15`) during the PR #887 bundle round; see [`01-navigation-performance.md`](./01-navigation-performance.md).
- [ ] **Memory usage tracking**

### User Experience Testing

- [ ] **Navigation flow testing**
- [ ] **Error scenario handling**
- [ ] **Loading state validation**

---

## 📝 Implementation Notes

### API Consolidation Pattern

```typescript
// Before: Multiple calls
const appointments = await fetchAppointments(id);
const activities = await fetchActivities(id);
const approvals = await fetchApprovals(id);

// After: Single optimized call
const { appointments, activities, approvals } = await fetchDashboardData(id);
```

### React Query Configuration

```typescript
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2 * 60 * 1000, // 2 minutes
      gcTime: 5 * 60 * 1000, // 5 minutes
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});
```

---

## 🎯 Success Criteria

- [x] **Fix critical runtime errors** (toISOString bug)
- [x] **Convert all dashboard pages to React Query** (15/15 completed)
- [ ] **Achieve <3s initial load times**
- [ ] **Achieve <1s tab navigation**
- [ ] **Implement comprehensive error handling**
- [ ] **Add proper loading states everywhere**

---

**Last Updated**: 2025-01-04  
**Completion**: 100% (15/15 pages converted)  
**Status**: 🎉 COMPLETED! All dashboard pages now use React Query
