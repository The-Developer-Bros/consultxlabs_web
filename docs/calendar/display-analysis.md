# Calendar Display Algorithm Analysis & Bug Report

## Executive Summary

Investigation of consultant `31e2e9f4-c9d5-4c4c-b281-e8531da623dd` (Mr. Jimmy Gibson) revealed **critical bugs in the seeding algorithm** that create invalid appointment data, resulting in incorrect calendar displays showing slots on days the consultant doesn't work and outside subscription periods.

---

## Data Flow Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ 1. DATABASE (Prisma)                                        │
├─────────────────────────────────────────────────────────────┤
│ • SlotOfAvailabilityWeekly  (consultant's working hours)    │
│ • SlotOfAvailabilityCustom  (specific date slots)           │
│ • Appointment +  SlotOfAppointment  (bookings)              │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. API LAYER                                                │
├─────────────────────────────────────────────────────────────┤
│ • /api/slots/availability-with-allocation/[consultantId]    │
│   - Fetches availability + appointments                     │
│   - Calls processAvailabilitySlots()                        │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. SLOT PROCESSING (utils/timeSlotsProcessing.ts)           │
├─────────────────────────────────────────────────────────────┤
│ • processWeeklySlots()  - Projects weekly patterns to dates │
│ • processCustomSlots()  - Filters custom slots by date      │
│ • getSlotBookingStatus() - Calculates booking status        │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. FRONTEND DATA HOOKS                                      │
├─────────────────────────────────────────────────────────────┤
│ • AllocationService.fetchAvailabilitySlots()                │
│ • useCalendarData()                                         │
│ • getSlotStatusForInterval()                                │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. UI DISPLAY (UnifiedCalendar.tsx)                         │
├─────────────────────────────────────────────────────────────┤
│ • Renders calendar grid                                     │
│ • Shows "Available" (green) / "Booked" (gray) slots         │
│ • Validates date boundaries (allowedStart/allowedEnd)       │
└─────────────────────────────────────────────────────────────┘
```

---

## Bugs Identified

### 🔴 CRITICAL BUG #1: Seeding Creates Slots on Invalid Days

**Location**: `prisma/seedFiles/createAppointments.ts` Lines 234-237

**Issue**: Subscription appointment seeding doesn't check consultant's actual availability

```typescript
// Distribute calls across different days of the week (Mon-Fri)
const dayOffset = (callIndex * 2) % 5; // Spread across weekdays
const callDate = new Date(
  weekStartDate.getTime() + dayOffset * 24 * 60 * 60 * 1000,
);
```

**Root Cause**:

- Assumes `weekStartDate` is always Monday (it's not!)
- If subscription starts on Sunday (Aug 17, 2025 = Sunday), week starts on Sunday
- `dayOffset` adds 0-4 days → Sunday, Tuesday, Thursday, Saturday, Monday
- Creates slots on days consultant doesn't work (e.g., Sundays)
- Never checks consultant's actual `slotsOfAvailabilityWeekly` to match days

**Evidence**:

- Consultant has **zero Sunday slots** in `slotsOfAvailabilityWeekly`
- But subscription has **26 Sunday appointment slots** (half of 52 total!)
- Slots created: Aug 17 (Sun), Aug 24 (Sun), Aug 31 (Sun), etc.

**Impact**: Calendar shows "Booked" slots on days consultant never works

---

### 🔴 CRITICAL BUG #2: Seeding Ignores Subscription Date Boundaries

**Location**: `prisma/seedFiles/createAppointments.ts` Lines 217-258

**Issue**: Creates slots before start date and after end date

**Evidence for Subscription `cmgflwuvk03nymf4gysztdb19`**:

- **Subscription Period**: Aug 18, 2025 02:22 AM – Aug 27, 2025 02:22 AM (9 days)
- **Expected Slots**: ~2-3 slots (2 calls/week × 9 days)
- **Actual Slots**: 52 slots spanning 6 months!

**Slots Created**:

- ❌ Aug 17 @ 09:00 (0.5 days **BEFORE** start)
- ✅ Aug 19 @ 10:00 (within period)
- ✅ Aug 24 @ 09:00 (within period)
- ✅ Aug 26 @ 10:00 (within period)
- ❌ Aug 31 @ 09:00 (4.5 days **AFTER** end)
- ❌ Sep 7, 14, 21, 28... Oct 5, 12, 19, 26... (up to Feb 2026!)
- **165 days after subscription ends!**

**Root Cause**:

- Line 207: `const totalWeeks = Math.ceil(durationInMonths * 4.33);`
- Calculates slots for PLAN duration (6 months), not subscription instance duration
- Never checks `subscription.startDate` or `subscription.endDate`
- Creates slots indefinitely into the future

**Impact**: Calendar shows bookings months after subscription expires

---

### 🔴 CRITICAL BUG #3: Slot Count Explosion

**Location**: `prisma/seedFiles/createAppointments.ts` Lines 211-219

**Issue**: Creates way more slots than plan allows

**Evidence**:

- Plan: Extended Subscription (6 months, 2 calls/week)
- Total weeks in 6 months: ~26 weeks
- Expected total slots: 26 weeks × 2 calls = **52 slots** ✅
- But subscription instance is only 9 days!
- Expected for 9-day period: ~2-3 slots ❌
- Actual created: 52 slots (full 6 months worth!)

**Root Cause**:

```typescript
const totalWeeks = Math.ceil(durationInMonths * 4.33); // Uses PLAN duration
const maxTotalCalls = sessionsPerWeek * totalWeeks; // Not subscription instance duration
```

**Impact**: Massively over-allocates consultant's time

---

### 🟡 MEDIUM BUG #4: Frontend Not Validating Date Boundaries

**Location**: `app/dashboard/consultant/[consultantId]/(features)/shared/components/UnifiedCalendar.tsx` Lines 414-427

**Issue**: Calendar allows interaction with slots outside `allowedStart`/`allowedEnd`

**Current Behavior**:

- Blue info banner shows: "Aug 18, 2025 at 2:22 AM – Aug 27, 2025 at 2:22 AM"
- User navigates to **Oct 5-11, 2025** (weeks after end)
- Calendar shows slots as "Available" (green) and "Booked" (gray)
- User can click and select these slots!

**Expected Behavior**:

- All slots outside allowed period should be **disabled/grayed out**
- Tooltip should say "Outside scheduling period"
- Clicks should show error toast

**Partial Fix Exists** (Lines 414-427):

```typescript
if (allowedStart || allowedEnd) {
  const intervalStart = new Date(status.intervalStartUTCString);
  if (isOutsideAllowedRange(intervalStart, allowedStart, allowedEnd)) {
    // Shows toast on click
    toast({
      title: "Slot outside allowed period",
      description: `This ${label} allows scheduling only between ${formatAllowedRange(...)}`,
    });
    return; // Prevents selection
  }
}
```

**BUT**: This only prevents **selection**. The slots still render as "Available" or "Booked" instead of being visually disabled.

**Root Cause**: The `renderTimeCell()` function doesn't check `allowedStart`/`allowedEnd` when setting cell class names

---

## Data Integrity Issues Found

### Consultant `31e2e9f4-c9d5-4c4c-b281-e8531da623dd`

**Profile**:

- Name: Mr. Jimmy Gibson
- Schedule Type: WEEKLY
- Availability: Mon-Fri, 09:00-18:00 UTC (22 slots total)
- **NO Saturday or Sunday slots**

**Subscription `cmgflwuvk03nymf4gysztdb19`**:

- Plan: Extended Subscription (6 months, 2 calls/week)
- Period: Aug 18-27, 2025 (9 days)
- Status: APPROVED
- **Slots Created**: 52 (should be ~2-3!)

**Invalid Slots Breakdown**:
| Category | Count | Examples |
|----------|-------|----------|
| Total Slots | 52 | - |
| Sunday Slots | 26 | Aug 17, 24, 31; Sep 7, 14, 21, 28; Oct 5, 12... |
| Before Start | 1 | Aug 17 @ 09:00 (0.5 days before) |
| After End | 48 | Aug 31 - Feb 10, 2026 (up to 167 days after!) |
| Within Period | **3** | Aug 19, 24, 26 ✅ |
| **Valid Slots** | **2-3** | Only Aug 19 & 26 (Tuesdays) are valid |

---

## Screenshot Analysis

### Screenshot 1: Aug 17-23, 2025

**Slots Shown**:

- ❌ Sun Aug 17 @ 14:30-15:00 (Booked) - INVALID (Sunday + Before start)
- ❌ Sun Aug 17 @ 14:30-15:00 (Booked) - INVALID (Sunday + Before start)
- ✅ Tue Aug 19 @ 15:30-16:00 (Booked) - VALID
- Other green "Available" slots match consultant's weekly availability

**Issues**:

1. Booked slots on Sunday shouldn't exist
2. Slots before Aug 18 @ 02:22 should be disabled

### Screenshot 2: Aug 24-30, 2025

**Slots Shown**:

- ❌ Sun Aug 24 @ 14:30-15:00 (Booked) - INVALID (Sunday)
- ✅ Tue Aug 26 @ 15:30-16:00 (Booked) - VALID
- ❌ Thu Aug 28+ "Available" slots - INVALID (After Aug 27 @ 02:22)

**Issues**:

1. Booked slots on Sunday shouldn't exist
2. All slots after Aug 27 @ 02:22 should be disabled (outside period)

---

## Recommended Fixes

### Fix #1: Validate Day Availability in Seeding

**File**: `prisma/seedFiles/createAppointments.ts`

```typescript
// BEFORE (Lines 232-237):
for (let callIndex = 0; callIndex < callsThisWeek; callIndex++) {
  const dayOffset = (callIndex * 2) % 5; // WRONG: Assumes week starts Monday
  const callDate = new Date(
    weekStartDate.getTime() + dayOffset * 24 * 60 * 60 * 1000,
  );
  callDate.setUTCHours(hour, 0, 0, 0);
}

// AFTER:
// 1. Fetch consultant's weekly availability slots
const consultantWeeklySlots = await prisma.slotOfAvailabilityWeekly.findMany({
  where: { consultantProfileId: slotData.slot.consultantProfileId },
});

// 2. Get available days of week
const availableDays = [...new Set(consultantWeeklySlots.map(s => s.dayOfWeekforStartTimeInUTC))];

// 3. Create slots only on days consultant works
for (let callIndex = 0; callIndex < callsThisWeek; callIndex++) {
  // Find next available day after current date
  let candidateDate = new Date(weekStartDate);
  candidateDate.setDate(candidateDate.getDate() + callIndex);

  while (!availableDays.includes(getDayOfWeekEnum(candidateDate))) {
    candidateDate.setDate(candidateDate.getDate() + 1);
  }

  // Check if candidate is within subscription period
  if (candidateDate < subscription.startDate || candidateDate > subscription.endDate) {
    continue; // Skip this slot
  }

  // Pick a random time from consultant's availability on that day
  const daySlots = consultantWeeklySlots.filter(
    s => s.dayOfWeekforStartTimeInUTC === getDayOfWeekEnum(candidateDate)
  );
  const randomSlot = faker.helpers.arrayElement(daySlots);

  const slotStart = new Date(candidateDate);
  slotStart.setUTCHours(
    randomSlot.slotStartTimeInUTC.getUTCHours(),
    randomSlot.slotStartTimeInUTC.getUTCMinutes(), 0, 0
  );

  const slotEnd = new Date(slotStart.getTime() + subscription.sessionDurationInHours * 60 * 60 * 1000);

  slots.push({ slotStartTimeInUTC: slotStart, slotEndTimeInUTC: slotEnd, ... });
}
```

### Fix #2: Respect Subscription Instance Dates

**File**: `prisma/seedFiles/createAppointments.ts`

```typescript
// BEFORE (Lines 207-211):
const totalWeeks = Math.ceil(durationInMonths * 4.33); // Uses PLAN duration
const maxTotalCalls = sessionsPerWeek * totalWeeks;

// AFTER:
// Calculate actual weeks in THIS subscription instance
const subscriptionDuration = endDate.getTime() - startDate.getTime();
const subscriptionWeeks = Math.ceil(
  subscriptionDuration / (7 * 24 * 60 * 60 * 1000),
);
const maxTotalCalls = sessionsPerWeek * subscriptionWeeks;

// Example: 9-day subscription = 2 weeks × 2 calls/week = 4 slots max
```

### Fix #3: Disable Slots Outside Allowed Period (Frontend)

**File**: `app/dashboard/consultant/[consultantId]/(features)/shared/components/UnifiedCalendar.tsx`

```typescript
// In renderTimeCell() function (around line 526):
const renderTimeCell = useCallback(
  (interval: { hour: number; minute: number }, date: Date) => {
    const status = getSlotStatusForInterval(interval, date);

    // NEW: Check if slot is outside allowed period
    const intervalStart = new Date(status.intervalStartUTCString);
    const isOutsideAllowedPeriod =
      (allowedStart && intervalStart < allowedStart) ||
      (allowedEnd && intervalStart > allowedEnd);

    // ... existing slot status logic ...

    if (isOutsideAllowedPeriod) {
      // Gray out and disable
      cellClassName += " bg-gray-200 text-gray-500 cursor-not-allowed opacity-50";
      buttonText = "Outside Period";
    } else if (isCurrentlySelected) {
      cellClassName += " bg-primary text-primary-foreground ...";
      buttonText = "Selected";
    } else if (status.isBookedForDisplay) {
      // ... existing logic
    }

    const isButtonDisabled =
      status.isInPast ||
      isOutsideAllowedPeriod ||  // NEW
      (status.isBookedForDisplay && !isCurrentlySelected);

    // ... rest of function
  },
  [allowedStart, allowedEnd, ...] // Add dependencies
);
```

---

## Testing Plan

1. **Re-seed Database** with fixed algorithm
2. **Verify Consultant Data**:
   - Run `verify-consultant-slots.ts`
   - Confirm no Sunday slots
   - Confirm all slots within subscription period
   - Confirm slot count matches expected (2-3 for 9-day period)

3. **Manual UI Testing**:
   - Navigate to Aug 17-23 view → No booked Sunday slots
   - Navigate to Aug 24-30 view → No booked Sunday slots
   - Navigate to Oct 5-11 view → All slots grayed out as "Outside Period"
   - Try to select slot on Oct 5 → Error toast appears

4. **Regression Testing**:
   - Test with different consultants (custom schedule type)
   - Test with different subscription durations (1, 6, 12 months)
   - Test with weekend-working consultants

---

## Conclusion

The calendar display algorithm itself is **correct**. The bugs are in:

1. ✅ **Seeding logic** - Creates invalid appointment data
2. ✅ **Frontend validation** - Doesn't visually disable out-of-range slots

The data flow and slot processing utilities are working as designed - they accurately display the (incorrect) data from the database.

**Priority**: Fix seeding algorithm first (Bugs #1, #2, #3), then enhance frontend validation (Bug #4).
