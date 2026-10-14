import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundled = await build({ entryPoints: ["src/world.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { decodeChunk, decodeChunkBulk } = await import("data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64"));

function section(blockId) {
  const bytes = Buffer.alloc(8192 + 2048 + 2048 + 256);
  for (let i = 0; i < 4096; i++) bytes.writeUInt16LE(blockId << 4, i * 2);
  return bytes;
}

test("1.8.9 single and bulk chunk packets produce correct surface blocks", () => {
  const data = section(2);
  const single = Buffer.alloc(12);
  single.writeInt32BE(14, 0); single.writeInt32BE(18, 4);
  single[8] = 1; single.writeUInt16BE(1, 9); single[11] = 0x80;
  const chunk = decodeChunk(Buffer.concat([single, Buffer.from([0x62]), data]), true);
  assert.equal(chunk.x, 14); assert.equal(chunk.z, 18);
  assert.equal(chunk.heights[0], 15); assert.equal(chunk.blocks[255], 2);

  const metadata = Buffer.alloc(10);
  metadata.writeInt32BE(14, 0); metadata.writeInt32BE(18, 4); metadata.writeUInt16BE(1, 8);
  const bulk = decodeChunkBulk(Buffer.concat([Buffer.from([1, 1]), metadata, data]));
  assert.deepEqual(bulk[0], chunk);
});
