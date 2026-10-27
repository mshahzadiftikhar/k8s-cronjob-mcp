export type TrendDirection = "slower" | "faster" | "stable";

export interface DurationTrend {
  direction: TrendDirection;
  percentChange: number;
  recentAverageSeconds: number;
  baselineAverageSeconds: number;
  sampleSize: number;
  summary: string;
}

/** Need a baseline plus a recent window, so at least this many successful runs. */
export const MIN_TREND_SAMPLES = 4;
const RECENT_WINDOW = 3;
const STABLE_BAND_PERCENT = 20;

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** `durations` are successful-run durations in seconds, oldest first. */
export function durationTrend(durations: number[]): DurationTrend | undefined {
  if (durations.length < MIN_TREND_SAMPLES) {
    return undefined;
  }
  const recent = durations.slice(-RECENT_WINDOW);
  const baseline = durations.slice(0, -RECENT_WINDOW);
  const recentAvg = mean(recent);
  const baselineAvg = mean(baseline);
  if (baselineAvg === 0) {
    return undefined;
  }
  const percentChange = Math.round(((recentAvg - baselineAvg) / baselineAvg) * 100);

  let direction: TrendDirection = "stable";
  if (percentChange > STABLE_BAND_PERCENT) {
    direction = "slower";
  } else if (percentChange < -STABLE_BAND_PERCENT) {
    direction = "faster";
  }

  let summary = `Duration is stable (${percentChange}% vs earlier runs)`;
  if (direction === "slower") {
    summary = `This job has gotten ${percentChange}% slower over the last ${durations.length} successful runs`;
  } else if (direction === "faster") {
    summary = `This job has gotten ${Math.abs(percentChange)}% faster over the last ${durations.length} successful runs`;
  }

  return {
    direction,
    percentChange,
    recentAverageSeconds: Math.round(recentAvg),
    baselineAverageSeconds: Math.round(baselineAvg),
    sampleSize: durations.length,
    summary,
  };
}
