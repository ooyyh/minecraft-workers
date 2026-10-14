import { connect } from "cloudflare:sockets";
import { DurableObject } from "cloudflare:workers";
import { concat, handshake, packet, parseStatus, MAX_PACKET_BYTES } from "./protocol";
import { DEFAULT_TARGET, serverTarget, type ServerTarget } from "./target";
import { runtimeChecks } from "./runtime";
import { MinecraftBot } from "./bot";
import { authenticated, login, cookie, CLEAR_COOKIE } from "./auth";
import { page } from "./page";
import { apiDocs } from "./docs";
import { worldViewScript } from "./world-view";
export { MinecraftBot };
export async function probe(target: ServerTarget = DEFAULT_TARGET) {
  const started = Date.now();
  let stage = "tcp";
  let tcpConnected = false;
  const socket = connect(target);
  void socket.closed.catch(() => undefined);
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Probe deadline exceeded (10 seconds)")), 10_000);
  });
  const work = async () => {
    const info = await socket.opened;
    tcpConnected = true;
    stage = "minecraftStatus";
    await writer.write(concat(handshake(target.hostname, target.port), packet(Uint8Array.of(0))));
    let buffer: Uint8Array = new Uint8Array(0);
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Server closed before a complete Minecraft status response");
      if (buffer.length + chunk.value.length > MAX_PACKET_BYTES + 5) throw new Error("Response exceeds size limit");
      buffer = concat(buffer, chunk.value);
      const status = parseStatus(buffer);
      if (status !== undefined) return { status, remoteAddress: info.remoteAddress };
    }
  };
  try {
    const result = await Promise.race([work(), deadline]);
    return { ok: true, target, tcpConnected, ...result, elapsedMs: Date.now() - started };
  } catch (error) {
    return { ok: false, target, tcpConnected, stage, error: error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
    await socket.close().catch(() => undefined);
    reader.releaseLock();
    writer.releaseLock();
  }
}
export class MinecraftProbe extends DurableObject<Env> {
  async status() { return probe(); }
  async capabilities() { return runtimeChecks(); }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    const headers = { "Cache-Control": "no-store" };
    if (path === "/" && request.method === "GET") return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8", ...headers, "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" } });
    if (path === "/docs" && request.method === "GET") return new Response(apiDocs, { headers: { "Content-Type": "text/html; charset=utf-8", ...headers } });
    if (path === "/world.js" && request.method === "GET") return new Response(worldViewScript, { headers: { "Content-Type": "text/javascript; charset=utf-8", ...headers, "X-Content-Type-Options": "nosniff" } });
    if (path === "/api/login" && request.method === "POST") {
      const body = await limitedJSON(request);
      if (!body || typeof body.username !== "string" || typeof body.password !== "string") return Response.json({ error: "登录参数不正确" }, { status: 400 });
      const token = await login(env, body.username, body.password);
      if (!token) return Response.json({ error: "管理员或密码错误" }, { status: 401 });
      return Response.json({ ok: true }, { headers: { ...headers, "Set-Cookie": cookie(token) } });
    }
    if (path.startsWith("/api/")) {
      if (request.method !== "GET") {
        const origin = request.headers.get("Origin");
        if (origin && origin !== new URL(request.url).origin) {
          return Response.json({ error: "跨站请求已拒绝" }, { status: 403, headers });
        }
      }
      if (!await authenticated(request, env)) return Response.json({ error: "请先登录" }, { status: 401, headers });
      if (path === "/api/logout" && request.method === "POST") return Response.json({ ok: true }, { headers: { ...headers, "Set-Cookie": CLEAR_COOKIE } });
      const bot = env.MC_BOT.getByName("simpfun-world-v3");
      try {
        if (path === "/api/config" && request.method === "GET") return Response.json(await bot.config(), { headers });
        if (path === "/api/config" && request.method === "POST") {
          const body = await limitedJSON(request);
          if (!body) return Response.json({ error: "配置参数无效" }, { status: 400, headers });
          return Response.json(await bot.setConfig(body), { headers });
        }
        if (path === "/api/bot" && request.method === "GET") return Response.json(await bot.status(), { headers });
        if (path === "/api/world" && request.method === "GET") return Response.json(await bot.world(), { headers });
        if (path === "/api/bot/start" && request.method === "POST") {
          const body = await limitedJSON(request);
          return Response.json(await bot.start(typeof body?.username === "string" ? body.username : "CodexBot"), { headers });
        }
        if (path === "/api/bot/stop" && request.method === "POST") return Response.json(await bot.stop(), { headers });
        if (path === "/api/bot/chat" && request.method === "POST") {
          const body = await limitedJSON(request);
          return Response.json(await bot.chat(body?.message as string), { headers });
        }
        if (path === "/api/bot/control" && request.method === "POST") {
          const body = await limitedJSON(request);
          if (!body) return Response.json({ error: "控制参数无效" }, { status: 400, headers });
          return Response.json(await bot.control(body), { headers });
        }
        if (path === "/api/server" && request.method === "GET") {
          const config = await bot.config();
          return Response.json(await probe(config.target), { headers });
        }
        if (path === "/api/server/probe" && request.method === "POST") {
          const body = await limitedJSON(request);
          if (!body) return Response.json({ error: "配置参数无效" }, { status: 400, headers });
          return Response.json(await probe(serverTarget(body)), { headers });
        }
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400, headers });
      }
      return Response.json({ error: "接口不存在或方法不正确" }, { status: 404, headers });
    }
    // Legacy probe endpoints are now protected because the Worker hosts an admin console.
    if (!await authenticated(request, env)) return Response.json({ error: "请先登录" }, { status: 401, headers });
    if (path === "/" || path === "/worker") {
      const target = await env.MC_BOT.getByName("simpfun-world-v3").config();
      const result = await probe(target.target);
      return Response.json({ location: "worker", ...result }, { status: result.ok ? 200 : 502, headers });
    }
    if (path === "/do") {
      const target = await env.MC_BOT.getByName("simpfun-world-v3").config();
      const result = await probe(target.target);
      return Response.json({ location: "durable-object", ...result }, { status: result.ok ? 200 : 502, headers });
    }
    if (path === "/runtime") return Response.json({ worker: runtimeChecks(), durableObject: await env.MC_PROBE.getByName("runtime").capabilities() }, { headers });
    return new Response("Use /worker, /do, or /runtime", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function limitedJSON(request: Request): Promise<Record<string, unknown> | null> {
  if (Number(request.headers.get("Content-Length") ?? 0) > 1024) return null;
  const text = await request.text();
  if (text.length > 1024) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
