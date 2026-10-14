import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

// Build the same protocol implementation used by the Worker for Node assertions.
const bundle = await build({
  entryPoints: ["src/protocol.ts"], bundle: true, write: false, format: "esm", platform: "node",
});
const { handshake, concat, packet, parseStatus, varInt } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
test("1.8.9 handshake includes ID and correct framing", () => {
  assert.equal(Buffer.from(handshake("play.simpfun.cn", 32101)).toString("hex"),
    "15002f0f706c61792e73696d7066756e2e636e7d6501");
});
test("status parser accepts every TCP fragmentation boundary", () => {
  const status = { version: { name: "1.8.9", protocol: 47 }, description: "测试".repeat(80) };
  const text = new TextEncoder().encode(JSON.stringify(status));
  const response = packet(concat(varInt(0), varInt(text.length), text));
  for (let end = 0; end < response.length; end++) {
    assert.equal(parseStatus(response.subarray(0, end)), undefined);
  }
  assert.deepEqual(parseStatus(response), status);
});
test("invalid IDs, lengths and oversized frames fail explicitly", () => {
  assert.throws(() => parseStatus(packet(Uint8Array.of(1, 0))), /packet ID/);
  assert.throws(() => parseStatus(packet(Uint8Array.of(0, 9, 123))), /JSON length/);
  assert.throws(() => parseStatus(varInt(256 * 1024 + 1)), /size limit/);
  assert.throws(() => parseStatus(Uint8Array.of(128,128,128,128,16)), /32 bits/);
});
