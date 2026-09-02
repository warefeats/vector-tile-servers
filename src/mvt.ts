/**
 * Minimal Mapbox Vector Tile reader: enough protobuf to count layers, features and geometry
 * types, so the runner can check that every server put the same content in the same tile.
 */

export interface LayerSummary {
  name: string;
  version: number;
  extent: number;
  features: number;
  geometryTypes: Record<string, number>;
}

const GEOMETRY_TYPES: Record<number, string> = { 0: "unknown", 1: "point", 2: "linestring", 3: "polygon" };

class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (this.pos >= this.buf.length) throw new Error("truncated varint");
      const byte = this.buf[this.pos++]!;
      if (shift < 28) {
        result |= (byte & 0x7f) << shift;
      } else {
        result += (byte & 0x7f) * 2 ** shift;
      }
      if ((byte & 0x80) === 0) return result;
      shift += 7;
      if (shift > 63) throw new Error("varint too long");
    }
  }

  bytes(): Uint8Array {
    const length = this.varint();
    if (this.pos + length > this.buf.length) throw new Error("truncated length-delimited field");
    const out = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  skip(wireType: number): void {
    switch (wireType) {
      case 0:
        this.varint();
        return;
      case 1:
        this.pos += 8;
        return;
      case 2:
        this.bytes();
        return;
      case 5:
        this.pos += 4;
        return;
      default:
        throw new Error(`unsupported wire type ${wireType}`);
    }
  }
}

function summarizeLayer(buf: Uint8Array): LayerSummary {
  const reader = new Reader(buf);
  const summary: LayerSummary = { name: "", version: 1, extent: 4096, features: 0, geometryTypes: {} };
  while (!reader.done) {
    const key = reader.varint();
    const field = key >>> 3;
    const wire = key & 7;
    if (field === 1 && wire === 2) {
      summary.name = new TextDecoder().decode(reader.bytes());
    } else if (field === 2 && wire === 2) {
      summary.features += 1;
      const type = featureGeometryType(reader.bytes());
      summary.geometryTypes[type] = (summary.geometryTypes[type] ?? 0) + 1;
    } else if (field === 5 && wire === 0) {
      summary.extent = reader.varint();
    } else if (field === 15 && wire === 0) {
      summary.version = reader.varint();
    } else {
      reader.skip(wire);
    }
  }
  return summary;
}

function featureGeometryType(buf: Uint8Array): string {
  const reader = new Reader(buf);
  let type = 0;
  while (!reader.done) {
    const key = reader.varint();
    const field = key >>> 3;
    const wire = key & 7;
    if (field === 3 && wire === 0) {
      type = reader.varint();
    } else {
      reader.skip(wire);
    }
  }
  return GEOMETRY_TYPES[type] ?? `type-${type}`;
}

/** Layers of an (uncompressed) vector tile. Throws on malformed input. */
export function summarizeTile(buf: Uint8Array): LayerSummary[] {
  const reader = new Reader(buf);
  const layers: LayerSummary[] = [];
  while (!reader.done) {
    const key = reader.varint();
    const field = key >>> 3;
    const wire = key & 7;
    if (field === 3 && wire === 2) {
      layers.push(summarizeLayer(reader.bytes()));
    } else {
      reader.skip(wire);
    }
  }
  return layers;
}

export function totalFeatures(layers: LayerSummary[]): number {
  return layers.reduce((sum, layer) => sum + layer.features, 0);
}
