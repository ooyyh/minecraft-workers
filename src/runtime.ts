import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, generateKeyPairSync, publicEncrypt, constants } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
export function runtimeChecks() {
  const tests: Record<string, { ok: boolean; detail: string }> = {};
  function check(name: string, fn: () => string) {
    try { tests[name] = { ok: true, detail: fn() }; }
    catch (error) { tests[name] = { ok: false, detail: error instanceof Error ? error.message : String(error) }; }
  }
  check("aes128Cfb8", () => {
    const plain = Buffer.from("minecraft-workers-probe");
    const cipher = createCipheriv("aes-128-cfb8", Buffer.alloc(16), Buffer.alloc(16));
    const encrypted = Buffer.concat([cipher.update(plain.subarray(0, 7)), cipher.update(plain.subarray(7)), cipher.final()]);
    if (encrypted.toString("hex") !== "0b7a0788a1479ecaaab38b5ee34f0a6daa3bf7a53794a1") throw new Error("Ciphertext differs from Node.js reference vector");
    const decipher = createDecipheriv("aes-128-cfb8", Buffer.alloc(16), Buffer.alloc(16));
    const decoded = Buffer.concat([decipher.update(encrypted.subarray(0, 9)), decipher.update(encrypted.subarray(9)), decipher.final()]);
    if (!decoded.equals(plain)) throw new Error("Decrypt mismatch");
    return "Matches Node.js vector; encrypt/decrypt retain state across chunks";
  });
  check("zlib", () => {
    const plain = Buffer.from("Minecraft zlib packet".repeat(64));
    if (!inflateSync(deflateSync(plain)).equals(plain)) throw new Error("zlib roundtrip mismatch");
    return "deflateSync/inflateSync roundtrip passed";
  });
  check("rsaPkcs1Encryption", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const pem = publicKey.export({ type: "spki", format: "pem" });
    const encrypted = publicEncrypt({ key: pem, padding: constants.RSA_PKCS1_PADDING }, Buffer.alloc(16));
    if (encrypted.length !== 128) throw new Error("RSA ciphertext length mismatch");
    return "RSA publicEncrypt with PKCS#1 v1.5 passed";
  });
  return tests;
}
