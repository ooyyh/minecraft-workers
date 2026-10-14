import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { inflateSync } from "node:zlib";

const bundle = await build({
  entryPoints: ["src/bot-protocol.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { FrameDecoder, encodePlay, loginHandshake, readVar } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
function bodyOf(frame) {
  const length = readVar(frame);
  return frame.subarray(length.next, length.next + length.value);
}

test("offline login sends 1.8.9 handshake and username", () => {
  const wire = loginHandshake("play.simpfun.cn", 32101, "CodexBot");
  const first = readVar(wire);
  assert.equal(Buffer.from(wire.subarray(first.next, first.next + first.value)).toString("hex"),
    "002f0f706c61792e73696d7066756e2e636e7d6502");
  assert.equal(Buffer.from(wire.subarray(first.next + first.value)).toString("hex"),
    "0a0008436f646578426f74");
});

test("decoder handles a compression switch within one TCP chunk", () => {
  const decoder = new FrameDecoder();
  const compression = Uint8Array.of(3, 3, 0x80, 2);
  const success = encodePlay(2, Uint8Array.of(0), 256);
  const chunk = Buffer.concat([compression, success]);
  decoder.push(chunk.subarray(0, 2));
  assert.equal(decoder.next(-1), undefined);
  decoder.push(chunk.subarray(2));
  const first = decoder.next(-1);
  assert.equal(first.id, 3);
  assert.deepEqual(Array.from(first.data), [0x80, 2]);
  const second = decoder.next(256);
  assert.equal(second.id, 2);
  assert.deepEqual(Array.from(second.data), [0]);
  assert.equal(decoder.next(256), undefined);
});

test("outgoing frames compress at threshold, and keepalive payload survives", () => {
  const keepAlive = Uint8Array.of(0x80, 0x01);
  const frame = encodePlay(0, keepAlive, 256);
  assert.deepEqual(Array.from(bodyOf(frame)), [0, 0, 0x80, 1]);
  const large = encodePlay(1, new Uint8Array(300), 256);
  const body = bodyOf(large);
  const length = readVar(body);
  assert.equal(length.value, 301);
  assert.equal(inflateSync(body.subarray(length.next)).length, 301);
});
