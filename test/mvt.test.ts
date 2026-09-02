import { describe, expect, test } from "bun:test";
import { summarizeTile, totalFeatures } from "../src/mvt";

function varint(value: number): number[] {
  const out: number[] = [];
  while (value > 0x7f) {
    out.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  out.push(value);
  return out;
}

function field(number: number, wire: number): number[] {
  return varint((number << 3) | wire);
}

function bytesField(number: number, payload: number[]): number[] {
  return [...field(number, 2), ...varint(payload.length), ...payload];
}

function varintField(number: number, value: number): number[] {
  return [...field(number, 0), ...varint(value)];
}

function feature(type: number, id: number): number[] {
  return [...varintField(1, id), ...bytesField(2, [0, 0]), ...varintField(3, type), ...bytesField(4, [9, 0, 0])];
}

function layer(name: string, features: number[][], extent = 4096): number[] {
  const nameBytes = [...new TextEncoder().encode(name)];
  return [
    ...varintField(15, 2),
    ...bytesField(1, nameBytes),
    ...features.flatMap((f) => bytesField(2, f)),
    ...bytesField(3, [...new TextEncoder().encode("k")]),
    ...bytesField(4, bytesField(1, [...new TextEncoder().encode("v")])),
    ...varintField(5, extent),
  ];
}

describe("mvt reader", () => {
  test("counts layers, features and geometry types", () => {
    const tile = new Uint8Array([
      ...bytesField(3, layer("buildings", [feature(3, 1), feature(3, 2), feature(3, 300)])),
      ...bytesField(3, layer("pois", [feature(1, 7)], 512)),
    ]);
    const layers = summarizeTile(tile);
    expect(layers).toHaveLength(2);
    expect(layers[0]).toEqual({ name: "buildings", version: 2, extent: 4096, features: 3, geometryTypes: { polygon: 3 } });
    expect(layers[1]).toEqual({ name: "pois", version: 2, extent: 512, features: 1, geometryTypes: { point: 1 } });
    expect(totalFeatures(layers)).toBe(4);
  });

  test("an empty tile has no layers", () => {
    expect(summarizeTile(new Uint8Array())).toEqual([]);
  });

  test("rejects truncated input", () => {
    expect(() => summarizeTile(new Uint8Array([0x1a, 0x10, 0x01]))).toThrow();
  });
});
