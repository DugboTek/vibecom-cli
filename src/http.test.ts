import { cleanupSandbox } from "./testSandbox";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { ApiError, fetchWithDeadline } from "./core";

after(cleanupSandbox);

for (const stall of ["headers", "body"] as const) {
  test(`HTTP deadline terminates stalled ${stall} and closes the connection`, async () => {
    let closed = false;
    const server = createServer((req, res) => {
      req.on("close", () => { closed = true; });
      if (stall === "body") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"accepted":');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    try {
      await assert.rejects(
        fetchWithDeadline(`http://127.0.0.1:${address.port}`, {}, res => res.json(), 100),
        (error: unknown) => error instanceof ApiError && /timed out/.test(error.message)
      );
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(closed, true, "aborted requests must release server connections");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

test("HTTP deadline returns complete bodies and preserves caller cancellation", async () => {
  const server = createServer((_req, res) => res.end('{"accepted":12}'));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    assert.deepEqual(await fetchWithDeadline(url, {}, res => res.json(), 1000), { accepted: 12 });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(fetchWithDeadline(url, { signal: controller.signal }, res => res.json(), 1000));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
