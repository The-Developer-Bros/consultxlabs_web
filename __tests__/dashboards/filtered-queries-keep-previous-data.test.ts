/**
 * @jest-environment node
 */

/**
 * A filter that feeds a react-query key must keep the previous result.
 *
 * When a tab, status filter or page number is part of a `queryKey`, each value
 * is a separate query. Without `placeholderData: keepPreviousData`, switching
 * to a value that isn't cached drops `data` to undefined and `isLoading` back
 * to true — so the surface re-renders its loading branch even though perfectly
 * good rows were on screen a moment ago.
 *
 * On the consultant Earnings page that loading branch was an early return
 * above the whole page, so a tab click blanked the header, the four stat cards
 * and the tab bar itself — the user was left staring at a spinner where the
 * tabs used to be. This repo had already diagnosed and fixed exactly this once
 * (#346, the appointments list) and the fix was simply never applied here.
 *
 * The check is deliberately shallow — it reads source text rather than
 * rendering — because the failure is structural and a full render harness for
 * every dashboard would cost far more than it catches.
 */

import { readFileSync } from "fs";
import { join } from "path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/**
 * Surfaces whose query key contains a user-toggleable filter. Every one of
 * these can change key without unmounting, which is exactly the case
 * keepPreviousData exists for.
 */
const FILTER_DRIVEN_QUERIES = [
  // The filtered query moved into the Summary panel when Analytics folded onto
  // this route as a tab (ADR 19); `page.tsx` is now a server wrapper.
  "app/dashboard/consultant/[consultantId]/(features)/earnings/EarningsSummaryPanel.tsx",
  "app/dashboard/organization/[orgId]/payouts/PayoutsPageClient.tsx",
  "app/dashboard/admin/payouts/_sections/EarningsSection.tsx",
  "app/dashboard/organization/[orgId]/purchase-orders/page.tsx",
  "components/dashboard/shared/OperatorAppointmentsClient.tsx",
  // Already correct before this sweep — kept so they cannot regress.
  "components/dashboard/shared/DisputesPage.tsx",
  "components/dashboard/shared/FeedbackPage.tsx",
  "components/dashboard/shared/TicketsPage.tsx",
  "components/dashboard/shared/SubscriptionsPage.tsx",
];

describe("filter-driven dashboard queries keep the previous page on screen", () => {
  it.each(FILTER_DRIVEN_QUERIES)("%s uses keepPreviousData", (rel) => {
    const src = read(rel);
    expect(src).toContain("placeholderData: keepPreviousData");
    // Imported, not just referenced — a bare identifier would be a runtime crash.
    expect(src).toMatch(
      /import \{[^}]*keepPreviousData[^}]*\} from "@tanstack\/react-query"/,
    );
  });

  it("the operator appointments panel is not driven by isFetching", () => {
    // `loading = isLoading || isFetching` blanked the panel on every background
    // refetch, which keepPreviousData alone would not have fixed: the rows were
    // present and the component threw them away anyway. isFetching still drives
    // the refresh button, which is what it is for.
    const src = read(
      "components/dashboard/shared/OperatorAppointmentsClient.tsx",
    );
    expect(src).not.toMatch(/const loading = isLoading \|\| isFetching/);
    expect(src).toContain("const showLoadingPanel = isLoading && !data");
  });

  it("the earnings page no longer blanks the page while a tab loads", () => {
    // The early return is still correct for a genuine cold start, but with
    // keepPreviousData `data` is populated on a tab switch, so `!data` is false
    // and the page keeps its header, stat cards and tabs.
    const src = read(
      "app/dashboard/consultant/[consultantId]/(features)/earnings/EarningsSummaryPanel.tsx",
    );
    expect(src).toContain("isPlaceholderData");
    expect(src).toMatch(/isLoading && !data/);
  });
});
