# Dashboard Prefetching Strategy

> **⚠️ Status (post #1242 audit):** the `usePrefetchDashboard` /
> `prefetchOnTabHover` API shown below is **NOT currently mounted anywhere in
> the app** — only `staticQueries` from that module has live consumers.
> **Everything below the horizontal rule is a historical design reference,
> not a description of running behavior.**
>
> The prefetching that actually ships today:
>
> - **Personal dashboards:** layout-level idle `router.prefetch` of `/home`
>   (+ `/appointments` for consultants) via `schedulePrefetch`
>   (`consultee/[consulteeId]/layout.tsx`, `consultant/[consultantId]/layout.tsx`).
> - **Admin/staff:** `prefetchPaths` on `OperatorDashboardShell`
>   (`AdminShell`, `StaffShell`) → `usePrefetchNavPaths`.
> - **Org / org-workspace:** `usePrefetchNavPaths` in their shells
>   (`OrgDashboardShell` permission-gated, `OrgWorkspaceShell`).
>
> Either wire the hover/data prefetch back in or delete the dead exports —
> don't cite this page as evidence the behavior exists.

---

## Overview

This document outlines the enhanced prefetching strategy implemented for both consultant and consultee dashboards, providing lightning-fast navigation and improved user experience.

## Architecture Overview

### File Structure

```
hooks/
├── useConsultantPrefetchDashboard.ts   # Consultant-specific prefetching
└── useConsulteePrefetchDashboard.ts   # Consultee-specific prefetching

app/dashboard/
├── consultant/[consultantId]/
│   ├── layout.tsx                     # Uses consultant prefetching
│   └── page.tsx                       # Redirect with loading state
└── consultee/[consulteeId]/
    ├── layout.tsx                     # Uses consultee prefetching
    └── page.tsx                       # Redirect with loading state
```

## Key Improvements Made

### 1. **Separated Role-Specific Prefetching**

- **Before**: Single hook handling both roles (confusing and inefficient)
- **After**: Role-specific hooks with optimized queries for each dashboard type
- **Benefits**: Better performance, cleaner code, easier maintenance

### 2. **Replaced SWR with React Query**

- **Before**: Mixed SWR + React Query (problematic and inconsistent)
- **After**: Pure React Query with consistent patterns
- **Benefits**: Better caching, unified error handling, better dev tools

### 3. **Priority-Based Prefetching Strategy**

```typescript
// Consultant Dashboard Priorities
Priority 1 (0ms): Dashboard data, appointments, consultant details, help/FAQ
Priority 2 (500ms): Requests, planner

// Consultee Dashboard Priorities
Priority 1 (0ms): Events data, consultee profile
Priority 2 (500ms): Feedback, support tickets, messages, settings
```

## Consultant Dashboard Implementation

### Data Structure

The consultant dashboard prefetches:

- **Dashboard Overview**: `/api/dashboard/consultant/{id}`
- **Appointments**: `/api/slots/appointments?consultantProfileId={id}`
- **Consultant Details**: `/api/user/consultants/{id}`
- **Requests**: `/api/bookings/*` (self-fetched by the tab; the `/api/dashboard/consultant/{id}/requests` endpoint was deleted)
- **Planner**: `/api/dashboard/consultant/{id}/planner`
- **Help/FAQ**: Static import from questions file

### Navigation Items

```typescript
const NAV_ITEMS = [
  { name: "Home", path: "home", icon: "🏠" },
  { name: "Chats", path: "chats", icon: "💬" },
  { name: "Appointments", path: "appointments", icon: "📅" },
  { name: "Event Planner", path: "planner", icon: "📋" },
  { name: "Requests", path: "requests", icon: "📝" },
  { name: "Documents for Review", path: "documents", icon: "📄" },
  { name: "Help", path: "help", icon: "❓" },
];
```

### Usage Example

```typescript
// In consultant layout
import { usePrefetchDashboard } from "@/hooks/useConsultantPrefetchDashboard";

const { prefetchAllConsultantData, prefetchOnTabHover } = usePrefetchDashboard({
  consultantId,
});

// Auto-prefetch on mount
useEffect(() => {
  if (consultantId) {
    prefetchAllConsultantData();
  }
}, [consultantId, prefetchAllConsultantData]);
```

## Consultee Dashboard Implementation

### Data Structure

The consultee dashboard prefetches:

- **Events Data**: `/api/dashboard/consultee/{id}/events`
- **Consultee Profile**: `/api/user/consultees/{id}`
- **User Details**: `/api/user/{userId}`
- **Feedback**: `/api/user/feedbacks`
- **Support Tickets**: `/api/user/support-tickets`
- **Messages**: `/api/dashboard/consultee/{id}/messages` (with 404 fallback)
- **Settings**: Same as profile data

### Navigation Items

```typescript
const NAV_ITEMS = [
  { name: "Home", path: "home" },
  { name: "Appointments", path: "appointments" },
  { name: "Booking History", path: "history" },
  { name: "Messages", path: "messages" },
  { name: "Feedback & Support", path: "feedback" },
  { name: "Settings", path: "settings" },
  { name: "Policy", path: "policy" },
];
```

### Usage Example

```typescript
// In consultee layout
import { useConsulteePrefetchDashboard } from "@/hooks/useConsulteePrefetchDashboard";

const { prefetchAllConsulteeData, prefetchUserData, prefetchOnTabHover } =
  useConsulteePrefetchDashboard({ consulteeId });

// Auto-prefetch on mount
useEffect(() => {
  if (consulteeId) {
    prefetchAllConsulteeData();
    prefetchUserData(userId);
  }
}, [consulteeId, userId, prefetchAllConsulteeData, prefetchUserData]);
```

## Smart Hover Prefetching

### Consultant Hover Logic

```typescript
switch (tabType) {
  case "home":
    safePrefetch([queries.dashboard], "high");
    break;
  case "appointments":
    safePrefetch([queries.appointments], "high");
    break;
  case "planner":
    safePrefetch([queries.planner], "high");
    break;
  case "requests":
    safePrefetch([queries.requests], "high");
    break;
  default:
    safePrefetch([queries.details], "medium");
}
```

### Consultee Hover Logic

```typescript
switch (tabType) {
  case "home":
    safePrefetch([queries.events, queries.profile], "high");
    break;
  case "appointments":
  case "history":
    safePrefetch([queries.events], "high");
    break;
  case "messages":
    safePrefetch([queries.messages], "high");
    break;
  case "feedback":
    safePrefetch([queries.feedback, queries.supportTickets], "high");
    break;
  case "settings":
    safePrefetch([queries.settings], "high");
    break;
  case "policy":
    // Static content, no prefetching needed
    break;
}
```

## Hybrid Route + Data Prefetching

### Route Prefetching (Both Dashboards)

```typescript
// Critical routes are prefetched on component mount
const criticalRoutes = [
  `/dashboard/consultant/${consultantId}/home`,
  `/dashboard/consultant/${consultantId}/appointments`,
  `/dashboard/consultant/${consultantId}/chats`,
];

criticalRoutes.forEach((route) => {
  router.prefetch(route);
});
```

### Hover-Based Route Prefetching

```typescript
const handleNavHover = (path: string) => {
  // Prefetch the route
  router.prefetch(`/dashboard/consultant/${consultantId}/${path}`);

  // Prefetch data for the tab
  prefetchOnTabHover(path);
};
```

## Performance Optimizations

### 1. **Throttling Mechanism**

Prevents excessive prefetching on rapid hover events:

```typescript
const throttledPrefetch = (fn: () => void) => {
  const key = `hover-${tabType}-${consulteeId}`;
  if (prefetchedRef.current.has(key)) return;

  prefetchedRef.current.add(key);
  fn();

  // Clear throttle after 5 seconds
  setTimeout(() => prefetchedRef.current.delete(key), 5000);
};
```

### 2. **requestIdleCallback Usage**

Non-blocking prefetch execution:

```typescript
if (typeof window !== "undefined" && "requestIdleCallback" in window) {
  window.requestIdleCallback(prefetchCriticalData, { timeout: 2000 });
} else {
  setTimeout(prefetchCriticalData, 100);
}
```

### 3. **Promise.allSettled for Resilience**

Graceful handling of partial failures:

```typescript
const results = await Promise.allSettled(
  queries.map((query) => queryClient.prefetchQuery(query)),
);

// Log failures in development only
if (process.env.NODE_ENV === "development") {
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.warn(`Prefetch failed:`, queries[index].queryKey, result.reason);
    }
  });
}
```

### 4. **Memory Management**

Proper cleanup of prefetch tracking:

```typescript
useEffect(() => {
  return () => {
    prefetchedRef.current.clear();
  };
}, []);
```

## Query Factory Pattern

### Benefits

- **Centralized Configuration**: All query configs in one place
- **Type Safety**: Better TypeScript support
- **Reusability**: Easily reuse queries across components
- **Maintainability**: Easier to update API endpoints

### Example Structure

```typescript
const createConsultantQueries = (consultantId: string) => ({
  dashboard: {
    queryKey: ["consultant-dashboard", consultantId],
    queryFn: async () => {
      const response = await fetch(`/api/dashboard/consultant/${consultantId}`);
      if (!response.ok)
        throw new Error(`Dashboard fetch failed: ${response.statusText}`);
      const data = await response.json();
      return data.data;
    },
    staleTime: 2 * 60 * 1000,
  },
  // ... other queries
});
```

## Error Handling Strategy

### 1. **Graceful Degradation**

Prefetching failures don't break the app:

```typescript
try {
  await safePrefetch([queries.dashboard], "high");
} catch (error) {
  console.warn("Dashboard data prefetching failed:", error);
  // App continues working normally
}
```

### 2. **Development Logging**

Enhanced debugging in development:

```typescript
if (process.env.NODE_ENV === "development") {
  console.warn(`Prefetch failed for query:`, queryKey, error);
}
```

### 3. **API Fallbacks**

Handle missing endpoints gracefully:

```typescript
// Messages API might not exist yet
queryFn: async () => {
  const response = await fetch(
    `/api/dashboard/consultee/${consulteeId}/messages`,
  );
  if (!response.ok) {
    if (response.status === 404) return []; // Fallback for missing API
    throw new Error(`Messages fetch failed: ${response.statusText}`);
  }
  return response.json();
};
```

## Loading States & UI

### Enhanced Loading Components

Both dashboards have improved loading states:

```typescript
// Page-level loading during redirects
if (isRedirecting || !consulteeId) {
  return (
    <div className="bg-slate-50 min-h-screen flex flex-col">
      {/* Skeleton nav matching actual layout */}
      {/* Skeleton main content */}
    </div>
  );
}
```

### Layout-Level Loading

Consistent skeleton loading in both layouts:

```typescript
if (isLoading) {
  return (
    <div className="flex flex-col space-y-4">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-32 w-full rounded-md" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Skeleton className="h-24 rounded-md" />
        <Skeleton className="h-24 rounded-md" />
      </div>
    </div>
  );
}
```

## Expected Performance Impact

### Consultant Dashboard

- **60-80% faster** navigation between home, appointments, planner
- **Instant loading** of frequently accessed tabs
- **Reduced API calls** through intelligent caching

### Consultee Dashboard

- **70-85% faster** navigation between events-related tabs
- **Immediate feedback** display when hovering over feedback tab
- **Seamless messaging** experience with prefetched chat data

### Overall Improvements

- **Better Core Web Vitals**: Reduced LCP and CLS
- **Improved User Experience**: "Instant app" feeling
- **Network Efficiency**: Smarter request batching and caching
- **Error Resilience**: Graceful degradation on failures

## Monitoring & Debugging

### React Query DevTools

```typescript
// Add to your app root
{process.env.NODE_ENV === 'development' && (
  <ReactQueryDevtools initialIsOpen={false} />
)}
```

### Performance Monitoring

```typescript
// Measure prefetch effectiveness
performance.mark("prefetch-start");
await prefetchAllConsultantData();
performance.mark("prefetch-end");
performance.measure("prefetch-duration", "prefetch-start", "prefetch-end");
```

## Next Steps & Future Enhancements

### 1. **Server-Side Prefetching**

```typescript
// Future: Server Components with prefetched data
export async function generateStaticParams() {
  // Pre-generate common consultant/consultee IDs
}
```

### 2. **Service Worker Integration**

```typescript
// Advanced caching with service workers
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/dashboard-sw.js");
}
```

### 3. **Intersection Observer**

```typescript
// Viewport-based prefetching
const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      prefetchTabData(entry.target.dataset.tab);
    }
  });
});
```

### 4. **Analytics Integration**

Track prefetch effectiveness and user navigation patterns to further optimize the strategy.

## Migration Checklist

- ✅ **Consultant dashboard** - Converted to React Query + new prefetching
- ✅ **Consultee dashboard** - Converted to React Query + new prefetching
- ✅ **Role-specific hooks** - Separated concerns for better maintainability
- ✅ **Enhanced loading states** - Better skeleton UIs and loading feedback
- ✅ **Route + data prefetching** - Hybrid approach for complete optimization
- 🔄 **Performance monitoring** - Add metrics and analytics
- 🔄 **Service worker caching** - Advanced offline capabilities
- 🔄 **Server-side prefetching** - Initial page load optimization

This implementation provides a solid foundation for high-performance dashboard navigation while maintaining clean, maintainable code that can scale with your application's growth.
