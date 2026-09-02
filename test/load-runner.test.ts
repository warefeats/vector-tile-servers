import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fetchTile, waitForTile } from "../src/load-runner";

let server: ReturnType<typeof Bun.serve>;
const seen: Record<string, string>[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      seen.push(Object.fromEntries(req.headers));
      const url = new URL(req.url);
      if (url.pathname === "/missing") return new Response("no", { status: 404 });
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/x-protobuf" } });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

describe("tile fetch", () => {
  test("sends the MVT Accept header and no Accept-Encoding by default", async () => {
    const result = await fetchTile(`http://127.0.0.1:${server.port}/tile`);
    expect(result.status).toBe(200);
    expect(result.bytes).toBe(3);
    expect(result.contentType).toBe("application/x-protobuf");
    expect(result.contentEncoding).toBeNull();
    const headers = seen[seen.length - 1]!;
    expect(headers["accept"]).toBe("application/vnd.mapbox-vector-tile");
    expect(headers["accept-encoding"]).toBeUndefined();
  });

  test("passes extra headers through", async () => {
    await fetchTile(`http://127.0.0.1:${server.port}/tile`, { headers: { "Accept-Encoding": "gzip" } });
    expect(seen[seen.length - 1]!["accept-encoding"]).toBe("gzip");
  });

  test("waits for a 200 and gives up on a 404 within the deadline", async () => {
    const before = Date.now();
    const at = await waitForTile(`http://127.0.0.1:${server.port}/tile`, 2_000);
    expect(at).toBeGreaterThanOrEqual(before);
    await expect(waitForTile(`http://127.0.0.1:${server.port}/missing`, 300)).rejects.toThrow(/no 200/);
  });
});
