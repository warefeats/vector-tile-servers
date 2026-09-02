import { describe, expect, test } from "bun:test";
import { ENGINES, ENGINE_META, TILES, TILE_REQUEST_HEADERS, VIEWPORT, containerName, protocol, tileUrl } from "../src/matrix";

describe("engine matrix", () => {
  test("every engine has display metadata and a distinct colour", () => {
    const colours = new Set<string>();
    for (const engine of ENGINES) {
      const meta = ENGINE_META[engine];
      expect(meta.id).toBe(engine);
      expect(meta.name.length).toBeGreaterThan(0);
      expect(meta.version.length).toBeGreaterThan(0);
      expect(meta.image.length).toBeGreaterThan(0);
      colours.add(meta.color);
    }
    expect(colours.size).toBe(ENGINES.length);
  });

  test("builds each server's tile URL for the same z/x/y", () => {
    const tile = { z: 14, x: 8802, y: 5373 };
    expect(tileUrl("martin", "buildings", tile)).toBe("http://127.0.0.1:8099/buildings/14/8802/5373");
    expect(tileUrl("tegola", "buildings", tile)).toBe("http://127.0.0.1:8099/maps/bench/buildings/14/8802/5373.pbf");
    expect(tileUrl("bbox", "buildings", tile)).toBe("http://127.0.0.1:8099/xyz/buildings/14/8802/5373.mvt");
    expect(tileUrl("pg-tileserv", "buildings", tile)).toBe("http://127.0.0.1:8099/bench.buildings/14/8802/5373.pbf");
    expect(tileUrl("tipg", "buildings", tile)).toBe("http://127.0.0.1:8099/collections/bench.buildings/tiles/WebMercatorQuad/14/8802/5373");
  });

  test("ldproxy addresses tiles as z/row/col", () => {
    const tile = { z: 14, x: 8802, y: 5373 };
    expect(tileUrl("ldproxy", "roads", tile)).toBe("http://127.0.0.1:8099/bench/collections/roads/tiles/WebMercatorQuad/14/5373/8802");
    expect(tileUrl("ldproxy-pgis", "roads", tile)).toBe(tileUrl("ldproxy", "roads", tile));
    expect(TILE_REQUEST_HEADERS["Accept"]).toBe("application/vnd.mapbox-vector-tile");
  });

  test("the viewport is the marquee tile's four children", () => {
    const marquee = TILES[0]!;
    expect(VIEWPORT.layer).toBe(marquee.layer);
    expect(VIEWPORT.tiles).toHaveLength(4);
    for (const child of VIEWPORT.tiles) {
      expect(child.z).toBe(marquee.tile.z + 1);
      expect(Math.floor(child.x / 2)).toBe(marquee.tile.x);
      expect(Math.floor(child.y / 2)).toBe(marquee.tile.y);
    }
  });

  test("the smoke protocol is strictly shorter than the full one", () => {
    const smoke = protocol(true);
    const full = protocol(false);
    expect(smoke.coldStart.reps).toBeLessThan(full.coldStart.reps);
    expect(smoke.single.passes).toBeLessThan(full.single.passes);
    expect(smoke.burst.reps).toBeLessThan(full.burst.reps);
    expect(smoke.concurrency.levels.length).toBeLessThan(full.concurrency.levels.length);
    expect(full.concurrency.levels).toEqual([10, 100]);
    expect(full.requestTimeoutSeconds).toBe(60);
  });

  test("names compose containers per engine", () => {
    expect(containerName("pg-tileserv")).toBe("vts-pg-tileserv-engine-1");
  });
});
