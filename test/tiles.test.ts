import { describe, expect, test } from "bun:test";
import { childTiles, lonLatToTile, tileBounds3857, tileKey } from "../src/tiles";

describe("tile arithmetic", () => {
  test("maps Helmholtzplatz to the marquee z14 tile", () => {
    expect(lonLatToTile(13.415, 52.542, 14)).toEqual({ z: 14, x: 8802, y: 5371 });
  });

  test("maps the origin to the south-east z1 tile", () => {
    expect(lonLatToTile(0, 0, 1)).toEqual({ z: 1, x: 1, y: 1 });
  });

  test("lists the four children row-major", () => {
    expect(childTiles({ z: 14, x: 8802, y: 5371 })).toEqual([
      { z: 15, x: 17604, y: 10742 },
      { z: 15, x: 17605, y: 10742 },
      { z: 15, x: 17604, y: 10743 },
      { z: 15, x: 17605, y: 10743 },
    ]);
  });

  test("the root tile spans the whole mercator square", () => {
    const b = tileBounds3857({ z: 0, x: 0, y: 0 });
    expect(b.minX).toBeCloseTo(-20037508.342789244, 3);
    expect(b.maxX).toBeCloseTo(20037508.342789244, 3);
    expect(b.minY).toBeCloseTo(-20037508.342789244, 3);
    expect(b.maxY).toBeCloseTo(20037508.342789244, 3);
  });

  test("formats z/x/y", () => {
    expect(tileKey({ z: 9, x: 275, y: 167 })).toBe("9/275/167");
  });
});
