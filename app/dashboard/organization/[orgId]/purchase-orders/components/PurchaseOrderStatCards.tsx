"use client";

/**
 * Stat-card row for the PurchaseOrders dashboard. Pure presentational
 * component — the parent computes the stats and hands them down.
 *
 * Forex POs are intentionally excluded from the INR rollup: mixing
 * currencies in a single sum is misleading. The "(INR only)" label
 * on the bottom-row cards is explicit about the scope.
 */

import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import { fmtMoney } from "../utils/formatting";

export interface PurchaseOrderStats {
  total: number;
  activeCount: number;
  totalCommittedINR: number;
  totalRemainingINR: number;
}

export function PurchaseOrderStatCards({ stats }: { stats: PurchaseOrderStats }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Total POs</CardDescription>
          <CardTitle className="text-2xl">{stats.total}</CardTitle>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Active</CardDescription>
          <CardTitle className="text-2xl">{stats.activeCount}</CardTitle>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Committed (INR only)</CardDescription>
          <CardTitle className="text-2xl">
            {fmtMoney(stats.totalCommittedINR, "INR")}
          </CardTitle>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Remaining (INR only)</CardDescription>
          <CardTitle className="text-2xl">
            {fmtMoney(stats.totalRemainingINR, "INR")}
          </CardTitle>
        </CardHeader>
      </Card>
    </div>
  );
}
