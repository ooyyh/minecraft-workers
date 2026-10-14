import { deflateSync, inflateSync } from "node:zlib";
import { concat, packet, varInt } from "./protocol";

const MAX_FRAME = 4 * 1024 * 1024;
export function readVar(buf: Uint8Array, offset = 0): { value: number; next: number } | undefined {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buf.length) return undefined;
    const byte = buf[offset + i];
    if (i === 4 && (byte & 0xf0)) throw Error("Invalid VarInt");
    value |= (byte & 127) << (i * 7);
    if (!(byte & 128)) return { value: value >>> 0, next: offset + i + 1 };
  }
  throw Error("Invalid VarInt length");
}
export function stringField(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  return concat(varInt(bytes.length), bytes);
}
export function decodeString(buf: Uint8Array, offset = 0): { value: string; next: number } {
  const head = readVar(buf, offset);
  if (!head || head.value > 32767 || head.next + head.value > buf.length) throw Error("Invalid string field");
  return { value: new TextDecoder().decode(buf.subarray(head.next, head.next + head.value)), next: head.next + head.value };
}
export function loginHandshake(host: string, port: number, username: string) {
  const login = packet(concat(varInt(0), stringField(username)));
  const address = stringField(host);
  const hello = packet(concat(varInt(0), varInt(47), address, Uint8Array.of(port >>> 8, port & 255), varInt(2)));
  return concat(hello, login);
}
export function encodePlay(id: number, data: Uint8Array, threshold: number): Uint8Array {
  const body = concat(varInt(id), data);
  if (threshold < 0) return packet(body);
  if (body.length < threshold) return packet(concat(varInt(0), body));
  return packet(concat(varInt(body.length), deflateSync(body)));
}
export class FrameDecoder {
  private buffered: Uint8Array = new Uint8Array(0);
  push(chunk: Uint8Array): void {
    if (this.buffered.length + chunk.length > MAX_FRAME + 5) throw Error("Frame buffer limit reached");
    this.buffered = concat(this.buffered, chunk);
  }
  next(threshold: number): { id: number; data: Uint8Array } | undefined {
      const length = readVar(this.buffered);
      if (!length) return undefined;
      if (!length.value || length.value > MAX_FRAME) throw Error("Invalid frame size");
      if (this.buffered.length < length.next + length.value) return undefined;
      let body: Uint8Array = this.buffered.slice(length.next, length.next + length.value);
      this.buffered = this.buffered.slice(length.next + length.value);
      if (threshold >= 0) {
        const rawLength = readVar(body);
        if (!rawLength) throw Error("Missing compression header");
        const compressed = body.subarray(rawLength.next);
        if (rawLength.value) {
          if (rawLength.value > MAX_FRAME || rawLength.value < threshold) throw Error("Invalid decompressed size");
          const inflated = inflateSync(compressed, { maxOutputLength: MAX_FRAME });
          if (inflated.length !== rawLength.value) throw Error("Decompressed length mismatch");
          body = inflated;
        } else {
          if (compressed.length >= threshold) throw Error("Uncompressed packet above threshold");
          body = compressed;
        }
      }
      const id = readVar(body);
      if (!id) throw Error("Missing packet ID");
      return { id: id.value, data: body.slice(id.next) };
  }
}
