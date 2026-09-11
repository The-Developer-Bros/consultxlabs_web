"use client";

import {
  BarChart,
  Bar,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface PayoutsChartDatum {
  day: string;
  label: string;
  total: number;
}

interface PayoutsChartProps {
  data: PayoutsChartDatum[];
}

export default function PayoutsChart({ data }: PayoutsChartProps) {
  return (
    <div style={{ width: "100%", height: 200 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
          <XAxis
            dataKey="label"
            stroke="#64748b"
            fontSize={12}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            stroke="#64748b"
            fontSize={12}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value: number) =>
              value >= 1000
                ? `${(value / 1000).toFixed(1)}k`
                : String(value)
            }
          />
          <Tooltip
            formatter={(value: number) =>
              value.toLocaleString(undefined, {
                style: "currency",
                currency: "INR",
                maximumFractionDigits: 0,
              })
            }
          />
          <Bar dataKey="total" fill="#71717a" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
