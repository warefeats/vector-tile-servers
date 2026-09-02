/** Web Mercator tile arithmetic (WebMercatorQuad, XYZ addressing). */

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

export function lonLatToTile(lon: number, lat: number, z: number): TileCoord {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { z, x, y };
}

/** The four tiles one zoom level in that together cover `tile`, row-major (NW, NE, SW, SE). */
export function childTiles(tile: TileCoord): TileCoord[] {
  const z = tile.z + 1;
  const x = tile.x * 2;
  const y = tile.y * 2;
  return [
    { z, x, y },
    { z, x: x + 1, y },
    { z, x, y: y + 1 },
    { z, x: x + 1, y: y + 1 },
  ];
}

/** Tile bounds in EPSG:3857 metres. */
export function tileBounds3857(tile: TileCoord): { minX: number; minY: number; maxX: number; maxY: number } {
  const worldSize = 2 * 20037508.342789244;
  const size = worldSize / 2 ** tile.z;
  const minX = -20037508.342789244 + tile.x * size;
  const maxY = 20037508.342789244 - tile.y * size;
  return { minX, minY: maxY - size, maxX: minX + size, maxY };
}

export function tileKey(tile: TileCoord): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}
