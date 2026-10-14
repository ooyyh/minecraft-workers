import { readVar } from "./bot-protocol";

export type TerrainChunk = {
  x: number;
  z: number;
  sections: Map<number, Uint16Array>;
  groundUp: boolean;
  // Kept as a compact 256-column summary for the admin API and fallback view.
  heights: number[];
  blocks: number[];
};

export function decodeBlockPosition(data: Uint8Array): { x: number; y: number; z: number } {
  if (data.length < 8) throw Error("Block position is incomplete");
  const packed = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(0);
  const signed26 = (value: number) => value >= 1 << 25 ? value - (1 << 26) : value;
  return { x: signed26(Number((packed >> 38n) & 0x3ffffffn)), y: Number((packed >> 26n) & 0xfffn), z: signed26(Number(packed & 0x3ffffffn)) };
}

function popcount(mask: number) { let count = 0; for (; mask; mask &= mask - 1) count++; return count; }

function terrain(x: number, z: number, mask: number, bytes: Uint8Array, skyLight: boolean, groundUp = true): TerrainChunk {
  const count = popcount(mask);
  if (bytes.length < count * (8192 + 2048 + (skyLight ? 2048 : 0))) throw Error("Chunk data is incomplete");
  const sections = new Map<number, Uint16Array>();
  let offset = 0;
  for (let section = 0; section < 16; section++) if (mask & (1 << section)) {
    const states = new Uint16Array(4096);
    for (let i = 0; i < states.length; i++) states[i] = bytes[offset + i * 2] | (bytes[offset + i * 2 + 1] << 8);
    sections.set(section, states);
    offset += 8192;
  }
  const heights = Array<number>(256).fill(-1), blocks = Array<number>(256).fill(0);
  for (let localZ = 0; localZ < 16; localZ++) for (let localX = 0; localX < 16; localX++) {
    const column = (localZ << 4) | localX;
    for (let section = 15; section >= 0; section--) {
      const states = sections.get(section);
      if (!states) continue;
      for (let y = 15; y >= 0; y--) {
        const state = states[(y << 8) | (localZ << 4) | localX] >> 4;
        if (state) { heights[column] = (section << 4) | y; blocks[column] = state; break; }
      }
      if (heights[column] >= 0) break;
    }
  }
  return { x, z, sections, groundUp, heights, blocks };
}

export function decodeChunk(data: Uint8Array, skyLight: boolean): TerrainChunk | null {
  if (data.length < 12) throw Error("Chunk header is incomplete");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const x = view.getInt32(0), z = view.getInt32(4), groundUp = data[8] !== 0, mask = view.getUint16(9), size = readVar(data, 11);
  if (!size || size.next + size.value > data.length) throw Error("Chunk payload is incomplete");
  if (!groundUp && !mask) return null;
  return terrain(x, z, mask, data.subarray(size.next, size.next + size.value), skyLight, groundUp);
}

export function decodeChunkBulk(data: Uint8Array, include: (x: number, z: number) => boolean = () => true): TerrainChunk[] {
  if (!data.length) throw Error("Bulk chunk header is incomplete");
  const skyLight = data[0] !== 0, count = readVar(data, 1);
  if (!count || count.value > 256 || count.next + count.value * 10 > data.length) throw Error("Bulk chunk metadata is invalid");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength), metadata: { x: number; z: number; mask: number }[] = [];
  let offset = count.next;
  for (let i = 0; i < count.value; i++, offset += 10) metadata.push({ x: view.getInt32(offset), z: view.getInt32(offset + 4), mask: view.getUint16(offset + 8) });
  const chunks: TerrainChunk[] = [];
  for (const item of metadata) {
    const size = popcount(item.mask) * (8192 + 2048 + (skyLight ? 2048 : 0)) + 256;
    if (offset + size > data.length) throw Error("Bulk chunk payload is incomplete");
    if (include(item.x, item.z)) chunks.push(terrain(item.x, item.z, item.mask, data.subarray(offset, offset + size), skyLight));
    offset += size;
  }
  return chunks;
}

export function blockState(chunks: Map<string, TerrainChunk>, x: number, y: number, z: number): number | null {
  if (y < 0 || y >= 256) return 0;
  const chunk = chunks.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`);
  if (!chunk) return null;
  return chunk.sections.get(Math.floor(y / 16))?.[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] ?? 0;
}

export function setBlock(chunks: Map<string, TerrainChunk>, x: number, y: number, z: number, state: number): boolean {
  const chunk = chunks.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`);
  if (!chunk || y < 0 || y >= 256) return false;
  const sy = y >> 4;
  let section = chunk.sections.get(sy);
  if (!section) { if (!state) return false; section = new Uint16Array(4096); chunk.sections.set(sy, section); }
  const index = ((y & 15) << 8) | ((z & 15) << 4) | (x & 15);
  if (section[index] === state) return false;
  section[index] = state;
  return true;
}
