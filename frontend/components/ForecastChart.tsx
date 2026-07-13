"use client";

import {
  Area,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  ReferenceLine,
} from "recharts";
import type { ForecastSeries } from "@/lib/api";

type ChartPoint = {
  timestamp: string;
  actual?: number;
  mean?: number;
  band?: [number, number];
};

function toChartData(series: ForecastSeries): { data: ChartPoint[]; forecastStart: string | null } {
  const data: ChartPoint[] = series.history.map((h) => ({
    timestamp: h.timestamp,
    actual: h.value,
  }));
  const forecastStart = series.forecast[0]?.timestamp ?? null;
  // Bridge point so the forecast lines visually continue from the last actual.
  const last = series.history[series.history.length - 1];
  if (last && series.forecast.length > 0) {
    data[data.length - 1] = {
      ...data[data.length - 1],
      mean: last.value,
      band: [last.value, last.value],
    };
  }
  for (const f of series.forecast) {
    data.push({ timestamp: f.timestamp, mean: f.mean, band: [f.q10, f.q90] });
  }
  return { data, forecastStart };
}

function formatTick(ts: string): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:00`;
}

export function ForecastChart({ series }: { series: ForecastSeries }) {
  const { data, forecastStart } = toChartData(series);

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
          <XAxis
            dataKey="timestamp"
            tickFormatter={formatTick}
            tick={{ fontSize: 10, fill: "var(--text-faint)" }}
            minTickGap={48}
            stroke="var(--border)"
          />
          <YAxis
            domain={["auto", "auto"]}
            tick={{ fontSize: 10, fill: "var(--text-faint)" }}
            stroke="var(--border)"
            width={44}
          />
          <Tooltip
            labelFormatter={(ts) => new Date(String(ts)).toLocaleString()}
            formatter={(value, name) => {
              if (Array.isArray(value)) return [`${value[0]} – ${value[1]}`, "normal range (q10–q90)"];
              return [String(value), name === "actual" ? "recorded" : "forecast (mean)"];
            }}
            contentStyle={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              fontSize: 11,
            }}
          />
          {forecastStart && (
            <ReferenceLine
              x={forecastStart}
              stroke="var(--text-faint)"
              strokeDasharray="4 4"
              label={{ value: "forecast →", position: "insideTopRight", fontSize: 10, fill: "var(--text-faint)" }}
            />
          )}
          <Area
            dataKey="band"
            stroke="none"
            fill="var(--accent, #8b5e3c)"
            fillOpacity={0.14}
            isAnimationActive={false}
            connectNulls
          />
          <Line
            dataKey="actual"
            stroke="var(--text)"
            strokeWidth={1.4}
            dot={false}
            isAnimationActive={false}
            connectNulls
          />
          <Line
            dataKey="mean"
            stroke="var(--accent, #8b5e3c)"
            strokeWidth={1.6}
            strokeDasharray="5 3"
            dot={false}
            isAnimationActive={false}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
