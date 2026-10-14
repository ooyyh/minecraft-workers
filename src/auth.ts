import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

const encoder = new TextEncoder();
const TTL = 12 * 60 * 60;

function secret(env: Env): string {
  if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 20) throw Error("ADMIN_PASSWORD secret must be at least 20 characters");
  return env.ADMIN_PASSWORD;
}
function toHex(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("hex");
}
async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}
async function equals(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  return timingSafeEqual(Buffer.from(x), Buffer.from(y));
}
async function sign(env: Env, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}
export async function login(env: Env, username: string, password: string): Promise<string | null> {
  const validPassword = await equals(password, secret(env));
  if (username !== "admin" || !validPassword) return null;
  const payload = String(Math.floor(Date.now() / 1000 + TTL));
  return `${payload}.${await sign(env, payload)}`;
}
export async function authenticated(request: Request, env: Env): Promise<boolean> {
  const auth = request.headers.get("Authorization");
  if (auth?.startsWith("Basic ")) {
    try {
      const pair = Buffer.from(auth.slice(6), "base64").toString("utf8");
      const colon = pair.indexOf(":");
      if (colon >= 0) return !!(await login(env, pair.slice(0, colon), pair.slice(colon + 1)));
    } catch { return false; }
  }
  const cookie = request.headers.get("Cookie")?.split(";").map(item => item.trim()).find(item => item.startsWith("mc_session="))?.slice(11);
  if (!cookie) return false;
  const dot = cookie.indexOf(".");
  if (dot < 1) return false;
  const expiry = cookie.slice(0, dot);
  if (!/^\d{10}$/.test(expiry) || Number(expiry) <= Date.now() / 1000) return false;
  return equals(cookie.slice(dot + 1), await sign(env, expiry));
}
export function cookie(token: string): string {
  return `mc_session=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${TTL}`;
}
export const CLEAR_COOKIE = "mc_session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0";
