export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = p * (sorted.length - 1);
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low]!;
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (index - low);
}

export function mean(samples: number[]): number {
  if (samples.length === 0) return Number.NaN;
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

export function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export interface Statistics {
  medianMs: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
}

/** The site's four-number summary of a sample array (the field names say ms; the unit is the section's). */
export function statistics(samples: number[]): Statistics {
  if (samples.length === 0) return { medianMs: 0, meanMs: 0, minMs: 0, maxMs: 0 };
  return {
    medianMs: round(percentile(samples, 0.5), 3),
    meanMs: round(mean(samples), 3),
    minMs: round(Math.min(...samples), 3),
    maxMs: round(Math.max(...samples), 3),
  };
}
