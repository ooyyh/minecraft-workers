export const MAX_PACKET_BYTES = 256 * 1024;
export function varInt(value: number): Uint8Array {
  const bytes: number[] = [];
  let current = value >>> 0;
  do {
    let byte = current & 0x7f;
    current >>>= 7;
    if (current !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (current !== 0);
  return Uint8Array.from(bytes);
}
export function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
export function packet(payload: Uint8Array): Uint8Array {
  return concat(varInt(payload.length), payload);
}
export function handshake(hostname: string, port: number, protocol = 47): Uint8Array {
  const host = new TextEncoder().encode(hostname);
  return packet(concat(
    varInt(0), // Handshake packet ID precedes protocol version.
    varInt(protocol), varInt(host.length), host,
    Uint8Array.of(port >>> 8, port & 0xff), varInt(1),
  ));
}
function readVarInt(buffer: Uint8Array, offset: number) {
  let value = 0;
  for (let index = 0; index < 5; index++) {
    if (offset + index >= buffer.length) return undefined;
    const byte = buffer[offset + index];
    if (index === 4 && (byte & 0xf0) !== 0) throw new Error("VarInt exceeds 32 bits");
    value |= (byte & 0x7f) << (index * 7);
    if ((byte & 0x80) === 0) return { value: value >>> 0, next: offset + index + 1 };
  }
  throw new Error("VarInt exceeds five bytes");
}
// Undefined means incomplete TCP fragments; invalid complete frames throw.
export function parseStatus(buffer: Uint8Array): unknown | undefined {
  const length = readVarInt(buffer, 0);
  if (!length) return undefined;
  if (length.value > MAX_PACKET_BYTES) throw new Error("Status frame exceeds size limit");
  const end = length.next + length.value;
  if (buffer.length < end) return undefined;
  const frame = buffer.subarray(length.next, end);
  const id = readVarInt(frame, 0);
  if (!id || id.value !== 0) throw new Error("Unexpected status packet ID");
  const jsonLength = readVarInt(frame, id.next);
  if (!jsonLength || jsonLength.next + jsonLength.value !== frame.length) throw new Error("Invalid status JSON length");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(jsonLength.next)));
}
