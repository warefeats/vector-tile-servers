import { describe, expect, test } from "bun:test";
import { mean, percentile, statistics } from "../src/stats";

describe("statistics", () => {
  test("interpolates percentiles linearly", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5], 0.99)).toBeCloseTo(4.96, 6);
    expect(percentile([7], 0.99)).toBe(7);
  });

  test("summarises a sample", () => {
    expect(statistics([3, 1, 2])).toEqual({ medianMs: 2, meanMs: 2, minMs: 1, maxMs: 3 });
    expect(statistics([])).toEqual({ medianMs: 0, meanMs: 0, minMs: 0, maxMs: 0 });
    expect(mean([2, 4])).toBe(3);
  });
});
