"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";

type TdsSummary = {
  financialYear: string;
  quarterWise: { quarter: number; totalDeducted: number; count: number }[];
  totalDeducted: number;
  totalRecords: number;
  unfiledRecords: number;
};

type ConsultantRow = {
  consultantProfileId: string;
  tdsRateBps: number;
  _sum: { tdsDeducted: number | null; cumulativeAmountCredited: number | null };
  _count: number;
};

function rupees(paise: number | null | undefined): string {
  return `₹${((paise ?? 0) / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// India FY runs Apr–Mar; label as "YYYY-YY". Build the last few for the picker.
function financialYearOptions(count = 4): string[] {
  const now = new Date();
  const startYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return Array.from({ length: count }, (_, i) => {
    const y = startYear - i;
    return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
  });
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json() as Promise<T>;
}

export default function TdsPageClient() {
  const fyOptions = useMemo(() => financialYearOptions(), []);
  const [fy, setFy] = useState(fyOptions[0]);

  const summary = useQuery({
    queryKey: ["admin-tds-summary", fy],
    queryFn: () => fetchJson<TdsSummary>(`/api/admin/tds?fy=${fy}&view=summary`),
    staleTime: 60_000,
  });

  const consultants = useQuery({
    queryKey: ["admin-tds-consultants", fy],
    queryFn: () =>
      fetchJson<{ consultants: ConsultantRow[] }>(
        `/api/admin/tds?fy=${fy}&view=consultants`,
      ),
    staleTime: 60_000,
  });

  return (
    <div className="space-y-6">
      <DashboardHeader
        title="TDS"
        subtitle="Tax deducted at source — summary and consultant breakdown"
      />

      <div className="flex items-center gap-2">
        <label htmlFor="fy" className="text-sm text-muted-foreground">
          Financial year
        </label>
        <select
          id="fy"
          value={fy}
          onChange={(e) => setFy(e.target.value)}
          className="rounded-md border bg-background px-2 py-1 text-sm"
        >
          {fyOptions.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {summary.isLoading ? (
          <>
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </>
        ) : summary.isError ? (
          <Card className="sm:col-span-3">
            <CardContent className="py-6 text-sm text-destructive">
              Failed to load TDS summary.
            </CardContent>
          </Card>
        ) : (
          <>
            <SummaryCard
              label="Total deducted"
              value={rupees(summary.data?.totalDeducted)}
            />
            <SummaryCard
              label="TDS records"
              value={String(summary.data?.totalRecords ?? 0)}
            />
            <SummaryCard
              label="Unfiled records"
              value={String(summary.data?.unfiledRecords ?? 0)}
            />
          </>
        )}
      </div>

      {/* Quarter-wise */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Quarter-wise deduction</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-4">Quarter</th>
                <th className="py-2 pr-4">Records</th>
                <th className="py-2">Deducted</th>
              </tr>
            </thead>
            <tbody>
              {(summary.data?.quarterWise ?? []).map((q) => (
                <tr key={q.quarter} className="border-b last:border-0">
                  <td className="py-2 pr-4">Q{q.quarter}</td>
                  <td className="py-2 pr-4">{q.count}</td>
                  <td className="py-2">{rupees(q.totalDeducted)}</td>
                </tr>
              ))}
              {!summary.isLoading &&
                (summary.data?.quarterWise?.length ?? 0) === 0 && (
                  <tr>
                    <td
                      colSpan={3}
                      className="py-6 text-center text-muted-foreground"
                    >
                      No TDS recorded for {fy}.
                    </td>
                  </tr>
                )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Consultant breakdown */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Consultant breakdown</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {consultants.isLoading ? (
            <Skeleton className="h-40" />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-4">Consultant</th>
                  <th className="py-2 pr-4">Rate</th>
                  <th className="py-2 pr-4">Credited</th>
                  <th className="py-2 pr-4">Deducted</th>
                  <th className="py-2">Records</th>
                </tr>
              </thead>
              <tbody>
                {(consultants.data?.consultants ?? []).map((c) => (
                  <tr
                    key={`${c.consultantProfileId}-${c.tdsRateBps}`}
                    className="border-b last:border-0"
                  >
                    <td className="py-2 pr-4 font-mono text-xs">
                      {c.consultantProfileId}
                    </td>
                    <td className="py-2 pr-4">{c.tdsRateBps / 100}%</td>
                    <td className="py-2 pr-4">
                      {rupees(c._sum.cumulativeAmountCredited)}
                    </td>
                    <td className="py-2 pr-4">{rupees(c._sum.tdsDeducted)}</td>
                    <td className="py-2">{c._count}</td>
                  </tr>
                ))}
                {!consultants.isLoading &&
                  (consultants.data?.consultants?.length ?? 0) === 0 && (
                    <tr>
                      <td
                        colSpan={5}
                        className="py-6 text-center text-muted-foreground"
                      >
                        No consultant TDS for {fy}.
                      </td>
                    </tr>
                  )}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  );
}
