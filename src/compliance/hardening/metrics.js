const metrics = {
  scans: 0,
  errors: 0,
  durationsMs: []
};

export function trackScanResult({ durationMs, hasError }) {
  metrics.scans += 1;
  if (hasError) {
    metrics.errors += 1;
  }
  if (typeof durationMs === "number" && durationMs >= 0) {
    metrics.durationsMs.push(durationMs);
    if (metrics.durationsMs.length > 300) {
      metrics.durationsMs.shift();
    }
  }
}

export function getComplianceMetrics() {
  const avgDuration =
    metrics.durationsMs.length > 0
      ? metrics.durationsMs.reduce((sum, item) => sum + item, 0) / metrics.durationsMs.length
      : 0;

  return {
    scans: metrics.scans,
    errors: metrics.errors,
    errorRate: metrics.scans > 0 ? metrics.errors / metrics.scans : 0,
    averageDurationMs: Math.round(avgDuration)
  };
}
